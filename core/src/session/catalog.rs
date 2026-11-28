//! Read-only views: the session list, dashboard, harness capabilities, and model checks.
use super::*;
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

/// How long `/v1/capabilities` and interactive model checks reuse a discovered model list.
const CATALOG_TTL: Duration = Duration::from_secs(15 * 60);
/// How long `/v1/capabilities` reuses a failed probe so unauthenticated or broken harnesses do not re-probe every poll.
const CATALOG_FAILURE_TTL: Duration = Duration::from_secs(3 * 60);
/// Minimum age before an unknown model or effort on session start triggers a fresh catalog probe.
const CATALOG_REFRESH_TTL: Duration = Duration::from_secs(60);

/// What starting Claude with an exact model its catalog omits found for that model (#1059).
#[derive(Clone)]
pub(super) enum Probe {
    Listed(Vec<String>),
    Unlisted,
    Failed(Instant),
}

pub(super) type ClaudeProbes =
    Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<Option<Probe>>>>>;

struct CatalogEntry {
    generation: u64,
    fingerprint: u64,
    /// The last good list and when it was read; a later failed probe keeps it.
    models: Option<(Instant, Vec<runtime::Model>)>,
    /// The last failed probe, for `/v1/capabilities` back-off.
    failure: Option<(Instant, &'static str)>,
}

#[derive(Default)]
pub(super) struct CatalogSlot {
    generation: AtomicU64,
    entry: tokio::sync::Mutex<Option<CatalogEntry>>,
}

#[derive(Clone, Copy)]
enum CachePolicy {
    /// Background `/v1/capabilities` polling: reuse successes for `CATALOG_TTL` and failures for `CATALOG_FAILURE_TTL`.
    Capabilities,
    /// Interactive checks (Teleport, automation details): reuse successes for `CATALOG_TTL`, retry failures live.
    Standard,
    /// Session-start fast path: reuse any saved success until invalidated, retry failures live.
    SavedOk,
    /// Fallback when a requested model or effort is absent from the saved list: refresh once past `CATALOG_REFRESH_TTL`.
    RefreshIfStale,
}

impl CatalogEntry {
    fn cached(
        &self,
        now: Instant,
        generation: u64,
        fingerprint: u64,
        policy: CachePolicy,
    ) -> Option<Result<Vec<runtime::Model>>> {
        if self.generation != generation || self.fingerprint != fingerprint {
            return None;
        }
        let age = |at: &Instant| now.saturating_duration_since(*at);
        if let Some((checked, models)) = &self.models {
            let fresh = match policy {
                CachePolicy::SavedOk => true,
                CachePolicy::Capabilities | CachePolicy::Standard => age(checked) < CATALOG_TTL,
                CachePolicy::RefreshIfStale => age(checked) < CATALOG_REFRESH_TTL,
            };
            if fresh {
                return Some(Ok(models.clone()));
            }
        }
        match (&self.failure, policy) {
            (Some((at, message)), CachePolicy::Capabilities) if age(at) < CATALOG_FAILURE_TTL => {
                Some(Err(Error::Conflict(message)))
            }
            _ => None,
        }
    }
}

fn hash_metadata(hasher: &mut impl Hasher, meta: &std::fs::Metadata) {
    use std::os::unix::fs::MetadataExt;
    meta.dev().hash(hasher);
    meta.ino().hash(hasher);
    meta.len().hash(hasher);
    meta.mtime().hash(hasher);
    meta.mtime_nsec().hash(hasher);
}

fn hash_file(hasher: &mut impl Hasher, path: &Path) {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            1u8.hash(hasher);
            hash_metadata(hasher, &meta);
        }
        Err(_) => 0u8.hash(hasher),
    }
}

fn hash_binary(hasher: &mut impl Hasher, path: &Path) {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => {
            1u8.hash(hasher);
            hash_metadata(hasher, &meta);
            if meta.file_type().is_symlink() {
                std::fs::read_link(path).ok().hash(hasher);
                if let Ok(target) = std::fs::metadata(path) {
                    2u8.hash(hasher);
                    hash_metadata(hasher, &target);
                }
            }
        }
        Err(_) => 0u8.hash(hasher),
    }
}

/// Metadata fingerprint of a harness's binary and login/config files so CLI updates and external login pushes
/// (website sync, background harness upgrades, on-demand installs) invalidate cached catalogs immediately.
fn catalog_fingerprint(config: &Config, kind: runtime::Kind) -> u64 {
    let mut hasher = DefaultHasher::new();
    let Some(profile) = config.harnesses.get(&kind) else {
        return 0;
    };
    hash_binary(&mut hasher, &profile.binary);
    hash_file(&mut hasher, &config.state_dir.join("environment"));
    match kind {
        runtime::Kind::Codex => {
            hash_file(&mut hasher, &profile.home.join("auth.json"));
        }
        runtime::Kind::Claude => {
            for path in runtime::claude_login_paths(config) {
                hash_file(&mut hasher, &path);
            }
            hash_file(&mut hasher, &profile.home.join(".credentials.json"));
        }
        runtime::Kind::Cursor => {
            hash_file(&mut hasher, &profile.home.join("cloudroom-api-key"));
            hash_file(
                &mut hasher,
                &config.account_home.join(".config/cursor/auth.json"),
            );
        }
        runtime::Kind::OpenCode => {
            hash_file(&mut hasher, &profile.home.join("auth.json"));
            hash_file(
                &mut hasher,
                &profile.home.join("cloudroom-credentials.json"),
            );
            hash_file(
                &mut hasher,
                &config.account_home.join(".config/opencode/opencode.json"),
            );
            hash_file(
                &mut hasher,
                &config.account_home.join(".config/opencode/opencode.jsonc"),
            );
        }
        runtime::Kind::Antigravity => {
            hash_file(&mut hasher, &profile.home.join("cloudroom-api-key"));
            hash_file(&mut hasher, &profile.home.join("antigravity-oauth-token"));
            hash_file(&mut hasher, &profile.home.join("cloudroom-models"));
            hash_file(&mut hasher, &profile.home.join("settings.json"));
        }
        _ => {}
    }
    hasher.finish()
}

impl Manager {
    pub fn dashboard(&self) -> Value {
        let (sampled_at, resources) = self.observability.resources();
        let storage = self.storage.snapshot();
        let local = self.local.lock().unwrap();
        let mut sessions: Vec<_> = local.sessions.values().collect();
        sessions.sort_unstable_by_key(|s| std::cmp::Reverse(s.last_sequence));
        // Only a safe summary leaves this endpoint, never receipts, prompts or native records.
        let summaries: Vec<_> = sessions
            .iter()
            .take(1000)
            .map(|s| {
                let state = s.dashboard_state();
                json!({"id":s.session_id,"title":format!("{:?} session",s.harness),
                "repository":s.workspace.as_ref().map(|w| &w.path).unwrap_or(&self.config.repository).file_name().map(|n| n.to_string_lossy()),
                "harness":s.harness,"model":s.model,"state":state,
                "activity":if state == "waiting" { "waiting" } else { "unknown" },
                "lastActivity":s.last_activity})
            })
            .collect();
        json!({"version":1,"sampledAt":sampled_at,
            "runtime":{"ready":!self.is_stopping() && storage.level != Level::Blocked && local.journal.writable(),"version":crate::VERSION,"commit":crate::COMMIT,
                "configured":!self.config.harnesses.is_empty()},
            "appConnectivity":"unknown",
            "resources":{"cpu":resources["cpu"],"memory":resources["memory"],"disk":resources["disk"]},"cpuMinuteMs":resources["cpuMinuteMs"],
            "resourceBytes":{"memoryUsedBytes":resources["memoryUsedBytes"],"memoryTotalBytes":resources["memoryTotalBytes"],
                "diskAvailableBytes":resources["diskAvailableBytes"],"diskTotalBytes":resources["diskTotalBytes"]},
            "storage":storage,
            "diskThresholds":self.config.storage.as_ref().map(|policy| json!({"warningBytes":policy.warning_bytes,"pauseBytes":policy.pause_bytes})),
            "onboarding":{"localConnected":null,"offlineTaskVerified":null},
            "capabilities":{"settings":true,"updates":false},
            "sessionCount":sessions.len(),"agents":local.agent_counts(),"sessions":summaries,
            "terminals":self.terminals.summary(),"previews":{"lastActivity":self.previews.last_activity()},
            "mac":{"waiting":self.mac.waiting()}})
    }

    /// The latest 1,000 sessions, newest activity first. Prompts, receipts and records stay
    /// behind the per-session endpoints.
    pub fn list_sessions(&self) -> Value {
        let local = self.local.lock().unwrap();
        let mut sessions: Vec<_> = local.sessions.values().collect();
        sessions.sort_unstable_by_key(|s| std::cmp::Reverse(s.last_sequence));
        let summaries: Vec<_> = sessions
            .iter()
            .take(1000)
            .map(|s| {
                json!({"session_id":s.session_id,"harness":s.harness,"model":s.model,"provider":s.provider,
                "state":s.state,"workspace":s.workspace,"parent_session":s.parent_session,
                "title":s.title,"archived":s.archived,"parent_thread":s.parent_thread(),"last_app_prompt":s.last_app_prompt,
                "current_request":s.current_request,"queued":s.queue.len(),
                "last_sequence":s.last_sequence,"last_activity_ms":s.last_activity})
            })
            .collect();
        json!({"total":sessions.len(),"sessions":summaries})
    }

    fn catalog_slot(&self, kind: runtime::Kind) -> Option<&CatalogSlot> {
        Some(match kind {
            runtime::Kind::Codex => &self.codex_models,
            runtime::Kind::Claude => &self.claude_models,
            runtime::Kind::Cursor => &self.cursor_models,
            runtime::Kind::OpenCode => &self.opencode_models,
            runtime::Kind::Antigravity => &self.antigravity_models,
            _ => return None,
        })
    }

    /// Forces the next catalog read for `kind` to probe fresh (on login change or CLI update).
    pub(super) fn invalidate_catalog(&self, kind: runtime::Kind) {
        if let Some(slot) = self.catalog_slot(kind) {
            slot.generation.fetch_add(1, Ordering::Release);
        }
        if kind == runtime::Kind::Claude {
            self.claude_probes.lock().unwrap().clear();
        }
    }

    pub(super) async fn codex_models(&self) -> Result<Vec<runtime::Model>> {
        self.model_catalog(runtime::Kind::Codex).await
    }

    pub(super) async fn model_catalog(&self, kind: runtime::Kind) -> Result<Vec<runtime::Model>> {
        self.catalog(kind, CachePolicy::Standard).await
    }

    pub(super) async fn saved_catalog(&self, kind: runtime::Kind) -> Result<Vec<runtime::Model>> {
        self.catalog(kind, CachePolicy::SavedOk).await
    }

    /// Whether `model` accepts `reasoning`. The saved list answers first, so a start never waits for a refresh
    /// (capabilities calls keep it current); a model or effort it lacks gets one fresh check.
    pub(super) async fn reasoning_supported(
        &self,
        kind: runtime::Kind,
        model: &str,
        reasoning: &str,
    ) -> Result<bool> {
        let check = |models: &[runtime::Model]| {
            runtime::reasoning_levels(kind, models, model).map(|levels| levels.contains(&reasoning))
        };
        if check(&self.saved_catalog(kind).await?) == Some(true) {
            return Ok(true);
        }
        check(&self.catalog(kind, CachePolicy::RefreshIfStale).await?)
            .ok_or(Error::Conflict("invalid model"))
    }

    /// Why the catalog refuses `reasoning` for `model`, naming the levels it takes (ADR 0123).
    pub(super) async fn effort_refusal(
        &self,
        kind: runtime::Kind,
        model: &str,
        reasoning: &str,
    ) -> Option<Error> {
        let models = self.saved_catalog(kind).await.ok()?;
        runtime::supports(kind, &models, model, reasoning)
            .err()
            .map(Error::Effort)
    }

    /// The effort levels of a Claude model's own catalog row. Claude lists an exact model its catalog omits only once
    /// it runs it, so that row comes from a Claude started with the model, without inference (#1059). One probe per
    /// model runs at a time, within the startup limit, in a task of its own, so a dropped request never cuts it short.
    /// Its answer is kept, even "not listed"; a failure only for a minute.
    pub(super) async fn claude_levels(self: &Arc<Self>, model: &str) -> Option<Vec<String>> {
        let models = self.saved_catalog(runtime::Kind::Claude).await.ok()?;
        if let Some(entry) = models.into_iter().find(|entry| entry.model == model) {
            return Some(entry.reasoning_levels);
        }
        let slot = self
            .claude_probes
            .lock()
            .unwrap()
            .entry(model.to_owned())
            .or_default()
            .clone();
        let (manager, model) = (self.clone(), model.to_owned());
        let probe = tokio::spawn(async move {
            let mut answer = slot.lock().await;
            match &*answer {
                Some(Probe::Failed(at)) if at.elapsed() >= Duration::from_secs(60) => {}
                Some(found) => return found.clone(),
                None => {}
            }
            let found = match manager.startups.acquire().await {
                Ok(_startup) => {
                    let mut config = manager.config.clone();
                    match config.harnesses.get_mut(&runtime::Kind::Claude) {
                        Some(profile) => profile.model.clone_from(&model),
                        None => return Probe::Failed(Instant::now()),
                    }
                    match runtime::models(&config, runtime::Kind::Claude).await.0 {
                        Ok(models) => models
                            .into_iter()
                            .find(|entry| entry.model == model)
                            .map_or(Probe::Unlisted, |entry| {
                                Probe::Listed(entry.reasoning_levels)
                            }),
                        Err(_) => Probe::Failed(Instant::now()),
                    }
                }
                Err(_) => Probe::Failed(Instant::now()),
            };
            *answer = Some(found.clone());
            found
        });
        match probe.await.ok()? {
            Probe::Listed(levels) => Some(levels),
            Probe::Unlisted | Probe::Failed(_) => None,
        }
    }

    async fn catalog(
        &self,
        kind: runtime::Kind,
        policy: CachePolicy,
    ) -> Result<Vec<runtime::Model>> {
        let Some(slot) = self.catalog_slot(kind) else {
            return Err(Error::Conflict("model catalog unavailable"));
        };
        let mut cached = slot.entry.lock().await;
        let generation = slot.generation.load(Ordering::Acquire);
        let fingerprint = catalog_fingerprint(&self.config, kind);
        if let Some(entry) = &*cached {
            if let Some(hit) = entry.cached(Instant::now(), generation, fingerprint, policy) {
                return hit;
            }
            if kind == runtime::Kind::Claude && entry.fingerprint != fingerprint {
                self.claude_probes.lock().unwrap().clear();
            }
        }
        let (result, exit) = match kind {
            runtime::Kind::Cursor => (
                runtime::cursor_models::list(&self.config, &self.storage).await,
                None,
            ),
            runtime::Kind::OpenCode => (
                runtime::opencode::list_models(&self.config, &self.storage).await,
                None,
            ),
            runtime::Kind::Antigravity => (
                runtime::antigravity::models(&self.config, &self.storage).await,
                None,
            ),
            _ => runtime::models(&self.config, kind).await,
        };
        let crashed = matches!(
            exit,
            Some(runtime::Event::Exited {
                expected: false,
                ..
            })
        );
        let started = exit.is_some();
        if let Some(runtime::Event::Exited {
            reason,
            expected,
            details,
            ..
        }) = exit
        {
            self.observability
                .agent_exit(None, kind, reason, expected, details);
        }
        // A fixed reason, never the agent's own text (#819). A timed-out agent is killed, so check that first.
        let (failure, log_failure) = match result {
            Ok(models) => {
                *cached = Some(CatalogEntry {
                    generation,
                    fingerprint,
                    models: Some((Instant::now(), models.clone())),
                    failure: None,
                });
                return Ok(models);
            }
            Err(e)
                if kind == runtime::Kind::Antigravity && runtime::antigravity::signed_out(&e) =>
            {
                (runtime::antigravity::SIGN_IN, false)
            }
            Err(_)
                if matches!(
                    kind,
                    runtime::Kind::Cursor | runtime::Kind::OpenCode | runtime::Kind::Antigravity
                ) =>
            {
                ("model catalog unavailable", true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => (
                "model catalog unavailable (agent timed out listing models)",
                true,
            ),
            Err(_) if !started => ("model catalog unavailable (agent could not start)", true),
            Err(_) if crashed => (
                "model catalog unavailable (agent exited while starting; try again)",
                true,
            ),
            Err(_) => (
                "model catalog unavailable (agent sent an invalid model list)",
                true,
            ),
        };
        if log_failure {
            eprintln!("{kind:?} {failure}");
        }
        // Keep a still-valid saved list (same login and CLI); only record the failure beside it.
        let models = cached
            .take()
            .filter(|entry| entry.generation == generation && entry.fingerprint == fingerprint)
            .and_then(|entry| entry.models);
        *cached = Some(CatalogEntry {
            generation,
            fingerprint,
            models,
            failure: Some((Instant::now(), failure)),
        });
        Err(Error::Conflict(failure))
    }

    pub async fn capabilities(self: &Arc<Self>, include_models: bool) -> Value {
        let mut catalogs = std::collections::BTreeMap::new();
        if include_models && !self.storage.blocks() {
            let mut probes = tokio::task::JoinSet::new();
            for &kind in self.config.harnesses.keys() {
                if matches!(
                    kind,
                    runtime::Kind::Codex
                        | runtime::Kind::Claude
                        | runtime::Kind::Cursor
                        | runtime::Kind::OpenCode
                        | runtime::Kind::Antigravity
                ) {
                    let manager = Arc::clone(self);
                    probes.spawn(async move {
                        let models = match manager.startups.acquire().await {
                            Ok(_startup) => {
                                match manager.catalog(kind, CachePolicy::Capabilities).await {
                                    Ok(models) => json!(models),
                                    Err(_) => Value::Null,
                                }
                            }
                            Err(_) => Value::Null,
                        };
                        (kind, models)
                    });
                }
            }
            while let Some(result) = probes.join_next().await {
                if let Ok((kind, models)) = result {
                    catalogs.insert(kind, models);
                }
            }
        }
        let mut harnesses = Vec::new();
        for (kind, profile) in &self.config.harnesses {
            let mut harness = json!({"id":kind,"model":profile.model,"provider":profile.provider});
            match kind {
                runtime::Kind::Codex | runtime::Kind::Claude => {
                    if include_models {
                        harness["models"] = catalogs.remove(kind).unwrap_or(Value::Null);
                    }
                    harness["steer"] = json!(true);
                    harness["goal"] = json!(*kind == runtime::Kind::Codex);
                    harness["compact"] = json!(true);
                    harness["service_tier"] = json!(kind.fast());
                    harness["skill_mentions"] = json!(*kind == runtime::Kind::Claude);
                    harness["set_model"] = json!(*kind == runtime::Kind::Claude);
                    harness["idle_set_model"] = json!(*kind == runtime::Kind::Claude);
                    harness["rewind"] = json!(true);
                    harness["attachments"] = json!({"images":true,"files":true});
                    harness["subagents"] = json!(true);
                    harness["usage"] = json!(true);
                }
                runtime::Kind::Cursor
                | runtime::Kind::Fx
                | runtime::Kind::OpenCode
                | runtime::Kind::Hermes
                | runtime::Kind::Devin
                | runtime::Kind::Droid
                | runtime::Kind::Kimi
                | runtime::Kind::Antigravity
                | runtime::Kind::OpenClaw
                | runtime::Kind::AgentZero => {
                    let capabilities = runtime::cursor::capabilities(*kind);
                    for (key, value) in capabilities.as_object().unwrap() {
                        harness[key] = value.clone();
                    }
                    harness["reasoning_levels"] = json!(match kind {
                        runtime::Kind::OpenCode => runtime::OPENCODE_REASONING_LEVELS,
                        runtime::Kind::Hermes => runtime::HERMES_REASONING_LEVELS,
                        runtime::Kind::Devin => runtime::DEVIN_REASONING_LEVELS,
                        runtime::Kind::Droid => runtime::DROID_REASONING_LEVELS,
                        runtime::Kind::Kimi => runtime::KIMI_REASONING_LEVELS,
                        runtime::Kind::Antigravity => runtime::antigravity::LEVELS,
                        runtime::Kind::OpenClaw => runtime::OPENCLAW_REASONING_LEVELS,
                        runtime::Kind::AgentZero => runtime::AGENT_ZERO_REASONING_LEVELS,
                        _ => runtime::PI_REASONING_LEVELS,
                    });
                    // Cursor and OpenCode open images from the attached path; fx gets them inline.
                    harness["attachments"] = json!({"images":true,"files":true});
                    harness["provider_selection"] = json!(false);
                    // fx and Antigravity switch effort per turn; the others keep the launch level.
                    if *kind == runtime::Kind::Fx {
                        harness["reasoning_levels"] =
                            json!([runtime::PI_REASONING_LEVELS, &["max"]].concat());
                    }
                    if matches!(*kind, runtime::Kind::Fx | runtime::Kind::Antigravity) {
                        harness["prompt_reasoning"] = json!(true);
                    }
                    if include_models
                        && matches!(
                            *kind,
                            runtime::Kind::Cursor
                                | runtime::Kind::OpenCode
                                | runtime::Kind::Antigravity
                        )
                    {
                        harness["models"] = catalogs.remove(kind).unwrap_or(Value::Null);
                    }
                }
                runtime::Kind::Pi => {
                    harness["reasoning_levels"] =
                        json!([runtime::PI_REASONING_LEVELS, &["max"]].concat());
                    harness["provider_selection"] = json!(true);
                    harness["steer"] = json!(true);
                    harness["compact"] = json!(true);
                    harness["service_tier"] = json!(false);
                    harness["rewind"] = json!(true);
                    harness["attachments"] = json!({"images":true,"files":true});
                    harness["subagents"] = json!(true);
                    harness["usage"] = json!(true);
                }
            }
            harnesses.push(harness);
        }
        let mut capabilities = json!({"version":1,"repository":self.config.repository,"harnesses":harnesses,
            "previews":self.previews.enabled(),"mac_access":self.previews.enabled()});
        for feature in crate::FEATURES {
            capabilities[*feature] = json!(true);
        }
        capabilities
    }

    /// A model pick for Claude, which switches in its session (`set_model`); other agents keep their launch model.
    /// Returns the effort it runs with: the one asked for, or the session's nearest one the model takes.
    pub async fn check_model_switch(
        &self,
        id: &str,
        model: &str,
        reasoning: Option<&str>,
    ) -> Result<String> {
        if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
            return Err(Error::Conflict("invalid model"));
        }
        let current = {
            let local = self.local.lock().unwrap();
            let session = local.sessions.get(id).ok_or(Error::NotFound)?;
            if session.harness != runtime::Kind::Claude {
                return Err(Error::Conflict(
                    "this agent keeps its model; switch agents to change it",
                ));
            }
            session.reasoning.clone().unwrap_or_else(|| "none".into())
        };
        let kind = runtime::Kind::Claude;
        if let Some(level) = reasoning {
            if !self.reasoning_supported(kind, model, level).await? {
                return Err(Error::Conflict("invalid reasoning effort"));
            }
            return Ok(level.to_owned());
        }
        let models = self.saved_catalog(kind).await?;
        if let Some(level) = runtime::fit_reasoning(kind, &models, model, &current) {
            return Ok(level);
        }
        let models = self.catalog(kind, CachePolicy::RefreshIfStale).await?;
        runtime::fit_reasoning(kind, &models, model, &current)
            .ok_or(Error::Conflict("invalid model"))
    }

    /// Follow-up reasoning is checked against the launch model. Omitted reasoning stays on the launch default.
    pub async fn check_prompt_reasoning(&self, id: &str, reasoning: Option<&str>) -> Result<()> {
        let Some(reasoning) = reasoning else {
            return Ok(());
        };
        let (kind, model) = {
            let local = self.local.lock().unwrap();
            let session = local.sessions.get(id).ok_or(Error::NotFound)?;
            if matches!(
                session.harness,
                runtime::Kind::Cursor
                    | runtime::Kind::OpenCode
                    | runtime::Kind::Hermes
                    | runtime::Kind::Devin
                    | runtime::Kind::Droid
                    | runtime::Kind::Kimi
                    | runtime::Kind::OpenClaw
                    | runtime::Kind::AgentZero
            ) && session.reasoning.as_deref() != Some(reasoning)
            {
                return Err(Error::Conflict("invalid reasoning effort"));
            }
            let model = session.model.clone().or_else(|| {
                self.config
                    .harnesses
                    .get(&session.harness)
                    .map(|profile| profile.model.clone())
            });
            (session.harness, model)
        };
        let supported = match kind {
            runtime::Kind::Codex | runtime::Kind::Claude | runtime::Kind::Cursor => {
                let selected = model.ok_or(Error::Conflict("invalid model"))?;
                self.reasoning_supported(kind, &selected, reasoning).await?
            }
            runtime::Kind::Pi | runtime::Kind::Fx => runtime::pi_reasoning_accepted(reasoning),
            runtime::Kind::OpenCode => runtime::OPENCODE_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::Hermes => runtime::HERMES_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::Devin => runtime::DEVIN_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::Droid => runtime::DROID_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::Kimi => runtime::KIMI_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::Antigravity => runtime::antigravity::LEVELS.contains(&reasoning),
            runtime::Kind::OpenClaw => runtime::OPENCLAW_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::AgentZero => runtime::AGENT_ZERO_REASONING_LEVELS.contains(&reasoning),
        };
        if !supported {
            return Err(Error::Conflict("invalid reasoning effort"));
        }
        Ok(())
    }

    pub fn check_prompt_service_tier(&self, id: &str, tier: Option<&str>) -> Result<()> {
        let Some(tier) = tier else {
            return Ok(());
        };
        let kind = self
            .local
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .ok_or(Error::NotFound)?
            .harness;
        if !kind.tier(tier) {
            return Err(Error::Conflict("invalid service tier"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HarnessConfig;
    use std::os::unix::fs::symlink;

    fn sample_models() -> Vec<runtime::Model> {
        vec![runtime::Model {
            model: "test-model".into(),
            reasoning_levels: vec!["high".into()],
            service_tiers: vec![],
        }]
    }

    #[test]
    fn catalog_cache_policy_respects_ttls_and_invalidation() {
        let checked = Instant::now();
        let ok = CatalogEntry {
            generation: 1,
            fingerprint: 42,
            models: Some((checked, sample_models())),
            failure: None,
        };
        // Still valid after 60s (eliminates 60s desktop poll thrash), expires at 15m.
        let at_2m = checked + Duration::from_secs(120);
        assert!(ok.cached(at_2m, 1, 42, CachePolicy::Capabilities).is_some());
        assert!(ok.cached(at_2m, 1, 42, CachePolicy::Standard).is_some());
        assert!(ok.cached(at_2m, 1, 42, CachePolicy::SavedOk).is_some());
        assert!(
            ok.cached(at_2m, 1, 42, CachePolicy::RefreshIfStale)
                .is_none()
        );

        let at_15m = checked + CATALOG_TTL;
        assert!(
            ok.cached(at_15m, 1, 42, CachePolicy::Capabilities)
                .is_none()
        );
        assert!(ok.cached(at_15m, 1, 42, CachePolicy::Standard).is_none());
        assert!(ok.cached(at_15m, 1, 42, CachePolicy::SavedOk).is_some());

        // Invalidation via generation or fingerprint misses every policy, including SavedOk.
        assert!(ok.cached(checked, 2, 42, CachePolicy::SavedOk).is_none());
        assert!(ok.cached(checked, 1, 99, CachePolicy::SavedOk).is_none());

        // Failures are cached briefly for /v1/capabilities only; interactive starts always retry live.
        let err = CatalogEntry {
            generation: 1,
            fingerprint: 42,
            models: None,
            failure: Some((checked, "model catalog unavailable")),
        };
        assert!(matches!(
            err.cached(at_2m, 1, 42, CachePolicy::Capabilities),
            Some(Err(Error::Conflict("model catalog unavailable")))
        ));
        assert!(err.cached(checked, 1, 42, CachePolicy::Standard).is_none());
        assert!(err.cached(checked, 1, 42, CachePolicy::SavedOk).is_none());
        assert!(
            err.cached(checked, 1, 42, CachePolicy::RefreshIfStale)
                .is_none()
        );
        assert!(
            err.cached(
                checked + CATALOG_FAILURE_TTL,
                1,
                42,
                CachePolicy::Capabilities
            )
            .is_none()
        );
        assert!(
            err.cached(checked, 2, 42, CachePolicy::Capabilities)
                .is_none()
        );
        assert!(
            err.cached(checked, 1, 99, CachePolicy::Capabilities)
                .is_none()
        );
        // A failed refresh keeps the saved list: interactive starts and polls still get it while it is fresh.
        let kept = CatalogEntry {
            generation: 1,
            fingerprint: 42,
            models: Some((checked, sample_models())),
            failure: Some((at_2m, "model catalog unavailable")),
        };
        let at_3m = checked + Duration::from_secs(180);
        assert!(matches!(
            kept.cached(at_3m, 1, 42, CachePolicy::Capabilities),
            Some(Ok(_))
        ));
        assert!(matches!(
            kept.cached(at_3m, 1, 42, CachePolicy::SavedOk),
            Some(Ok(_))
        ));
        assert!(
            kept.cached(at_3m, 1, 42, CachePolicy::RefreshIfStale)
                .is_none()
        );
    }

    #[test]
    fn catalog_fingerprint_changes_on_binary_or_login_update() {
        let root =
            std::env::temp_dir().join(format!("cloudroom-catalog-fp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let state = root.join("state");
        let home = root.join("home");
        let codex_home = home.join(".codex");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::create_dir_all(&codex_home).unwrap();
        let v1 = root.join("codex-v1");
        let v2 = root.join("codex-v2");
        let bin = root.join("codex");
        std::fs::write(&v1, "v1").unwrap();
        std::fs::write(&v2, "v2-newer").unwrap();
        symlink(&v1, &bin).unwrap();

        let mut harnesses = BTreeMap::new();
        harnesses.insert(
            runtime::Kind::Codex,
            HarnessConfig {
                binary: bin.clone(),
                home: codex_home.clone(),
                model: "test".into(),
                provider: None,
            },
        );
        let config = Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            token: "x".repeat(32),
            state_dir: state,
            repository: root.clone(),
            api_url: None,
            store: "test".into(),
            instance: None,
            account_home: home,
            default_harness: runtime::Kind::Codex,
            harnesses,
            storage: None,
            rpc_timeout: Duration::from_secs(5),
            diagnostic_upload: Duration::from_secs(60),
            previous_exit_wait: Duration::from_secs(3),
        };

        let fp0 = catalog_fingerprint(&config, runtime::Kind::Codex);
        assert_eq!(fp0, catalog_fingerprint(&config, runtime::Kind::Codex));

        // Login file written -> fingerprint changes immediately.
        std::fs::write(codex_home.join("auth.json"), r#"{"tokens":{}}"#).unwrap();
        let fp1 = catalog_fingerprint(&config, runtime::Kind::Codex);
        assert_ne!(fp0, fp1);

        // Binary symlink retargeted (CLI update) -> fingerprint changes immediately.
        std::fs::remove_file(&bin).unwrap();
        symlink(&v2, &bin).unwrap();
        let fp2 = catalog_fingerprint(&config, runtime::Kind::Codex);
        assert_ne!(fp1, fp2);

        std::fs::remove_dir_all(&root).unwrap();
    }
}
