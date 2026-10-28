//! A transfer is staged before one durable activation makes it executable.
use super::{Error, Manager, Receipt, Result};
use crate::{runtime, workspace};
use axum::body::{Body, Bytes};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub kind: String,
    #[serde(default)]
    pub executable: bool,
    #[serde(default)]
    pub symlink: bool,
    pub origin: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged, deny_unknown_fields)]
pub enum QueuedPrompt {
    Text(String),
    Input {
        text: String,
        reasoning: Option<String>,
        service_tier: Option<String>,
    },
}
impl QueuedPrompt {
    fn input(&self) -> Value {
        match self {
            Self::Text(text) => json!({"text":text}),
            Self::Input {
                text,
                reasoning,
                service_tier,
            } => {
                let mut input = json!({"text":text});
                if let Some(reasoning) = reasoning {
                    input["reasoning"] = json!(reasoning);
                }
                if let Some(tier) = service_tier {
                    input["service_tier"] = json!(tier);
                }
                input
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub request_id: String,
    pub harness: runtime::Kind,
    pub native_id: String,
    pub model: String,
    pub provider: Option<String>,
    pub reasoning: Option<String>,
    pub service_tier: Option<String>,
    pub command_guard_enabled: Option<bool>,
    #[serde(default)]
    pub strip_ai_co_authors: Option<bool>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    pub workspace: String,
    pub workspace_name: String,
    pub files: Vec<Entry>,
    pub handoff: String,
    #[serde(default)]
    pub queued: Vec<QueuedPrompt>,
    /// A fork copies another Cloud thread's conversation: it starts idle, with no handoff turn,
    /// and its first message arrives as a rewind that gives it its own native identity.
    #[serde(default)]
    pub fork: bool,
}

/// What Teleport will run in the cloud: the source thread's exact harness, model and effort.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Check {
    pub harness: runtime::Kind,
    pub model: String,
    pub reasoning: Option<String>,
    pub service_tier: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Transfer {
    manifest: Manifest,
    workspace: workspace::Workspace,
    #[serde(default)]
    files: BTreeMap<usize, String>,
    #[serde(default)]
    cancelled: bool,
    #[serde(default)]
    digests: BTreeMap<usize, String>,
    #[serde(default)]
    sizes: BTreeMap<usize, u64>,
}

#[derive(Default)]
pub(super) struct Transfers {
    locks: std::sync::Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
}
impl Transfers {
    /// A transfer is mid-request, so the machine must not stop now.
    pub(super) fn busy(&self) -> bool {
        self.locks
            .lock()
            .unwrap()
            .values()
            .any(|lock| lock.try_lock().is_err())
    }
    fn lock(&self, id: &str) -> Arc<Mutex<()>> {
        self.locks
            .lock()
            .unwrap()
            .entry(id.into())
            .or_default()
            .clone()
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn validate(manifest: &Manifest) -> Result<()> {
    if !valid_id(&manifest.request_id)
        || !valid_id(&manifest.native_id)
        || manifest.model.is_empty()
        || manifest.model.len() > 256
        || manifest
            .provider
            .as_ref()
            .is_some_and(|p| p.is_empty() || p.len() > 256)
        || manifest.handoff.is_empty() != manifest.fork
        || manifest.handoff.len() > 32768
        || manifest
            .system_prompt
            .as_ref()
            .is_some_and(|p| p.trim().is_empty() || p.len() > 32768 || p.contains('\0'))
        || manifest.queued.iter().any(|prompt| {
            prompt.input()["text"]
                .as_str()
                .is_none_or(|text| text.is_empty() || text.len() > super::MAX_PROMPT)
        })
        || manifest
            .files
            .iter()
            .filter(|entry| entry.kind == "native")
            .count()
            != 1
    {
        return Err(Error::Conflict("invalid teleport manifest"));
    }
    let mut paths = std::collections::BTreeSet::new();
    for entry in &manifest.files {
        if (entry.symlink && entry.kind != "project")
            || !matches!(
                entry.kind.as_str(),
                "native" | "lineage" | "context" | "project" | "attachment"
            )
            // A Codex fork's parent conversation files, installed byte-for-byte beside it.
            || (entry.kind == "lineage"
                && (manifest.harness != runtime::Kind::Codex
                    || entry.path.contains('/')
                    || !entry.path.starts_with("rollout-")
                    || !entry.path.ends_with(".jsonl")))
            || entry.size > 4 * 1024 * 1024 * 1024
            || (!(entry.sha256.is_empty()
                && matches!(entry.kind.as_str(), "project" | "attachment"))
                && (entry.sha256.len() != 64
                    || !entry.sha256.bytes().all(|c| c.is_ascii_hexdigit())))
            || entry
                .origin
                .as_ref()
                .is_some_and(|value| value.len() > 4096)
            || entry.path.is_empty()
            || entry.path.contains(['\\', '\0'])
            || entry
                .path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || !paths.insert((&entry.kind, &entry.path))
        {
            return Err(Error::Conflict("invalid teleport file"));
        }
    }
    Ok(())
}

/// A closed session gave its conversation back (Teleport to Local).
fn native_in_use(local: &super::Local, native_id: &str) -> bool {
    local.sessions.values().any(|s| {
        s.native_id.as_deref() == Some(native_id)
            && s.state != "closed"
            && s.close_request.is_none()
    })
}

impl Manager {
    fn transfer_directory(&self, id: &str) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err(Error::Conflict("invalid transfer ID"));
        }
        Ok(self.config.state_dir.join("teleports").join(id))
    }

    fn transfer_read(&self, id: &str) -> Result<Transfer> {
        let bytes = fs::read(self.transfer_directory(id)?.join("manifest.json")).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::NotFound
            } else {
                Error::Storage(format!("transfer manifest unreadable: {e}"))
            }
        })?;
        serde_json::from_slice(&bytes)
            .map_err(|e| Error::Storage(format!("transfer manifest is invalid JSON: {e}")))
    }

    fn transfer_save(&self, transfer: &Transfer) -> Result<()> {
        let directory = self.transfer_directory(&transfer.manifest.request_id)?;
        fs::create_dir_all(&directory)?;
        let temporary = directory.join("manifest.tmp");
        let mut file = File::create(&temporary)?;
        file.write_all(&serde_json::to_vec(transfer).map_err(std::io::Error::other)?)?;
        file.sync_all()?;
        fs::rename(temporary, directory.join("manifest.json"))?;
        File::open(directory)?.sync_all()?;
        Ok(())
    }

    fn transfer_session(id: &str) -> String {
        format!("cr_teleport_{id}")
    }

    fn transfer_view(&self, transfer: &Transfer) -> Result<Value> {
        let id = &transfer.manifest.request_id;
        let session_id = Self::transfer_session(id);
        let local = self.local.lock().unwrap();
        let session = local.sessions.get(&session_id);
        let started = session.is_some();
        let output = session.is_some_and(|s| s.teleport_output);
        let needs_notice = transfer
            .manifest
            .files
            .iter()
            .any(|entry| matches!(entry.kind.as_str(), "project" | "attachment"));
        let announced = !needs_notice
            || session.is_some_and(|s| s.receipts.contains_key(&format!("teleport_ready_{id}")));
        let complete =
            started && output && announced && transfer.files.len() == transfer.manifest.files.len();
        let error = session.and_then(|s| {
            s.startup_error.as_deref().or_else(|| {
                if output {
                    None
                } else if s.queue_paused {
                    Some("paused_before_output")
                } else if matches!(s.state.as_str(), "closed" | "process_lost" | "failed") {
                    Some("cloud_process_unavailable")
                } else if s.ready && s.current_request.is_none() && s.queue.is_empty() {
                    Some("no_cloud_output")
                } else {
                    None
                }
            })
        });
        // The exact cause behind `error`, so the app never has to guess (ADR 0123).
        let detail = session.and_then(|s| {
            s.startup_reason.clone().or_else(|| {
                let handoff = s.receipts.get(&format!("teleport_{id}_0"))?;
                (handoff.state == "failed").then(|| {
                    handoff.error.clone().unwrap_or_else(|| {
                        "the handoff turn failed without an error message".into()
                    })
                })
            })
        });
        let directory = self.transfer_directory(id)?;
        let files: Vec<_> = transfer
            .manifest
            .files
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let path = transfer.files.get(&index);
                let offset = if path.is_some() {
                    transfer.sizes.get(&index).copied().unwrap_or(entry.size)
                } else {
                    fs::metadata(directory.join(format!("{index}.part")))
                        .map(|m| m.len())
                        .unwrap_or(0)
                };
                json!({"index":index,"offset":offset,"complete":path.is_some(),"path":path})
            })
            .collect();
        Ok(
            json!({"request_id":id,"session_id":started.then_some(session_id),
            "phase":if complete {"complete"} else if started {"running"} else if transfer.cancelled {"cancelled"} else {"uploading"},
            "output_started":output,"files":files,
            "error":error,"error_detail":detail,"workspace":transfer.workspace.path}),
        )
    }

    /// Answers "can the cloud continue this exact thread?" before the Mac stops anything.
    /// Uses the same account and model rules as new sessions, plus one real request.
    pub async fn teleport_check(self: &Arc<Self>, check: Check) -> Value {
        let fail = |code: &str, error: String, models: Option<&[runtime::Model]>| json!({"ok":false,"code":code,"error":error,"models":models});
        let harness = json!(check.harness);
        let harness = harness.as_str().unwrap_or("agent");
        if !self.config.harnesses.contains_key(&check.harness) {
            let error = format!("{harness} is not set up on this VM");
            return fail("harness_not_configured", error, None);
        }
        if let Err(error) = self.harness_ready(check.harness).await {
            return fail("login_required", error.message(), None);
        }
        if check.service_tier.as_deref() == Some("fast") && !check.harness.fast() {
            let error = format!("Cloud {harness} has no Fast mode; turn Fast off, then Teleport");
            return fail("setting_unavailable", error, None);
        }
        let reasoning = check.reasoning.as_deref();
        if matches!(check.harness, runtime::Kind::Codex | runtime::Kind::Claude) {
            let models = match self.model_catalog(check.harness).await {
                Ok(models) => models,
                Err(error) => return fail("models_unavailable", error.message(), None),
            };
            let supported = match reasoning {
                Some(reasoning) => {
                    runtime::supports(check.harness, &models, &check.model, reasoning)
                }
                None if runtime::reasoning_levels(check.harness, &models, &check.model)
                    .is_some() =>
                {
                    Ok(())
                }
                None => Err(format!("model {} is not offered on this VM", check.model)),
            };
            if let Err(error) = supported {
                return fail(
                    "model_unavailable",
                    format!("Cloud {harness}: {error}"),
                    Some(&models),
                );
            }
        } else if let Some(reasoning) = reasoning
            && !match check.harness {
                runtime::Kind::Pi => runtime::pi_reasoning_accepted(reasoning),
                _ => runtime::PI_REASONING_LEVELS.contains(&reasoning),
            }
        {
            let error = format!("Cloud {harness} does not support {reasoning} effort");
            return fail("model_unavailable", error, None);
        }
        match runtime::probe(&self.config, check.harness, &check.model, reasoning).await {
            Ok(()) => json!({"ok":true}),
            Err(error) => fail("probe_failed", format!("Cloud {harness}: {error}"), None),
        }
    }

    pub async fn teleport_prepare(self: &Arc<Self>, manifest: Manifest) -> Result<Value> {
        validate(&manifest)?;
        let lock = self.teleports.lock(&manifest.request_id);
        let _guard = lock.lock().await;
        match self.transfer_read(&manifest.request_id) {
            Ok(saved) => {
                if saved.manifest != manifest {
                    return Err(Error::Conflict("request_id already has different content"));
                }
                return self.transfer_view(&saved);
            }
            Err(Error::NotFound) => {}
            Err(error) => return Err(error),
        }
        if self.is_stopping() || !self.recording_available() {
            return Err(Error::Storage(
                "service is stopping or the session journal is not writable".into(),
            ));
        }
        if self.local.lock().unwrap().draining {
            return Err(Error::Conflict("service is draining"));
        }
        if !self.config.harnesses.contains_key(&manifest.harness) {
            return Err(Error::Conflict("harness is not configured"));
        }
        if manifest.harness == runtime::Kind::Codex && manifest.provider.is_some() {
            return Err(Error::Conflict("provider selection requires Pi"));
        }
        if self.storage.blocks() {
            return Err(Error::Conflict("storage unsafe; new execution is blocked"));
        }
        // A missing local transfer index must never recreate externally saved execution.
        if self
            .history
            .summary(&Self::transfer_session(&manifest.request_id), None)
            .await
            .map_err(|e| Error::Storage(format!("saved history: {e}")))?
            .0
            .is_some()
        {
            return Err(Error::Conflict("saved transfer requires recovery"));
        }
        let settings = std::iter::once(
            json!({"reasoning":manifest.reasoning,"service_tier":manifest.service_tier}),
        )
        .chain(manifest.queued.iter().map(QueuedPrompt::input));
        let models = if manifest.harness == runtime::Kind::Codex {
            Some(self.codex_models().await?)
        } else {
            None
        };
        let codex_model = models
            .as_ref()
            .map(|models| {
                models
                    .iter()
                    .find(|model| model.model == manifest.model)
                    .ok_or(Error::Conflict("invalid model"))
            })
            .transpose()?;
        for input in settings {
            // Claude and Cursor validate reasoning in their own runtimes.
            if let Some(reasoning) = input["reasoning"].as_str()
                && matches!(manifest.harness, runtime::Kind::Codex | runtime::Kind::Pi)
            {
                let valid = codex_model.map_or_else(
                    || runtime::pi_reasoning_accepted(reasoning),
                    |model| {
                        model
                            .reasoning_levels
                            .iter()
                            .any(|level| level == reasoning)
                    },
                );
                if !valid {
                    return Err(Error::Conflict("invalid reasoning effort"));
                }
            }
            if let Some(tier) = input["service_tier"].as_str()
                && (tier != "default" && !(tier == "fast" && manifest.harness.fast()))
            {
                return Err(Error::Conflict("invalid service tier"));
            }
        }
        // A projectless thread (a fork of one) runs in the workspaces root, unregistered like its start.
        let workspace = if manifest.workspace == workspace::ROOT {
            workspace::Workspace {
                id: "legacy".into(),
                path: self.workspaces.root().to_path_buf(),
                parent: None,
            }
        } else {
            self.workspaces
                .resolve(&manifest.workspace, Some(&manifest.workspace_name))?
        };
        self.workspaces.ensure_directory(&workspace).await?;
        let transfer = Transfer {
            manifest,
            workspace,
            files: BTreeMap::new(),
            cancelled: false,
            digests: BTreeMap::new(),
            sizes: BTreeMap::new(),
        };
        self.transfer_save(&transfer)?;
        self.transfer_view(&transfer)
    }

    pub async fn teleport_status(&self, id: &str) -> Result<Value> {
        self.transfer_directory(id)?;
        let lock = self.teleports.lock(id);
        let _guard = lock.lock().await;
        self.transfer_view(&self.transfer_read(id)?)
    }

    pub async fn teleport_upload(
        self: &Arc<Self>,
        id: &str,
        index: usize,
        offset: u64,
        sha256: String,
        size: Option<u64>,
        bytes: Bytes,
    ) -> Result<Value> {
        self.transfer_directory(id)?;
        let lock = self.teleports.lock(id);
        let _guard = lock.lock().await;
        let mut transfer = self.transfer_read(id)?;
        if transfer.cancelled {
            return Err(Error::Conflict("transfer cancelled"));
        }
        if self.storage.blocks() || !self.recording_available() {
            return Err(Error::Storage(
                "disk protection is blocking writes or the session journal is not writable".into(),
            ));
        }
        let mut entry = transfer
            .manifest
            .files
            .get(index)
            .ok_or(Error::NotFound)?
            .clone();
        if sha256.len() != 64
            || !sha256.bytes().all(|c| c.is_ascii_hexdigit())
            || (!entry.sha256.is_empty() && entry.sha256 != sha256)
            || transfer
                .digests
                .get(&index)
                .is_some_and(|saved| saved != &sha256)
        {
            return Err(Error::Conflict("upload checksum changed"));
        }
        let size = size.unwrap_or(entry.size);
        if size > 4 * 1024 * 1024 * 1024
            || (!entry.sha256.is_empty() && size != entry.size)
            || transfer
                .sizes
                .get(&index)
                .is_some_and(|saved| *saved != size)
        {
            return Err(Error::Conflict("invalid upload offset"));
        }
        entry.size = size;
        entry.sha256 = sha256.clone();
        if let std::collections::btree_map::Entry::Vacant(entry) = transfer.digests.entry(index) {
            entry.insert(sha256);
            transfer.sizes.insert(index, size);
            self.transfer_save(&transfer)?;
        }
        if transfer.files.contains_key(&index) {
            self.teleport_files_ready(&transfer)?;
            return self.transfer_view(&transfer);
        }
        let path = self.transfer_directory(id)?.join(format!("{index}.part"));
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)?;
        let length = file.metadata()?.len();
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or(Error::Conflict("invalid upload offset"))?;
        if end > entry.size || offset > length {
            return Err(Error::Conflict("invalid upload offset"));
        }
        file.seek(SeekFrom::Start(offset))?;
        if offset < length {
            if end > length {
                return Err(Error::Conflict("overlapping upload"));
            }
            let mut previous = vec![0; bytes.len()];
            file.read_exact(&mut previous)?;
            if previous != bytes {
                return Err(Error::Conflict("upload content changed"));
            }
        } else {
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        if file.metadata()?.len() == entry.size {
            // Installing replaces the VM's older copy of this conversation.
            if entry.kind == "native"
                && native_in_use(&self.local.lock().unwrap(), &transfer.manifest.native_id)
            {
                return Err(Error::Conflict(
                    "native conversation already belongs to a cloud session",
                ));
            }
            let native = if matches!(entry.kind.as_str(), "native" | "lineage") {
                Some((
                    self.config
                        .harnesses
                        .get(&transfer.manifest.harness)
                        .ok_or(Error::Conflict("harness is not configured"))?,
                    transfer.manifest.harness,
                    transfer.manifest.native_id.as_str(),
                ))
            } else {
                None
            };
            let written = self
                .workspaces
                .install_transfer(
                    &transfer.workspace,
                    id,
                    &entry,
                    &path,
                    native,
                    &self.storage,
                )
                .await
                .map_err(|error| {
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::StorageFull | std::io::ErrorKind::WouldBlock
                    ) {
                        Error::Storage(format!("teleport upload could not be stored: {error}"))
                    } else {
                        Error::Conflict("teleport file validation failed")
                    }
                })?;
            let written = match native {
                Some((profile, runtime::Kind::OpenCode, _)) => runtime::import_opencode(
                    &self.config,
                    profile,
                    &written,
                    &transfer.workspace.path,
                    &self.storage,
                )
                .await
                .map_err(|_| Error::Conflict("OpenCode session import failed"))?,
                _ => written,
            };
            transfer.files.insert(index, written);
            self.transfer_save(&transfer)?;
        }
        self.teleport_files_ready(&transfer)?;
        self.transfer_view(&transfer)
    }

    fn teleport_files_ready(self: &Arc<Self>, transfer: &Transfer) -> Result<()> {
        let id = &transfer.manifest.request_id;
        let session_id = Self::transfer_session(id);
        if transfer.files.len() == transfer.manifest.files.len()
            && transfer
                .manifest
                .files
                .iter()
                .any(|entry| matches!(entry.kind.as_str(), "project" | "attachment"))
            && self
                .local
                .lock()
                .unwrap()
                .sessions
                .contains_key(&session_id)
        {
            let mut local = self.local.lock().unwrap();
            let request = format!("teleport_ready_{id}");
            let session = &local.sessions[&session_id];
            if session.receipts.contains_key(&request) {
                return Ok(());
            }
            if session.close_request.is_some() || session.state == "closed" {
                return Err(Error::Conflict("cloud session is closed"));
            }
            let receipt = Receipt {
                request_id: request,
                command: "prompt".into(),
                state: "accepted".into(),
                model: None,
                provider: None,
                workspace: None,
                error: None,
                input: json!({"text":"[Teleport upload update] All handoff files and attachments have arrived at the locations listed in your handoff. Conflicting cloud files were preserved; incoming versions remain in the transfer folder. Continue any task that was waiting for these files. Do not repeat completed work or uncertain tool actions.","teleport_handoff":true,"reasoning":transfer.manifest.reasoning,"service_tier":transfer.manifest.service_tier}),
            };
            // Queue the context update durably, even while Stop or the storage guard
            // is pausing execution. The normal dispatcher decides when it can run.
            local.append(
                &session_id,
                "receipt",
                serde_json::to_value(receipt).map_err(std::io::Error::other)?,
                None,
            )?;
            self.advance(&mut local, &session_id, false);
        }
        Ok(())
    }

    fn teleport_retry(self: &Arc<Self>, transfer: &Transfer, request: &str) -> Result<()> {
        let id = &transfer.manifest.request_id;
        let session_id = Self::transfer_session(id);
        let resume_id = format!("teleport_resume_{request}");
        let prompt_id = format!("teleport_retry_{request}");
        let (resume, mut input) = {
            let local = self.local.lock().unwrap();
            let session = &local.sessions[&session_id];
            let resume = session.queue_paused
                || session.startup_error.is_some()
                || session.receipts.contains_key(&resume_id);
            // After output, the handoff is done: Retry only revives a lost process.
            if session.teleport_output {
                drop(local);
                if resume {
                    self.command(&session_id, resume_id, "resume", json!({}))?;
                }
                return Ok(());
            }
            if !resume
                && (session.current_request.is_some() || !session.queue.is_empty())
                && !session.receipts.contains_key(&prompt_id)
            {
                return Ok(());
            }
            (
                resume,
                session
                    .receipts
                    .get(&format!("teleport_{id}_0"))
                    .ok_or(Error::NotFound)?
                    .input
                    .clone(),
            )
        };
        if resume {
            self.command(&session_id, resume_id, "resume", json!({}))?;
        }
        input["text"] = json!(format!(
            "[Explicit Teleport retry] Inspect the saved context and any provider errors. Continue only unfinished work; never repeat completed or uncertain tool actions. Queued follow-ups are separate requests, not instructions to replay from the handoff log.\n\n{}",
            input["text"].as_str().unwrap_or_default()
        ));
        self.command(&session_id, prompt_id, "prompt", input)?;
        Ok(())
    }

    pub async fn teleport_cancel(&self, id: &str) -> Result<Value> {
        self.transfer_directory(id)?;
        let lock = self.teleports.lock(id);
        let _guard = lock.lock().await;
        let mut transfer = self.transfer_read(id)?;
        if self
            .local
            .lock()
            .unwrap()
            .sessions
            .contains_key(&Self::transfer_session(id))
        {
            return Err(Error::Conflict(
                "cloud execution already owns this transfer; use Stop",
            ));
        }
        transfer.cancelled = true;
        self.transfer_save(&transfer)?;
        self.transfer_view(&transfer)
    }

    pub async fn teleport_activate(
        self: &Arc<Self>,
        id: &str,
        retry_request: Option<String>,
    ) -> Result<Value> {
        self.transfer_directory(id)?;
        if self.local.lock().unwrap().draining {
            return Err(Error::Conflict("service is draining"));
        }
        if retry_request
            .as_ref()
            .is_some_and(|request| !valid_id(request))
        {
            return Err(Error::Conflict("invalid teleport manifest"));
        }
        let lock = self.teleports.lock(id);
        let _guard = lock.lock().await;
        let transfer = self.transfer_read(id)?;
        let session_id = Self::transfer_session(id);
        if self
            .local
            .lock()
            .unwrap()
            .sessions
            .contains_key(&session_id)
        {
            self.teleport_files_ready(&transfer)?;
            if let Some(request) = retry_request {
                self.teleport_retry(&transfer, &request)?;
            }
            return self.transfer_view(&transfer);
        }
        if transfer.cancelled {
            return Err(Error::Conflict("transfer cancelled"));
        }
        if transfer.manifest.files.iter().enumerate().any(|(i, e)| {
            matches!(e.kind.as_str(), "native" | "lineage" | "context")
                && !transfer.files.contains_key(&i)
        }) {
            return Err(Error::Conflict("session text is still uploading"));
        }
        let manifest = &transfer.manifest;
        if !self.config.harnesses.contains_key(&manifest.harness) {
            return Err(Error::Conflict("harness is not configured"));
        }
        let native_index = manifest
            .files
            .iter()
            .position(|entry| entry.kind == "native")
            .unwrap();
        let native_path = &transfer.files[&native_index];
        let prompts = if manifest.fork {
            Vec::new()
        } else {
            self.teleport_prompts(&transfer).await?
        };
        let receipt = Receipt {
            request_id: id.into(),
            command: "start".into(),
            input: json!({"harness":manifest.harness,"reasoning":manifest.reasoning,"teleport":id,"fork":manifest.fork,"command_guard_enabled":manifest.command_guard_enabled,"strip_ai_co_authors":manifest.strip_ai_co_authors,"system_prompt":manifest.system_prompt}),
            state: "completed".into(),
            model: Some(manifest.model.clone()),
            provider: manifest.provider.clone(),
            workspace: Some(transfer.workspace.clone()),
            error: None,
        };
        {
            let mut local = self.local.lock().unwrap();
            if self.is_stopping() || self.storage.blocks() {
                return Err(Error::Storage(
                    "service is stopping or disk protection is blocking writes".into(),
                ));
            }
            if native_in_use(&local, &manifest.native_id) {
                return Err(Error::Conflict(
                    "native conversation already belongs to a cloud session",
                ));
            }
            // This single fsynced record includes all queued work and the ownership decision.
            local.append(&session_id, "teleport", json!({"receipt":receipt,"prompts":prompts,"native_id":manifest.native_id,"native_path":native_path}), None)?;
            self.schedule_resume(&mut local, &session_id, false)?;
        }
        self.teleport_files_ready(&transfer)?;
        self.transfer_view(&transfer)
    }

    /// The handoff turn and the transferred queue, in order.
    async fn teleport_prompts(&self, transfer: &Transfer) -> Result<Vec<Receipt>> {
        let manifest = &transfer.manifest;
        let id = &manifest.request_id;
        let index: Vec<_> = manifest.files.iter().filter(|entry| !matches!(entry.kind.as_str(), "native" | "lineage")).map(|entry| json!({
            "source":entry.origin.as_deref().unwrap_or(&entry.path),"kind":entry.kind,"symlink":entry.symlink,
            "path":workspace::transfer_destination(&transfer.workspace,id,entry),"size_hint":entry.size,
        })).collect();
        let index = self
            .workspaces
            .attach(
                &transfer.workspace,
                &format!("teleport_index_{id}"),
                "files.json",
                "file",
                Body::from(serde_json::to_vec(&index).map_err(std::io::Error::other)?),
                &self.storage,
            )
            .await?;
        let handoff = format!(
            "[Teleport handoff]\n{}\n\nCloud workspace: {}\nThe local executor and its children are stopped. You are the only continuing parent. Complete their combined work. Old Mac paths, GUI tools and local-only instructions are not usable here. Use your current cloud tools. Never repeat an uncertain tool action blindly. Project dependencies are yours to resolve within existing permissions.\nFull file index: {}. Child context files are already available. Project files and attachments are uploading separately and might never arrive if the laptop disconnects. The index lists expected destinations, not proof of arrival: check whether each needed file exists. Work on whatever you can, and wait only when an essential file is missing. Different cloud originals are never overwritten; incoming versions remain at the indexed paths. An upload-completion follow-up will let you continue any blocked work.\n",
            manifest.handoff,
            transfer.workspace.path.display(),
            index["path"].as_str().unwrap_or_default()
        );
        Ok(std::iter::once(QueuedPrompt::Input {
            text: handoff,
            reasoning: manifest.reasoning.clone(),
            service_tier: manifest.service_tier.clone(),
        })
        .chain(manifest.queued.clone())
        .enumerate()
        .map(|(index, prompt)| Receipt {
            request_id: format!("teleport_{id}_{index}"),
            command: "prompt".into(),
            input: {
                let mut input = prompt.input();
                input["teleport_handoff"] = json!(index == 0);
                input
            },
            state: "accepted".into(),
            model: None,
            provider: None,
            workspace: None,
            error: None,
        })
        .collect())
    }
}
