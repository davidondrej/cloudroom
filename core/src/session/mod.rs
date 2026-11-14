mod children;
pub use children::{ForkFrom, Spawn};
mod outbox;
pub mod teleport;
pub use outbox::Journal;
mod accounts;
pub mod automation;
mod catalog;
mod guard;
pub(crate) mod history;
pub mod info;
pub(crate) mod prompt;
pub(crate) mod relay;
pub mod report;
mod sleep;
mod state;
mod tokens;
pub use state::SessionState;
pub(crate) use tokens::Tokens;
pub mod thread;

use crate::{
    config::Config,
    observability::{Observability, Signal, elapsed_ms, metrics::AgentCounts, now_ms},
    runtime,
    workspace::storage::{Guard, Level, Snapshot},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, mpsc, watch};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Record {
    pub sequence: u64,
    pub session_id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<u64>,
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native: Option<String>,
}

/// Apps refuse a stream frame over 16 MiB, and the stream resends the same record forever (#581).
const MAX_CLIENT_RECORD: usize = 8 << 20;

impl Record {
    // Preserve the existing wire format without storing params twice alongside the native frame.
    fn for_client(mut self) -> Result<Self> {
        runtime::for_client(&mut self.data, self.native.as_deref())?;
        let bytes = serde_json::to_vec(&self).map_err(io::Error::other)?.len();
        if bytes > MAX_CLIENT_RECORD {
            // The record keeps its place and drops its body. A kind apps don't know, so none parses the missing body.
            self.kind = "oversized".into();
            self.data = json!({ "oversized_bytes": bytes });
            self.native = None;
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub request_id: String,
    pub command: String,
    pub input: Value,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<crate::workspace::Workspace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A start's provider, command guard, co-author stripping, system prompt and parent thread in another sandbox.
type StartOptions = (
    Option<String>,
    Option<bool>,
    Option<bool>,
    Option<String>,
    Option<String>,
);

/// A child start the website drives (ADR 20261104-015709): the request it
/// repeats until the child's first prompt is in, the child's thread ID once known, and how it ended.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct ChildStart {
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub body: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child: Option<String>,
    #[serde(default)]
    pub done: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub at_ms: u64,
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Session {
    pub session_id: String,
    #[serde(default)]
    pub teleport_output: bool,
    pub harness: runtime::Kind,
    pub capabilities: Value,
    pub native_cursor: Value,
    pub provider: Option<String>,
    pub native_id: Option<String>,
    pub native_path: Option<std::path::PathBuf>,
    pub native_offset: u64,
    pub state: SessionState,
    pub current_request: Option<String>,
    pub current_turn: Option<String>,
    pub startup_error: Option<String>,
    /// The detailed reason recorded with `startup_error`, shown to users verbatim.
    pub startup_reason: Option<String>,
    // Why the session failed or lost its process, with harness stderr, for `thread output`.
    #[serde(skip)]
    failure: Option<String>,
    #[serde(skip)]
    has_dispatched: bool,
    pub last_sequence: u64,
    pub receipts: BTreeMap<String, Receipt>,
    // Ordered prompts accepted while busy, delivered one turn at a time.
    pub queue: Vec<String>,
    #[serde(default)]
    pub prompts: BTreeMap<String, prompt::PromptState>,
    pub storage_paused: bool,
    pub queue_paused: bool,
    #[serde(default)]
    pub compacting: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_request: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<Value>,
    pub rewind_request: Option<String>,
    pub parent_session: Option<String>,
    // Archived by `room-cli thread archive`; `thread list` hides it unless asked.
    #[serde(default)]
    pub archived: bool,
    // The turn this thread archived itself in: archived, it still reports that one (relay.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_turn: Option<String>,
    // Turns already reported to the parent in another sandbox (relay.rs).
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub reported: std::collections::BTreeSet<String>,
    // What this parent last heard of each child in its own sandbox, by thread ID (relay.rs).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub child_states: BTreeMap<String, String>,
    // The reports an archived child could still send, by thread ID: its turns not reported yet when it took this
    // parent's archive (relay.rs, #1000).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub late_reports: BTreeMap<String, std::collections::BTreeSet<String>>,
    // When this parent archived each of them, while it still knows them as archived (relay.rs, #1430).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub child_archived_at: BTreeMap<String, u64>,
    // Children this session asked the website to start in sandboxes of their own, by request ID (relay.rs).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub child_starts: BTreeMap<String, ChildStart>,
    // The children those starts named, by thread ID: their reports and messages come to this session (relay.rs).
    // Never trimmed, since a child can report long after its start.
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub started: std::collections::BTreeSet<String>,
    /// The session's latest title, its start's or a `title` record's, for `GET /v1/sessions` (#237).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The newest prompt, steer or edit an app sent (`app_<install>_…` request IDs) and its record's sequence: the
    /// computer where the user last used the thread (#237).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_app_prompt: Option<Value>,
    /// This session's own changes still owed to the website, oldest first (relay.rs `watch_thread_reports`, #237).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thread_reports: Vec<Value>,
    /// The session an agent switch is starting from this one. Until it lands, this one takes no new work (#237).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continuing: Option<String>,
    /// For a session that continues another (agent switch, project move): `from`, and the `history` file it got (#237).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continued: Option<Value>,
    pub reasoning: Option<String>,
    pub workspace: Option<crate::workspace::Workspace>,
    #[serde(skip)]
    last_activity: Option<u64>,
    #[serde(skip)]
    last_prompt_state: Option<String>,
    #[serde(skip)]
    last_prompt_error: Option<String>,
    #[serde(skip)]
    model: Option<String>,
    #[serde(skip)]
    storage_warned: bool,
    #[serde(skip)]
    handle: Option<runtime::Handle>,
    #[serde(skip)]
    ready: bool,
    #[serde(skip)]
    recovery_attempted: bool,
    #[serde(skip)]
    close_request: Option<String>,
    // Last harness pid, so a later instance can reconcile ownership before resuming.
    #[serde(skip)]
    harness_pid: Option<u32>,
    // The latest turn stopped on a subscription usage limit.
    #[serde(skip)]
    usage_limited: bool,
    // The user switched accounts while this turn ran on the old login: if the limit stops it, it continues on the
    // new one at once (ADR 20261107-082836).
    #[serde(skip)]
    switched_mid_turn: bool,
    // When that limit resets, if the harness said; a website loop resumes the thread then (accounts.rs).
    #[serde(skip)]
    usage_resets_ms: Option<u64>,
    // The pending website loop that will resume this thread, and how many resumes ran since a turn completed.
    #[serde(skip)]
    resume_loop: Option<String>,
    // Loops retired (their limit ended or was replaced), still to be removed from the website.
    #[serde(skip)]
    resume_spent: Vec<String>,
    // Counts plan limits, so a loop the website answers for an earlier one is retired, never reused.
    #[serde(skip)]
    limit_episode: u64,
    #[serde(skip)]
    limit_resumes: u32,
    // The website refused this limit's loop (an archived thread, 100 loops); the next limit tries again.
    #[serde(skip)]
    resume_refused: bool,
    // The limit stopped a `plan_only` loop run, so its automatic continuations stay `plan_only` (ADR 0292).
    #[serde(skip)]
    resume_plan_only: bool,
    // A `plan_only` turn being stopped because it would spend extra credits.
    #[serde(skip)]
    credits_stop: Option<String>,
    // Whether the turn running now is guarded: set when a prompt's turn starts (replayed from its `starting_turn`
    // record), kept by turns the harness starts itself.
    #[serde(skip)]
    guarded_turn: bool,
    #[serde(skip)]
    awake: Option<sleep::Awake>,
    // The harness was asked to exit so this idle session can sleep.
    #[serde(skip)]
    releasing: bool,
    // A child's latest completed replies by request, so a queued turn cannot hide them from its parent.
    #[serde(skip)]
    replies: Vec<(String, String)>,
    // The running totals of the last `usage` reading (tokens.rs).
    #[serde(skip)]
    tokens: tokens::Tokens,
    // A copied-in history (teleport, move, rewind): Codex and Pi bring back its old totals, so the next reading only
    // sets the base.
    #[serde(skip)]
    tokens_restored: bool,
    // Teleport to Local holds the session (its request ID, until when in ms), so no other client changes it (#237).
    // Memory only: a restart lifts it, and the teleporting app renews it every 2 minutes.
    #[serde(skip)]
    frozen: Option<(String, u64)>,
}

impl Session {
    fn dashboard_state(&self) -> &'static str {
        if self.storage_paused {
            return "waiting";
        }
        match self.state {
            SessionState::Starting | SessionState::Resuming => "queued",
            SessionState::StartingTurn
            | SessionState::Running
            | SessionState::Interrupting
            | SessionState::Closing => "working",
            SessionState::Idle => match self.last_prompt_state.as_deref() {
                Some("failed") => "failed",
                Some("unknown" | "unknown_after_restart") => "unknown",
                _ => "waiting",
            },
            SessionState::Closed => "stopped",
            SessionState::Sleeping => "sleeping",
            SessionState::Failed | SessionState::ProcessLost => "failed",
            SessionState::Pending
            | SessionState::WaitingForFiles
            | SessionState::Suspended
            | SessionState::Rewinding
            | SessionState::SavedHistoryOnly
            | SessionState::Other(_) => "unknown",
        }
    }

    fn command_guard_enabled(&self) -> bool {
        self.receipts
            .values()
            .find(|r| r.command == "start")
            .and_then(|r| r.input["command_guard_enabled"].as_bool())
            .unwrap_or(true)
    }

    fn strip_ai_co_authors(&self) -> bool {
        self.receipts
            .values()
            .find(|r| r.command == "start")
            .and_then(|r| r.input["strip_ai_co_authors"].as_bool())
            .unwrap_or(true)
    }

    fn system_prompt(&self) -> Option<String> {
        self.receipts
            .values()
            .find(|r| r.command == "start")
            .and_then(|r| r.input["system_prompt"].as_str())
            .map(str::to_owned)
    }

    /// The app's thread this session reports its turns to, when that parent runs in another sandbox (relay.rs).
    fn parent_thread(&self) -> Option<&str> {
        self.receipts
            .values()
            .find(|r| r.command == "start")
            .and_then(|r| r.input["parent_thread"].as_str())
    }

    fn resume(&self) -> Option<runtime::Resume> {
        Some(runtime::Resume {
            id: self.native_id.clone()?,
            path: self.native_path.clone()?,
            cursor: self.native_cursor.clone(),
            model: self.model.clone(),
            provider: self.provider.clone(),
            reasoning: self.reasoning.clone(),
        })
    }

    fn can_resume(&self) -> bool {
        self.native_id.is_some()
            && self.native_path.is_some()
            && self.close_request.is_none()
            && !matches!(
                self.state,
                SessionState::Closed
                    | SessionState::ProcessLost
                    | SessionState::Failed
                    | SessionState::Resuming
                    | SessionState::Rewinding
            )
    }

    fn waiting_start(&self) -> Option<String> {
        if !matches!(
            self.state,
            SessionState::Pending | SessionState::WaitingForFiles
        ) || self.close_request.is_some()
            || self.native_id.is_some()
            || self.harness_pid.is_some()
        {
            return None;
        }
        self.receipts
            .values()
            .find(|r| r.command == "start" && r.state == "accepted")
            .map(|r| r.request_id.clone())
    }

    fn interrupt_pending(&self) -> bool {
        self.receipts.values().any(|receipt| {
            matches!(receipt.command.as_str(), "interrupt" | "stop")
                && matches!(receipt.state.as_str(), "accepted" | "delivered")
        })
    }
}

#[derive(Debug)]
pub enum Error {
    NotFound,
    Conflict(&'static str),
    /// A refused effort, with the levels the model takes (`invalid_reasoning_effort`).
    Effort(String),
    /// Carries the underlying cause so API clients can see why storage failed.
    Storage(String),
}
impl Error {
    /// Human-readable cause for API bodies that report failures as data.
    pub fn message(&self) -> String {
        match self {
            Self::NotFound => "session not found".into(),
            Self::Conflict(message) => (*message).into(),
            Self::Effort(message) => format!("invalid reasoning effort: {message}"),
            // A locked journal or a write that found no space: the only way in is `vm run` (#211).
            Self::Storage(detail)
                if detail == JOURNAL_UNWRITABLE || detail.contains("os error 28") =>
            {
                format!(
                    "storage unavailable ({detail}). Disk full? Free a few GB with `room-cli vm run --thread <thread id> '<command>'`"
                )
            }
            Self::Storage(detail) => format!("storage unavailable ({detail})"),
        }
    }
}
impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Storage(error.to_string())
    }
}
/// The most text one message to an agent can carry (ADR 0269).
pub const MAX_PROMPT: usize = 256 * 1024;
/// A `plan_only` loop run refused or stopped because its harness would spend extra credits (ADR 0292).
pub(crate) const PLAN_ONLY_REFUSED: &str = "extra credits are off for loops";
pub(crate) const PLAN_ONLY_STOPPED: &str =
    "Stopped: this loop run would spend extra credits, and Stop at plan limit is on.";
const JOURNAL_UNWRITABLE: &str = "session journal is not writable";
type Result<T> = std::result::Result<T, Error>;

struct Local {
    journal: Journal,
    sessions: BTreeMap<String, Session>,
    // Status snapshots must not clone the potentially large replay index.
    sequences: BTreeMap<String, Vec<u64>>,
    changed: watch::Sender<u64>,
    // Whether the last upload succeeded: true until one fails.
    database_available: bool,
    // The newest record that needs an upload. A parent report's ack doesn't: it rides with the next one (#1410).
    loud: u64,
    // A turn report waits for an upload: due at the uploader's next check, but never inside a failure's backoff.
    report_waits: bool,
    // Set by a drain before the sandbox stops; refuses new work until released.
    draining: bool,
    // The journal position of the latest replay snapshot (or failed attempt).
    snapshot_at: u64,
    // The shared browser, paused by the idle sleeper while nothing may use it (#610).
    browser: sleep::Browser,
    // The agent account that owns that browser; None when agents run as Core's own account.
    browser_owner: Option<u32>,
}

pub struct Manager {
    pub(crate) config: Config,
    local: Arc<Mutex<Local>>,
    pub(crate) history: history::History,
    pub(crate) observability: Observability,
    pub(crate) storage: Arc<Guard>,
    pub(crate) workspaces: crate::workspace::Workspaces,
    pub(crate) sync: crate::sync::Sync,
    pub(crate) previews: Arc<crate::preview::Previews>,
    pub(crate) terminals: runtime::terminal::Terminals,
    pub(crate) mac: crate::mac::Mac,
    pub(crate) secrets: crate::secrets::Secrets,
    codex_models: tokio::sync::Mutex<Option<(Instant, Vec<runtime::Model>)>>,
    claude_models: tokio::sync::Mutex<Option<(Instant, Vec<runtime::Model>)>>,
    cursor_models: tokio::sync::Mutex<Option<(Instant, Vec<runtime::Model>)>>,
    codex_auth: runtime::auth::CodexAuth,
    claude_auth: Arc<runtime::claude_auth::ClaudeAuth>,
    claude_login: runtime::claude_login::ClaudeLogin,
    cursor_auth: runtime::cursor_auth::CursorAuth,
    stopping: AtomicBool,
    startups: Semaphore,
    teleports: teleport::Transfers,
    /// Asks the history uploader to send now (a drain or stop), instead of at its next 30-second batch.
    uploads: tokio::sync::Notify,
    /// Plan limits, credits and their ends the harnesses reported, still to be sent to the website, and until when
    /// each harness pays with extra credits (ms), so `plan_only` loop runs never start meanwhile. Saved in the state
    /// folder, so a restart keeps both (accounts.rs).
    plan: Mutex<accounts::PlanState>,
    /// The Codex plan limit the login check last saw, and the account it saw.
    codex_reported: Mutex<Option<(bool, Option<u64>)>>,
    codex_login: Mutex<Option<String>>,
    /// When plan reports may be sent again after an outage, and the last wait (ms).
    report_retry: Mutex<(u64, u64)>,
}

impl Manager {
    pub fn open(config: Config) -> io::Result<Arc<Self>> {
        let mut local = Local::open(&config.state_dir)?;
        local.browser_owner = config.storage.as_ref().map(|p| p.agent_uid);
        // Resume conversations, not uncertain actions. An interrupted resume attempt
        // is left failed instead of creating a service-restart recovery loop.
        for session in local.sessions.values().cloned().collect::<Vec<_>>() {
            if session.workspace.is_none() && !session.receipts.is_empty() {
                local.append(
                    &session.session_id,
                    "workspace",
                    json!({"id":"legacy","path":config.repository}),
                    None,
                )?;
            }
            if session.waiting_start().is_some() {
                continue;
            }
            let eligible = session.can_resume()
                || session.startup_error.as_deref() == Some("startup_timeout")
                || (session.state == SessionState::Resuming
                    && !session.has_dispatched
                    && session.native_path.is_some());
            for mut receipt in session.receipts.values().cloned() {
                let terminal = matches!(
                    receipt.state.as_str(),
                    "completed" | "interrupted" | "failed" | "unknown" | "unknown_after_restart"
                );
                if terminal {
                    continue;
                }
                let queued =
                    receipt.command == "prompt" && session.queue.contains(&receipt.request_id);
                if !eligible || !queued {
                    receipt.state = if queued {
                        "failed"
                    } else {
                        "unknown_after_restart"
                    }
                    .into();
                    local.append(
                        &session.session_id,
                        "receipt",
                        serde_json::to_value(receipt)?,
                        None,
                    )?;
                }
            }
            if !matches!(
                session.state,
                SessionState::Closed
                    | SessionState::ProcessLost
                    | SessionState::Failed
                    | SessionState::Sleeping
            ) {
                local.append(
                    &session.session_id,
                    "state",
                    json!({"state":if eligible { SessionState::Suspended } else { SessionState::ProcessLost }}),
                    None,
                )?;
            }
        }
        // Native recovery runs helpers (Cursor capture) inside the agent cgroup, so prepare it first.
        let storage = Arc::new(Guard::new(&config)?);
        for session in local.sessions.values().cloned().collect::<Vec<_>>() {
            if let Some(saved) = session.resume()
                && let Some(profile) = config.harnesses.get(&session.harness)
                && let Err(error) = runtime::recover_records(
                    profile,
                    session.harness,
                    &saved,
                    config.storage.as_ref(),
                    |event| {
                        if let runtime::Event::Record { kind, data, native } = event {
                            local.append(&session.session_id, kind, data, native)?;
                        }
                        Ok(())
                    },
                )
            {
                local.append(
                    &session.session_id,
                    "native_history_unavailable",
                    json!({"reason":format!("native history missing, changed or unreadable: {error}")}),
                    None,
                )?;
                if session.can_resume() {
                    local.append(
                        &session.session_id,
                        "state",
                        json!({"state":SessionState::ProcessLost}),
                        None,
                    )?;
                    local
                        .fail_pending(&session.session_id)
                        .map_err(|_| io::Error::other("cannot record native recovery failure"))?;
                }
            }
        }
        local.save_snapshot();
        let workspaces = crate::workspace::Workspaces::open(&config)?;
        let sync = crate::sync::Sync::open(&config)?;
        let previews = crate::preview::Previews::open(&config)?;
        let history = history::History::new(&config)?;
        let plan = accounts::PlanState::load(&config.state_dir);
        let local = Arc::new(Mutex::new(local));
        let (registry, served) = (local.clone(), previews.clone());
        let observability = Observability::start(&config, history.api.clone(), move || {
            let mut counts = registry.lock().unwrap().agent_counts();
            counts.preview_at = served.last_activity();
            counts
        });
        Ok(Arc::new(Self {
            config,
            local,
            history,
            observability,
            storage,
            workspaces,
            sync,
            teleports: teleport::Transfers::default(),
            previews,
            terminals: Default::default(),
            mac: crate::mac::Mac::default(),
            secrets: crate::secrets::Secrets::default(),
            codex_models: tokio::sync::Mutex::new(None),
            claude_models: tokio::sync::Mutex::new(None),
            cursor_models: tokio::sync::Mutex::new(None),
            codex_auth: runtime::auth::CodexAuth::default(),
            claude_auth: Arc::new(runtime::claude_auth::ClaudeAuth::default()),
            claude_login: runtime::claude_login::ClaudeLogin::default(),
            cursor_auth: runtime::cursor_auth::CursorAuth::default(),
            stopping: AtomicBool::new(false),
            uploads: tokio::sync::Notify::new(),
            codex_reported: Mutex::new(plan.codex_seen),
            plan: Mutex::new(plan),
            codex_login: Mutex::new(None),
            report_retry: Mutex::new((0, 0)),
            // Bound cold-start CPU contention, not the number of running sessions.
            startups: Semaphore::new(
                std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).max(1)),
            ),
        }))
    }

    /// The session whose live harness process is one of `pids`, the caller and its ancestors.
    pub(crate) fn harness_session(&self, pids: &[u32]) -> Option<String> {
        let local = self.local.lock().unwrap();
        let direct = pids.iter().find_map(|pid| {
            local
                .sessions
                .values()
                .find(|s| s.handle.as_ref().is_some_and(|h| h.pid() == *pid))
                .map(|s| s.session_id.clone())
        });
        // OpenClaw runs every session's tools under its shared Gateway: the caller belongs to the OpenClaw
        // session running a turn, or, with several, to the one whose folder the caller works in.
        if direct.is_some() || !runtime::openclaw_gateway_pid().is_some_and(|g| pids.contains(&g)) {
            return direct;
        }
        let busy: Vec<_> = local
            .sessions
            .values()
            .filter(|s| {
                s.harness == runtime::Kind::OpenClaw
                    && s.handle.is_some()
                    && s.current_request.is_some()
            })
            .collect();
        let cwd = std::fs::read_link(format!("/proc/{}/cwd", pids.first()?)).ok();
        let within = |s: &&&Session| {
            let folder = s
                .workspace
                .as_ref()
                .and_then(|w| w.path.canonicalize().ok());
            cwd.as_ref()
                .zip(folder)
                .is_some_and(|(cwd, folder)| cwd.starts_with(folder))
        };
        match busy.as_slice() {
            [only] => Some(only.session_id.clone()),
            _ => match busy.iter().filter(within).collect::<Vec<_>>().as_slice() {
                [only] => Some(only.session_id.clone()),
                _ => None,
            },
        }
    }

    /// Teleport to Local holds session `id` for `request` (#237): until `release`, a close, or FREEZE_MS without a
    /// renewal, every other client's change gets MOVING. The same request renews it; another is refused.
    pub fn freeze(&self, id: &str, request: &str, release: bool) -> Result<Value> {
        let mut local = self.local.lock().unwrap();
        let session = local.sessions.get_mut(id).ok_or(Error::NotFound)?;
        let now = now_ms();
        if session
            .frozen
            .as_ref()
            .is_some_and(|(held, until)| *until > now && held != request)
        {
            return Err(Error::Conflict(MOVING));
        }
        if release {
            session.frozen = None;
            return Ok(json!({"frozen":false}));
        }
        if session.continuing.is_some() {
            return Err(Error::Conflict(SWITCHING));
        }
        session.frozen = Some((request.to_owned(), now + FREEZE_MS));
        Ok(json!({"frozen":true,"until_ms":now + FREEZE_MS}))
    }

    /// Whether `request` still holds the session: Teleport's close checks it, so a lapsed freeze never ends a turn
    /// another client started meanwhile.
    pub fn holds(&self, id: &str, request: &str) -> bool {
        let local = self.local.lock().unwrap();
        local
            .sessions
            .get(id)
            .and_then(|s| s.frozen.as_ref())
            .is_some_and(|(held, until)| held == request && *until > now_ms())
    }

    /// The user renames session `id` in an app (#237). Never reported: the app sends a thread's own rename to the website.
    pub fn set_title(&self, id: &str, title: &str) -> Result<()> {
        if !self.local.lock().unwrap().sessions.contains_key(id) {
            return Err(Error::NotFound);
        }
        Ok(self.note(id, "title", json!({"title":title,"user":true}))?)
    }

    /// The user archives or restores session `id` in an app (#237): a thread sharing another's sandbox, which has no
    /// website row, or a thread its agent archived while a child kept the sandbox, restored before the website heard.
    pub fn set_archived(&self, id: &str, archived: bool) -> Result<()> {
        if !self.local.lock().unwrap().sessions.contains_key(id) {
            return Err(Error::NotFound);
        }
        // A restore gets its own record kind: apps before #237 archive the thread on any `archive` record.
        let (kind, data) = if archived {
            ("archive", json!({"archived":true,"user":true}))
        } else {
            ("unarchive", json!({"user":true}))
        };
        Ok(self.note(id, kind, data)?)
    }

    /// Names this Core's start for the website: every wake starts Core with a new token (#237, web `coreThread`).
    pub(crate) fn wake_id(&self) -> String {
        let digest = ring::digest::digest(&ring::digest::SHA256, self.config.token.as_bytes());
        digest.as_ref()[..8]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// Appends a record that no harness produced, such as a secret request.
    pub(crate) fn note(&self, session: &str, kind: &str, data: Value) -> io::Result<()> {
        self.local
            .lock()
            .unwrap()
            .append(session, kind, data, None)
            .map(drop)
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::Relaxed)
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.local.lock().unwrap().changed.subscribe()
    }

    pub(crate) fn recording_available(&self) -> bool {
        self.local.lock().unwrap().journal.writable()
    }

    pub async fn ready(&self) -> bool {
        // Local only: the journal is the source of truth, and uploads catch up whenever the API answers.
        !self.is_stopping() && !self.storage.blocks() && self.recording_available()
    }

    pub fn saving(&self) -> Value {
        let local = self.local.lock().unwrap();
        json!({"locally_recorded_through":local.journal.last(),"externally_saved_through":local.journal.saved(),
            "pending_records":local.journal.last()-local.journal.saved(),"last_upload_succeeded":local.database_available})
    }

    pub async fn records(&self, session: &str, after: u64) -> Result<Vec<Record>> {
        {
            let mut guard = self.local.lock().unwrap();
            let local = &mut *guard;
            if let Some(sequences) = local.sequences.get(session) {
                return sequences[sequences.partition_point(|id| *id <= after)..]
                    .iter()
                    .take(256)
                    .map(|sequence| {
                        let record: Record =
                            serde_json::from_slice(&local.journal.read(*sequence)?)
                                .map_err(io::Error::other)?;
                        record.for_client()
                    })
                    .collect();
            }
        }
        self.history
            .read(session, after)
            .await
            .map_err(|e| Error::Storage(format!("saved history: {e}")))?
            .into_iter()
            .map(Record::for_client)
            .collect()
    }

    pub async fn session(&self, id: &str) -> Result<Session> {
        if let Some(session) = self.local.lock().unwrap().sessions.get(id).cloned() {
            return Ok(session);
        }
        self.history
            .summary(id, None)
            .await
            .map_err(|e| Error::Storage(format!("saved history: {e}")))?
            .0
            .ok_or(Error::NotFound)
    }

    pub fn recovery_check(&self, session: &Session) -> Value {
        let (status, message) = if session.close_request.is_some()
            || session.state == SessionState::Closed
            || session.state == SessionState::SavedHistoryOnly
        {
            (
                "unavailable",
                "This session is closed or has saved history only",
            )
        } else if let Some(saved) = session.resume()
            && let Some(profile) = self.config.harnesses.get(&session.harness)
        {
            match runtime::check_resume_history(
                session.harness,
                profile,
                &saved,
                self.config.storage.as_ref(),
            ) {
                Ok(()) => (
                    "ready",
                    "Saved conversation is available; the native resume handshake is still required",
                ),
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound && !session.has_dispatched =>
                {
                    (
                        "empty",
                        "No turn was dispatched and no saved conversation exists; there is nothing to resume",
                    )
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => (
                    "missing",
                    "Saved conversation is missing; do not create a replacement or replay work",
                ),
                Err(_) => ("unavailable", "Saved conversation could not be read safely"),
            }
        } else {
            (
                "unavailable",
                "No saved native conversation identity is available",
            )
        };
        json!({"status":status,"message":message})
    }

    fn retry(
        session: &Session,
        request: &str,
        command: &str,
        input: &Value,
    ) -> Result<Option<Receipt>> {
        // `plan_only` is guard metadata Core may add itself (an inherited resume), not the request's content.
        let content = |input: &Value| {
            let mut input = input.clone();
            if let Some(fields) = input.as_object_mut() {
                fields.remove("plan_only");
            }
            input
        };
        match session.receipts.get(request) {
            Some(receipt)
                if receipt.command != command || content(&receipt.input) != content(input) =>
            {
                Err(Error::Conflict("request_id already has different content"))
            }
            other => Ok(other.cloned()),
        }
    }

    /// Match cloud Claude Code to the Mac's version (ADR 0133); waits while Claude runs.
    pub async fn match_claude_version(&self, version: String) -> Result<Value> {
        if !runtime::claude_version::valid(&version) {
            return Err(Error::Conflict("invalid version"));
        }
        if !self.config.harnesses.contains_key(&runtime::Kind::Claude) {
            return Err(Error::Conflict("harness is not configured"));
        }
        let busy = self.local.lock().unwrap().sessions.values().any(|s| {
            s.harness == runtime::Kind::Claude
                && (s.handle.is_some()
                    || matches!(s.state, SessionState::Starting | SessionState::Resuming))
        });
        Ok(runtime::claude_version::ensure(self.config.clone(), version, busy).await)
    }

    /// Account checks shared by new sessions and Teleport's preflight.
    async fn harness_ready(self: &Arc<Self>, kind: runtime::Kind) -> Result<()> {
        if kind == runtime::Kind::Claude {
            match self
                .claude_auth
                .ready(&self.config, &self.observability)
                .await
            {
                Ok(true) => {}
                Ok(false) => {
                    return Err(Error::Conflict(
                        "connect Claude Code before starting cloud work",
                    ));
                }
                // Why, in our own words: never the CLI's output (#1222). Same prefix, so the code stays.
                Err(reason) => {
                    return Err(Error::Conflict(match reason {
                        "check_timeout" => {
                            "Claude account could not be verified: the login check timed out"
                        }
                        "check_failed" => {
                            "Claude account could not be verified: the Claude CLI could not run"
                        }
                        "check_bad_exit" => {
                            "Claude account could not be verified: the Claude CLI exited with an error"
                        }
                        "check_bad_response" => {
                            "Claude account could not be verified: the Claude CLI gave an unreadable answer"
                        }
                        _ => "Claude account could not be verified",
                    }));
                }
            }
        }
        if kind == runtime::Kind::Cursor {
            match self.cursor_auth_status().await.state {
                "connected" => {}
                "unavailable" => {
                    return Err(Error::Conflict("Cursor account could not be verified"));
                }
                _ => return Err(Error::Conflict("connect Cursor before starting cloud work")),
            }
        }
        if kind == runtime::Kind::Codex {
            let status = self.codex_auth_status().await;
            // Which login state failed, and the fix (#1017). Same prefix, so the code and matchers stay.
            match status.state {
                "connected" => {}
                "missing" if status.message == Some(runtime::auth::LOGIN_REJECTED) => {
                    return Err(Error::Conflict(
                        "connect Codex before starting cloud work: OpenAI rejected this sandbox's Codex login. Sign in to Codex again in Cloudroom's Agents settings, then retry",
                    ));
                }
                "missing" => {
                    return Err(Error::Conflict(
                        "connect Codex before starting cloud work: this sandbox has no Codex login. Sign in to Codex in Cloudroom's Agents settings, then retry",
                    ));
                }
                "waiting" => {
                    return Err(Error::Conflict(
                        "connect Codex before starting cloud work: a Codex sign-in here is not finished. Finish it or sign in again in Cloudroom's Agents settings, then retry",
                    ));
                }
                "expired" => {
                    return Err(Error::Conflict(
                        "connect Codex before starting cloud work: a Codex sign-in here expired before it was finished. Sign in again in Cloudroom's Agents settings, then retry",
                    ));
                }
                "error" => {
                    return Err(Error::Conflict(
                        "connect Codex before starting cloud work: a Codex sign-in here failed, or its saved login is invalid. Sign in again in Cloudroom's Agents settings, then retry",
                    ));
                }
                "limited" => return Err(Error::Conflict("Codex usage limit reached")),
                _ => return Err(Error::Conflict("Codex account could not be verified")),
            }
        }
        Ok(())
    }

    /// Model and effort checks shared by new sessions and Teleport's preflight.
    async fn execution_supported(
        &self,
        kind: runtime::Kind,
        model: Option<&String>,
        reasoning: &str,
    ) -> Result<()> {
        let supported = match kind {
            runtime::Kind::Codex | runtime::Kind::Claude | runtime::Kind::Cursor => {
                let selected = model.unwrap_or(&self.config.harnesses[&kind].model);
                self.reasoning_supported(kind, selected, reasoning).await?
            }
            runtime::Kind::Pi | runtime::Kind::Fx => runtime::pi_reasoning_accepted(reasoning),
            runtime::Kind::OpenCode => runtime::OPENCODE_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::Hermes => runtime::HERMES_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::Devin => runtime::DEVIN_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::Droid => runtime::DROID_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::Kimi => runtime::KIMI_REASONING_LEVELS.contains(&reasoning),
            runtime::Kind::Antigravity => {
                runtime::ANTIGRAVITY_REASONING_LEVELS.contains(&reasoning)
            }
            runtime::Kind::OpenClaw => runtime::OPENCLAW_REASONING_LEVELS.contains(&reasoning),
        };
        if !supported {
            return Err(Error::Conflict("invalid reasoning effort"));
        }
        Ok(())
    }

    pub async fn start(
        self: &Arc<Self>,
        request: String,
        harness: Option<runtime::Kind>,
        model: Option<String>,
        reasoning: Option<String>,
        (workspace, workspace_name): (Option<String>, Option<String>),
        (provider, command_guard_enabled, strip_ai_co_authors, system_prompt, parent_thread): StartOptions,
    ) -> Result<(String, Receipt)> {
        let id = format!("cr_{request}");
        let kind = harness
            .or_else(|| {
                self.local
                    .lock()
                    .unwrap()
                    .sessions
                    .get(&id)
                    .map(|s| s.harness)
            })
            .unwrap_or(self.config.default_harness);
        let mut input = if kind == runtime::Kind::Codex {
            json!({})
        } else {
            json!({"harness":kind})
        };
        if command_guard_enabled == Some(false) {
            input["command_guard_enabled"] = json!(false);
        }
        if strip_ai_co_authors == Some(false) {
            input["strip_ai_co_authors"] = json!(false);
        }
        if let Some(system_prompt) = &system_prompt {
            input["system_prompt"] = json!(system_prompt);
        }
        if let Some(parent) = &parent_thread {
            if !relay::thread_id(parent) {
                return Err(Error::Conflict("invalid parent_thread"));
            }
            input["parent_thread"] = json!(parent);
        }
        if let Some(model) = &model {
            input["model"] = json!(model);
        }
        if let Some(provider) = &provider {
            if kind != runtime::Kind::Pi {
                return Err(Error::Conflict("provider selection requires Pi"));
            }
            input["provider"] = json!(provider);
        }
        if let Some(reasoning) = &reasoning {
            input["reasoning"] = json!(reasoning);
        }
        if let Some(workspace) = &workspace {
            crate::workspace::valid_id(workspace)
                .map_err(|_| Error::Conflict("invalid workspace"))?;
            input["workspace"] = json!(workspace);
        }
        if let Some(name) = &workspace_name {
            if workspace.is_none() || crate::workspace::valid_name(name).is_err() {
                return Err(Error::Conflict("invalid workspace"));
            }
            input["workspace_name"] = json!(name);
        }
        if let Some(session) = self.local.lock().unwrap().sessions.get(&id) {
            return Self::retry(session, &request, "start", &input)?
                .map(|r| (id.clone(), r))
                .ok_or(Error::Conflict("session already exists"));
        }
        if !self.recording_available() {
            return Err(Error::Storage(JOURNAL_UNWRITABLE.into()));
        }
        if self.storage.blocks() {
            return Err(Error::Conflict("storage unsafe; new execution is blocked"));
        }
        if self.config.harnesses.is_empty() {
            return Err(Error::Conflict("agent setup is incomplete"));
        }
        // The history, login, and model checks run together; their results apply in this order.
        let configured = self.config.harnesses.contains_key(&kind);
        let (history, ready, supported) = tokio::join!(
            self.history.summary(&id, Some(&request)),
            async {
                if configured {
                    self.harness_ready(kind).await
                } else {
                    Ok(())
                }
            },
            async {
                match &reasoning {
                    Some(reasoning) if configured => {
                        self.execution_supported(kind, model.as_ref(), reasoning)
                            .await
                    }
                    _ => Ok(()),
                }
            },
        );
        // Fresh-state retries must not recreate an externally saved session.
        let (external, receipt) =
            history.map_err(|e| Error::Storage(format!("saved history: {e}")))?;
        if let Some(external) = external {
            if harness.is_some_and(|kind| kind != external.harness) {
                return Err(Error::Conflict("request_id already has different content"));
            }
            let receipt =
                receipt.ok_or(Error::Conflict("saved session has no matching receipt"))?;
            if receipt.input != input {
                return Err(Error::Conflict("request_id already has different content"));
            }
            return Ok((id, receipt));
        }
        if !configured {
            return Err(Error::Conflict("harness is not configured"));
        }
        ready?;
        supported?;
        let workspace = match workspace {
            // Unregistered like legacy sessions, so no project folder is created.
            Some(id) if id == crate::workspace::ROOT => crate::workspace::Workspace {
                id: "legacy".into(),
                path: self.workspaces.root().to_path_buf(),
                parent: None,
            },
            Some(id) => self
                .workspaces
                .resolve(&id, workspace_name.as_deref())
                .map_err(|_| Error::Conflict("workspace mapping unavailable"))?,
            None => crate::workspace::Workspace {
                id: "legacy".into(),
                path: self.config.repository.clone(),
                parent: None,
            },
        };
        let receipt = Receipt {
            request_id: request.clone(),
            command: "start".into(),
            input,
            state: "accepted".into(),
            model: Some(model.unwrap_or_else(|| self.config.harnesses[&kind].model.clone())),
            provider: provider.or_else(|| self.config.harnesses[&kind].provider.clone()),
            workspace: Some(workspace),
            error: None,
        };
        {
            let mut local = self.local.lock().unwrap();
            if let Some(session) = local.sessions.get(&id) {
                return Self::retry(session, &request, "start", &receipt.input)?
                    .map(|r| (id.clone(), r))
                    .ok_or(Error::Conflict("session already exists"));
            }
            if self.is_stopping() {
                return Err(Error::Conflict("service is stopping"));
            }
            if local.draining {
                return Err(Error::Conflict("service is draining"));
            }
            if self.storage.blocks() {
                return Err(Error::Conflict("storage unsafe; new execution is blocked"));
            }
            local.append(
                &id,
                "receipt",
                serde_json::to_value(&receipt).map_err(io::Error::other)?,
                None,
            )?;
        }
        let manager = self.clone();
        let session = id.clone();
        tokio::spawn(async move {
            manager.launch(session, request).await;
        });
        Ok((id, receipt))
    }

    /// Starts `cr_<request>` as the continuation of session `from`: an agent switch or a project move, from any of the
    /// user's computers (#237). One exclusive transition: `from` is held (SWITCHING) before its history is copied, the
    /// new session gets that history and the old start's settings, and `from` closes only once the website took the
    /// new one. True while the website hasn't answered yet: Core keeps trying, and the thread's list shows the outcome.
    pub async fn continue_session(
        self: &Arc<Self>,
        request: String,
        from: String,
        (harness, model, reasoning, provider): (
            Option<runtime::Kind>,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
        (workspace, workspace_name): (Option<String>, Option<String>),
    ) -> Result<(String, Receipt, bool)> {
        let id = format!("cr_{request}");
        let existing = self
            .local
            .lock()
            .unwrap()
            .sessions
            .get(&id)
            .and_then(|s| s.receipts.get(&request).cloned());
        if let Some(receipt) = existing {
            return self.continue_again(from, id, receipt).await;
        }
        let (old, options) = {
            let mut local = self.local.lock().unwrap();
            let s = local.sessions.get(&from).ok_or(Error::NotFound)?;
            if s.parent_session.is_some() {
                return Err(Error::Conflict(
                    "a thread sharing its parent's sandbox keeps its agent",
                ));
            }
            if s.continuing.is_some() {
                return Err(Error::Conflict(SWITCHING));
            }
            if s.frozen
                .as_ref()
                .is_some_and(|(_, until)| *until > now_ms())
            {
                return Err(Error::Conflict(MOVING));
            }
            if s.busy() || !s.queue.is_empty() || s.close_request.is_some() {
                return Err(Error::Conflict(
                    "wait until the agent and its queued messages finish, then switch",
                ));
            }
            if local
                .sessions
                .values()
                .any(|c| c.parent_session.as_deref() == Some(&from) && c.busy())
            {
                return Err(Error::Conflict(
                    "wait until this thread's child agents finish, then switch",
                ));
            }
            let options = (
                provider,
                Some(s.command_guard_enabled()),
                Some(s.strip_ai_co_authors()),
                s.system_prompt(),
                s.parent_thread().map(str::to_owned),
            );
            let old = (
                s.harness,
                s.model.clone(),
                s.reasoning.clone(),
                s.workspace.clone(),
                s.last_app_prompt.clone(),
                s.continued.clone(),
            );
            local.append(&from, "continuing", json!({"session":id}), None)?;
            (old, options)
        };
        let (old_harness, old_model, old_reasoning, old_workspace, last_app_prompt, earlier) = old;
        let harness = harness.unwrap_or(old_harness);
        let model = model.or_else(|| (harness == old_harness).then_some(old_model).flatten());
        // Same folder as before, unless a project move names another (the app's rule before #237).
        let workspace = workspace.or_else(|| match &old_workspace {
            Some(w) if w.id != "legacy" => Some(w.id.clone()),
            Some(w) if w.path != self.config.repository => Some(crate::workspace::ROOT.to_owned()),
            _ => None,
        });
        let release = |manager: &Self| {
            let _ = manager.note(&from, "continuing", json!({"session":null}));
        };
        let history = self.history_markdown(&from, earlier.as_ref()).await;
        let started = self
            .start(
                request.clone(),
                Some(harness),
                model,
                reasoning.or(old_reasoning),
                (workspace, workspace_name),
                options,
            )
            .await;
        let (id, receipt) = match started {
            Ok(started) => started,
            Err(error) => {
                release(self);
                return Err(error);
            }
        };
        // Its history goes into its own folder, where its agent reads it; a note on its first prompt points there.
        // Without it the new agent would start blank, so the switch stops instead.
        let path = match (&receipt.workspace, history.as_ref()) {
            (Some(folder), Some((full, _))) => {
                let written = self
                    .workspaces
                    .attach(
                        folder,
                        &request,
                        HISTORY_FILE,
                        "file",
                        axum::body::Body::from(full.clone()),
                        &self.storage,
                    )
                    .await
                    .ok()
                    .and_then(|written| written["path"].as_str().map(str::to_owned));
                if written.is_none() {
                    self.settle_continue(&from, &id, false);
                    return Err(Error::Conflict(
                        "the conversation couldn't be copied to the new agent, so this thread wasn't changed",
                    ));
                }
                written
            }
            _ => None,
        };
        // Core keeps its own copy for this session's next switch: the file above is the agent's to change.
        if let Some((full, _)) = &history {
            prompt::save_history(&self.config.state_dir, &id, full);
        }
        let continued = json!({"from":from,"history":path,"last_app_prompt":last_app_prompt});
        self.note(&id, "continued", continued)?;
        if let (Some(path), Some((_, tail))) = (&path, &history) {
            let what = if harness == old_harness {
                "This conversation moved to another project folder, in a new session.".to_owned()
            } else {
                format!(
                    "This conversation started with another agent ({}). You are now continuing it as {}.",
                    json!(old_harness),
                    json!(harness)
                )
            };
            prompt::add_session_note(
                &self.config.state_dir,
                &id,
                &format!(
                    "<cloudroom_custom_instructions>\n[Cloudroom] {what} The full conversation so far is in {path}: user messages and agent replies, without tool output. Read it before you reply, treat it as your own history, check the workspace for the current state, and don't redo finished work.\n\nThe latest messages:\n\n{tail}\n</cloudroom_custom_instructions>"
                ),
            );
        }
        let pending = self.land_continue(from, id.clone()).await?;
        Ok((id, receipt, pending))
    }

    /// The same switch asked for again, say after a lost answer (#237). One still being set up is waited for, then
    /// finished; a finished one says how it ended.
    async fn continue_again(
        self: &Arc<Self>,
        from: String,
        id: String,
        receipt: Receipt,
    ) -> Result<(String, Receipt, bool)> {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let (holding, continued, state) = {
                let local = self.local.lock().unwrap();
                let s = local.sessions.get(&id);
                (
                    local
                        .sessions
                        .get(&from)
                        .is_some_and(|s| s.continuing.as_deref() == Some(&id)),
                    s.and_then(|s| s.continued.clone()),
                    s.map(|s| s.state.clone()),
                )
            };
            match continued {
                Some(c) if c["from"].as_str() != Some(from.as_str()) => {
                    return Err(Error::Conflict("request_id already has different content"));
                }
                Some(_) if holding => {
                    return Ok((id.clone(), receipt, self.land_continue(from, id).await?));
                }
                Some(_) if matches!(state, Some(SessionState::Closing | SessionState::Closed)) => {
                    return Err(Error::Conflict(
                        "this switch didn't happen, so this thread wasn't changed",
                    ));
                }
                Some(_) => return Ok((id, receipt, false)),
                None if !holding => {
                    return Err(Error::Conflict("request_id already has different content"));
                }
                None if Instant::now() > deadline => return Err(Error::Conflict(SWITCHING)),
                None => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        }
    }

    /// Waits until the new agent started, then hands the website the new session (#237). An agent that doesn't start
    /// ends the switch, and the old session takes work again. True while the website hasn't answered yet.
    async fn land_continue(self: &Arc<Self>, from: String, id: String) -> Result<bool> {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let state = self
                .local
                .lock()
                .unwrap()
                .sessions
                .get(&id)
                .map(|s| s.state.clone());
            let failure = match state {
                Some(SessionState::Idle) => break,
                Some(SessionState::Failed | SessionState::ProcessLost | SessionState::Closed)
                | None => "the new agent couldn't start in Cloud, so this thread wasn't changed",
                _ if Instant::now() > deadline => {
                    "the new agent didn't start within a minute, so this thread wasn't changed"
                }
                _ => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
            };
            self.settle_continue(&from, &id, false);
            return Err(Error::Conflict(failure));
        }
        let pending = self
            .finish_continue(from.clone(), id.clone(), CONTINUE_WAIT)
            .await?;
        if pending {
            self.keep_finishing(from, id);
        }
        Ok(pending)
    }

    /// Hands the website the new session, then closes the old one (#237). The website applies it once, and a retry
    /// whose answer got lost is a success too. Core closes the new session only when the website certainly didn't
    /// take it (409: the thread is on a third session). Without an answer it keeps trying after `wait`: true then.
    async fn finish_continue(
        self: &Arc<Self>,
        from: String,
        id: String,
        wait: Duration,
    ) -> Result<bool> {
        let Some(api) = self.history.api.clone() else {
            self.settle_continue(&from, &id, true);
            return Ok(false);
        };
        let body = {
            let local = self.local.lock().unwrap();
            let s = local.sessions.get(&id).ok_or(Error::NotFound)?;
            let request: String = format!("continue_{}", id.trim_start_matches("cr_"))
                .chars()
                .take(64)
                .collect();
            // Followers get the new agent's settings from the row: Pi's model with its provider, and the effort.
            let model = match (&s.provider, &s.model) {
                (Some(provider), Some(model)) if s.harness == runtime::Kind::Pi => {
                    Some(format!("{provider}/{model}"))
                }
                _ => s.model.clone(),
            };
            json!({"request_id":request,"session":from,"wake":self.wake_id(),"continue":{"session":id,"harness":s.harness,"model":model,"reasoning":s.reasoning}})
        };
        let started = Instant::now();
        let mut pause = Duration::from_secs(2);
        loop {
            match api.post("thread", &body).await {
                Ok(_) => {
                    self.settle_continue(&from, &id, true);
                    return Ok(false);
                }
                Err(history::ApiError::Status(400 | 403 | 404 | 409 | 410, _)) => {
                    self.settle_continue(&from, &id, false);
                    return Err(Error::Conflict(
                        "this thread moved to another session meanwhile, so it wasn't switched",
                    ));
                }
                Err(_) if started.elapsed() < wait && !self.is_stopping() => {
                    tokio::time::sleep(pause).await;
                    pause = (pause * 2).min(Duration::from_secs(60));
                }
                Err(_) => return Ok(true),
            }
        }
    }

    /// Keeps handing the website a switch it hasn't answered yet, until it does (#237).
    fn keep_finishing(self: &Arc<Self>, from: String, id: String) {
        let manager = self.clone();
        tokio::spawn(async move {
            while !manager.is_stopping()
                && manager
                    .finish_continue(from.clone(), id.clone(), Duration::from_secs(600))
                    .await
                    .unwrap_or(false)
            {}
        });
    }

    /// Ends a switch: the website `taken` the new session (the old one closes and its plan-limit resume loop goes),
    /// or not (the new one closes). Either way the old session takes work again.
    fn settle_continue(self: &Arc<Self>, from: &str, id: &str, taken: bool) {
        {
            let mut local = self.local.lock().unwrap();
            if !local
                .sessions
                .get(from)
                .is_some_and(|s| s.continuing.as_deref() == Some(id))
            {
                return;
            }
            let _ = local.append(from, "continuing", json!({"session":null}), None);
            if taken && let Some(s) = local.sessions.get_mut(from) {
                s.resume_spent.extend(s.resume_loop.take());
            }
        }
        if taken {
            let _ = self.command(from, random_request(), "close", json!({}));
        } else {
            self.close_when_started(id.to_owned());
        }
    }

    /// Closes a new session a switch gave up on, once it can be: Core refuses a close while a session starts (#237).
    fn close_when_started(self: &Arc<Self>, id: String) {
        let manager = self.clone();
        tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(120);
            while Instant::now() < deadline && !manager.is_stopping() {
                // Read first: the lock must be free again before the close takes it.
                let state = manager
                    .local
                    .lock()
                    .unwrap()
                    .sessions
                    .get(&id)
                    .map(|s| s.state.clone());
                let closed = match state {
                    None
                    | Some(
                        SessionState::Closing
                        | SessionState::Closed
                        | SessionState::Failed
                        | SessionState::ProcessLost,
                    ) => true,
                    Some(
                        SessionState::Pending | SessionState::Starting | SessionState::Resuming,
                    ) => false,
                    Some(_) => manager
                        .command(&id, random_request(), "close", json!({}))
                        .is_ok(),
                };
                if closed {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        });
    }

    /// Switches a restart cut off go on (#237): one whose new session never started is released.
    fn resume_continues(self: &Arc<Self>, local: &Local) {
        for s in local.sessions.values() {
            let Some(id) = s.continuing.clone() else {
                continue;
            };
            let (manager, from) = (self.clone(), s.session_id.clone());
            // Core hands the website a switch only once its new agent started, so one whose new session started (its
            // start receipt completed) and was set up may be the website's already: only the website's answer decides.
            // Any other never reached the website, and the switch didn't happen.
            let ready = local.sessions.get(&id).is_some_and(|c| {
                c.continued.is_some()
                    && c.receipts
                        .values()
                        .any(|r| r.command == "start" && r.state == "completed")
            });
            if ready {
                manager.keep_finishing(from, id);
            } else {
                tokio::spawn(async move { manager.settle_continue(&from, &id, false) });
            }
        }
    }

    /// The conversation so far as Markdown, from Core's own records, in the order it ran (#237): each turn's prompt in
    /// its latest edit, then its reply text (Codex's reply pieces name no request, so they go to the turn running when
    /// they came), steers where they landed, no tool output, and nothing a rewind replaced. Cancelled or failed prompts
    /// never ran, so they never show. The history an earlier switch handed `from` comes first. Newest kept within
    /// HISTORY_CHARS, plus the latest few within TAIL_CHARS for the note. None for a session that never had a message.
    async fn history_markdown(
        &self,
        from: &str,
        earlier: Option<&Value>,
    ) -> Option<(String, String)> {
        let (prompts, receipts) = {
            let local = self.local.lock().unwrap();
            let s = local.sessions.get(from)?;
            (s.prompts.clone(), s.receipts.clone())
        };
        let text_of = |request: &str| {
            let input = prompts
                .get(request)
                .map(|p| &p.input)
                .or_else(|| receipts.get(request).map(|r| &r.input));
            visible_text(input.and_then(|i| i["text"].as_str()).unwrap_or_default())
        };
        // (who, turn, text): a turn is the request whose turn it was, so a rewind cuts whole turns.
        let mut entries: Vec<(&str, String, String)> = Vec::new();
        let (mut after, mut active, mut item) = (0, String::new(), String::new());
        let (mut started, mut checkpoints) = (
            std::collections::HashSet::new(),
            std::collections::HashMap::new(),
        );
        while let Ok(records) = self.records(from, after).await {
            let Some(last) = records.last() else { break };
            after = last.sequence;
            for r in &records {
                let request = r.data["request_id"].as_str().unwrap_or_default();
                match r.kind.as_str() {
                    "state"
                        if !request.is_empty()
                            && matches!(
                                r.data["state"].as_str(),
                                Some("starting_turn" | "running")
                            ) =>
                    {
                        active = request.to_owned();
                        let text = text_of(request);
                        if started.insert(active.clone())
                            && prompts.contains_key(request)
                            && !text.is_empty()
                        {
                            entries.push(("You", active.clone(), text));
                        }
                    }
                    "receipt"
                        if r.data["command"] == "steer"
                            && r.data["state"] == "accepted"
                            && started.insert(request.to_owned()) =>
                    {
                        let text =
                            visible_text(r.data["input"]["text"].as_str().unwrap_or_default());
                        if !text.is_empty() {
                            entries.push(("You", active.clone(), text));
                        }
                    }
                    "checkpoint" => {
                        if let Some(id) = r.data["id"].as_str() {
                            checkpoints.insert(id.to_owned(), request.to_owned());
                        }
                    }
                    "rewind" => {
                        // `before`: that turn and every later one were replaced; `last_turn_id`: the ones after it.
                        let Some(rewind) = receipts.get(request) else {
                            continue;
                        };
                        let (turn, keep) = match rewind.input["before"].as_str() {
                            Some(turn) => (turn, false),
                            None => (
                                rewind.input["last_turn_id"].as_str().unwrap_or_default(),
                                true,
                            ),
                        };
                        if let Some(cut) = checkpoints.get(turn) {
                            let at = if keep {
                                entries
                                    .iter()
                                    .rposition(|(_, turn, _)| turn == cut)
                                    .map(|i| i + 1)
                            } else {
                                entries.iter().position(|(_, turn, _)| turn == cut)
                            };
                            entries.truncate(at.unwrap_or(entries.len()));
                        }
                    }
                    "text_delta" => {
                        let Some(delta) = r.data["delta"].as_str() else {
                            continue;
                        };
                        let turn = if request.is_empty() {
                            active.clone()
                        } else {
                            request.to_owned()
                        };
                        let id = r.data["item_id"].as_str().unwrap_or_default();
                        match entries.last_mut() {
                            Some(("Agent", last, text)) if *last == turn => {
                                if id != item {
                                    text.push_str("\n\n");
                                }
                                text.push_str(delta);
                            }
                            _ => entries.push(("Agent", turn, delta.to_owned())),
                        }
                        item = id.to_owned();
                    }
                    _ => {}
                }
            }
        }
        // The earlier history's own messages, so the bounds below apply to each, not to the whole file.
        // From Core's own copy (prompt::save_history), never the file in the agent's folder.
        let before: Vec<String> = earlier
            .and_then(|_| prompt::saved_history(&self.config.state_dir, from))
            .map(|text| {
                text.trim_start_matches("# Conversation so far")
                    .trim()
                    .split("\n\n## ")
                    .filter(|b| !b.trim().is_empty())
                    .map(|b| {
                        if b.starts_with("## ") {
                            b.to_owned()
                        } else {
                            format!("## {b}")
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        if entries.is_empty() && before.is_empty() {
            return None;
        }
        let blocks: Vec<String> = before
            .into_iter()
            .chain(
                entries
                    .iter()
                    .map(|(who, _, text)| format!("## {who}\n\n{}", text.trim())),
            )
            .collect();
        // Newest first until the limit; a single block longer than what's left keeps its end.
        let fit = |limit: usize| {
            let (mut kept, mut size) = (Vec::new(), 0);
            for block in blocks.iter().rev() {
                if size + block.len() <= limit {
                    size += block.len() + 2;
                    kept.push(block.clone());
                    continue;
                }
                if kept.is_empty() {
                    let room = limit.saturating_sub(5);
                    let mut cut = block.len() - room.min(block.len());
                    while !block.is_char_boundary(cut) {
                        cut += 1;
                    }
                    kept.push(format!("…{}", &block[cut..]));
                }
                break;
            }
            kept.reverse();
            kept.join("\n\n")
        };
        Some((
            format!("# Conversation so far\n\n{}\n", fit(HISTORY_CHARS)),
            fit(TAIL_CHARS),
        ))
    }

    async fn launch(self: Arc<Self>, id: String, request: String) {
        let started = Instant::now();
        let Ok(_startup) = self.startups.acquire().await else {
            return;
        };
        let workspace = loop {
            let workspace = {
                let local = self.local.lock().unwrap();
                let session = &local.sessions[&id];
                if self.is_stopping() || session.close_request.is_some() {
                    return;
                }
                session.workspace.clone()
            };
            if !self.storage.blocks() {
                break workspace;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        };
        if self.is_stopping() {
            return;
        }
        let mut failure_reason = "Cloud folder could not be opened or created; check its permissions, symlinks, and available disk space";
        let result = async {
            let workspace = workspace.ok_or_else(|| io::Error::other("session workspace missing"))?;
            self.workspaces.ensure_directory(&workspace).await?;
            failure_reason = "The harness could not prepare its shared service";
            let kind = self.local.lock().unwrap().sessions[&id].harness;
            runtime::prepare(&self.config, kind, &self.storage).await?;
            failure_reason = "Harness initialization failed; inspect native history and protected local harness diagnostics for this session";
            let fork;
            let (handle, events) = {
                let mut local = self.local.lock().unwrap();
                if self.is_stopping() {
                    return Err(io::Error::other("service is stopping"));
                }
                if local.sessions[&id].close_request.is_some() { return Ok(()); }
                let session = &local.sessions[&id];
                let mut config = self.config.clone();
                failure_reason = "The selected harness is no longer configured";
                let profile = config.harnesses.get_mut(&session.harness)
                    .ok_or_else(|| io::Error::other(failure_reason))?;
                if let Some(model) = &session.model { profile.model = model.clone(); }
                if let Some(provider) = &session.provider { profile.provider = Some(provider.clone()); }
                failure_reason = "Harness initialization failed; inspect native history and protected local harness diagnostics for this session";
                config.repository = session.workspace.as_ref().ok_or_else(|| io::Error::other("session workspace missing"))?.path.canonicalize()?;
                let (kind, reasoning) = (session.harness, session.reasoning.clone());
                let command_guard_enabled = session.command_guard_enabled();
                let strip_ai_co_authors = session.strip_ai_co_authors();
                let system_prompt = session.system_prompt();
                failure_reason = "The side chat's source conversation could not be copied";
                fork = children::fork_history(&local, &id, &request)?;
                failure_reason = "Harness initialization failed; inspect native history and protected local harness diagnostics for this session";
                // Claim before spawning: a crash after this point must not repeat uncertain execution.
                local.append(&id, "state", json!({"state":SessionState::Starting}), None)?;
                let (handle, events) = match &fork {
                    Some(fork) => runtime::Handle::spawn_fork(&config, kind, fork, command_guard_enabled, strip_ai_co_authors, system_prompt)?,
                    None => runtime::Handle::spawn_guarded(&config, kind, None, command_guard_enabled, strip_ai_co_authors, system_prompt)?,
                };
                let handle = handle.with_reasoning(reasoning);
                let pid = handle.pid();
                local.sessions.get_mut(&id).unwrap().handle = Some(handle.clone());
                local.append(&id, "harness", json!({"pid":pid}), None)?;
                (handle, events)
            };
            self.watch_events(id.clone(), handle.clone(), events);
            let native = match &fork {
                Some(fork) => handle.start_fork(fork).await?,
                None => handle.start_session().await?,
            };
            let mut local = self.local.lock().unwrap();
            self.remember_launch_reasoning(&mut local, &id, &handle)?;
            local.append(&id, "native_identity", handle.native_identity(&native)?, None)?;
            if local.sessions[&id].handle.is_none() {
                return Err(io::Error::other("harness exited during initialization"));
            }
            local.sessions.get_mut(&id).unwrap().ready = true;
            local.sessions.get_mut(&id).unwrap().awaken();
            local.append(&id, "state", json!({"state":SessionState::Idle}), None)?;
            local
                .finish_receipt(&id, &request, "completed")
                .map_err(|_| io::Error::other("cannot record startup"))?;
            // A stop accepted before the first harness existed only pauses the queue.
            let stops: Vec<_> = local.sessions[&id].receipts.values()
                .filter(|r| r.command == "stop" && r.state == "accepted")
                .map(|r| r.request_id.clone()).collect();
            for stop in stops {
                local.finish_receipt(&id, &stop, "completed")
                    .map_err(|_| io::Error::other("cannot record startup stop"))?;
            }
            self.advance(&mut local, &id, true);
            Ok::<_, io::Error>(())
        }
        .await;
        self.observability.record(Signal::AgentStart {
            session_id: id.clone(),
            success: result.is_ok(),
            duration_ms: elapsed_ms(started),
        });
        if let Err(error) = &result {
            let cause = error.to_string();
            let reason = if cause == failure_reason {
                cause
            } else {
                format!("{failure_reason}. Cause: {cause}")
            };
            let mut local = self.local.lock().unwrap();
            let _ = local.append(
                &id,
                "state",
                json!({"state":SessionState::Failed,"reason":reason}),
                None,
            );
            // The receipts keep the cause too, so a parent's report says why (ADR 0123); the state goes
            // first, so the app shows the same error once.
            let _ = local.finish_receipt_with(&id, &request, "failed", Some(reason.clone()));
            let _ = local.fail_pending_because(&id, Some(&reason));
            if let Some(handle) = local.sessions[&id].handle.as_ref() {
                handle.request_shutdown();
            }
        }
    }

    pub fn known_request(&self, id: &str, request: &str) -> bool {
        self.local
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .is_some_and(|session| session.receipts.contains_key(request))
    }

    pub fn receipt(&self, id: &str, request: &str) -> Option<Receipt> {
        self.local
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .and_then(|session| session.receipts.get(request))
            .cloned()
    }

    pub fn command(
        self: &Arc<Self>,
        id: &str,
        request: String,
        command: &str,
        input: Value,
    ) -> Result<Receipt> {
        self.command_held(id, request, command, input, false)
    }

    /// `held`: a related thread's message, which may join a queue that a landing Stop already paused. It waits there
    /// for the user, as in Local threads (docs/scopes/queue.md, #982).
    pub(crate) fn command_held(
        self: &Arc<Self>,
        id: &str,
        request: String,
        command: &str,
        input: Value,
        held: bool,
    ) -> Result<Receipt> {
        self.command_from(id, request, command, input, held, None)
    }

    /// `thread tell`'s commands: `sender` must still reach `id` when the command is accepted, under the same lock,
    /// since a session continued from a lost one loses its children if that one resumes meanwhile (#1296).
    pub(crate) fn command_from(
        self: &Arc<Self>,
        id: &str,
        request: String,
        command: &str,
        input: Value,
        held: bool,
        sender: Option<&str>,
    ) -> Result<Receipt> {
        enum Next {
            None,
            Deliver(runtime::Handle, String),
            Interrupt(runtime::Handle, String),
            Steer(runtime::Handle, String, String),
            Compact(runtime::Handle, String),
            Goal(runtime::Handle, Value, String),
            Rewind(runtime::Handle, Value, String),
            Close(Option<runtime::Handle>),
            Resume,
        }
        let (receipt, next) = {
            let mut local = self.local.lock().unwrap();
            let session = local.sessions.get(id).ok_or(Error::NotFound)?;
            if let Some(receipt) = Self::retry(session, &request, command, &input)? {
                return Ok(receipt);
            }
            if sender.is_some_and(|sender| children::may_tell(&local, sender, id).is_none()) {
                return Err(Error::Conflict(children::NOT_IN_TREE));
            }
            if !local.journal.writable() {
                return Err(Error::Storage(JOURNAL_UNWRITABLE.into()));
            }
            if self.is_stopping() {
                return Err(Error::Conflict("service is stopping"));
            }
            // An agent switch holds the old session, and Teleport to Local freezes it: no client changes it meanwhile
            // (#237). Stopping, sleeping and closing still work.
            if !matches!(command, "stop" | "sleep" | "close" | "interrupt") {
                if session.continuing.is_some() {
                    return Err(Error::Conflict(SWITCHING));
                }
                if session
                    .frozen
                    .as_ref()
                    .is_some_and(|(_, until)| *until > now_ms())
                {
                    return Err(Error::Conflict(MOVING));
                }
            }
            // A resume prompt runs only from the current limit's own loop, while that limit still stops the thread:
            // a retired loop's run, or one sent after the user moved on or stopped it, is refused (accounts.rs).
            if command == "prompt" && !session.resume_accepts(&request, &input) {
                return Err(Error::Conflict(
                    "this thread is no longer stopped by a plan limit",
                ));
            }
            // No guarded prompt is accepted while its harness pays with extra credits; the automatic continuation of a
            // `plan_only` loop run stays `plan_only` (ADR 0292).
            let mut input = input;
            if command == "prompt" && session.plan_only(&input) {
                input["plan_only"] = json!(true);
                if self.on_credits(session.harness) {
                    return Err(Error::Conflict(PLAN_ONLY_REFUSED));
                }
            }
            if command == "sleep" {
                return self.request_sleep(&mut local, id, request, input);
            }
            if local.draining && !matches!(command, "interrupt" | "close" | "stop" | "cancel") {
                return Err(Error::Conflict("service is draining"));
            }
            // The app retries this answer until the harness is back.
            if matches!(command, "compact" | "rewind" | "goal")
                && matches!(
                    session.state,
                    SessionState::Sleeping | SessionState::Resuming
                )
            {
                if session.state == SessionState::Sleeping {
                    self.schedule_resume(&mut local, id, false)?;
                }
                return Err(Error::Conflict(
                    "this thread was asleep and is waking up; try again in a few seconds",
                ));
            }
            let session = &local.sessions[id];
            if session.rewind_request.is_some() {
                return Err(Error::Conflict("wait for the pending rewind"));
            }
            let held = held && command == "prompt" && session.queue_paused;
            if session.close_request.is_some()
                || (command != "close" && session.interrupt_pending() && !held)
            {
                return Err(Error::Conflict("wait for the pending close or interrupt"));
            }
            if command == "close" && session.state == SessionState::Starting {
                return Err(Error::Conflict("session is still starting"));
            }
            if !matches!(
                command,
                "prompt"
                    | "interrupt"
                    | "close"
                    | "stop"
                    | "resume"
                    | "edit"
                    | "cancel"
                    | "reorder"
                    | "steer"
                    | "compact"
                    | "goal"
                    | "rewind"
                    | "attach"
                    | "model"
            ) {
                return Err(Error::Conflict("unsupported command"));
            }
            let handle = session.handle.clone();
            // An explicit resume restarts a lost agent from its intact saved chat: a failed startup, or a crash
            // after its one automatic recovery (#154).
            let retry_lost = command == "resume"
                && session.state == SessionState::ProcessLost
                && session.current_request.is_none()
                && handle.is_none()
                && session.harness_pid.is_none();
            if retry_lost && self.recovery_check(session)["status"] != "ready" {
                return Err(Error::Conflict(
                    "saved conversation is unavailable; inspect session recovery before retrying",
                ));
            }
            // A model pick needs no agent, so it can rescue one that lost its agent to its model.
            if matches!(
                session.state,
                SessionState::Closed | SessionState::ProcessLost | SessionState::Failed
            ) && !retry_lost
                && !(command == "model" && session.state != SessionState::Closed)
            {
                return Err(Error::Conflict(
                    "process unavailable; history does not restore execution",
                ));
            }
            // A prompt starts its native turn immediately only when the harness is
            // idle with nothing queued; otherwise it is accepted and queued in order.
            if command == "prompt" && self.storage.blocks() {
                return Err(Error::Conflict("storage unsafe; new execution is blocked"));
            }
            if command == "interrupt" && session.storage_paused {
                return Err(Error::Conflict(
                    "workload is paused for storage; close it or wait for recovery",
                ));
            }
            if matches!(command, "edit" | "cancel") {
                let target = input["target_request_id"].as_str().unwrap_or_default();
                let cancelled = session
                    .prompts
                    .get(target)
                    .is_some_and(|prompt| prompt.cancelled);
                if target.is_empty() {
                    return Err(Error::Conflict("queued message is no longer pending"));
                }
                if command == "edit" || !cancelled {
                    if !session.queue.contains(&target.to_owned()) {
                        return Err(Error::Conflict("queued message is no longer pending"));
                    }
                    if session.current_request.as_deref() == Some(target) {
                        return Err(Error::Conflict("queued message is already being sent"));
                    }
                }
                if command == "edit" && cancelled {
                    return Err(Error::Conflict("queued message is no longer pending"));
                }
                if command == "edit" {
                    let expected = input["expected_revision"].as_u64().unwrap_or(0);
                    let current = session
                        .prompts
                        .get(target)
                        .map(|prompt| prompt.revision)
                        .unwrap_or(1);
                    if expected != current {
                        return Err(Error::Conflict(
                            "queued message changed since editing began",
                        ));
                    }
                }
            }
            if command == "steer"
                && (!session.ready
                    || handle.is_none()
                    || session.current_request.as_deref() != input["target_request_id"].as_str())
            {
                return Err(Error::Conflict(
                    "steer target is no longer the active request",
                ));
            }
            if matches!(command, "compact" | "rewind" | "steer" | "goal")
                && session.capabilities[command] == false
            {
                return Err(Error::Conflict("operation is unsupported by this harness"));
            }
            if command == "compact" {
                if session.compacting {
                    return Err(Error::Conflict("compaction is already running"));
                }
                if session.current_request.is_some()
                    || !matches!(session.state, SessionState::Idle | SessionState::Failed)
                {
                    return Err(Error::Conflict(
                        "context can only be compacted while the thread is idle",
                    ));
                }
                if !session.ready || handle.is_none() {
                    return Err(Error::Conflict("harness is not ready for compaction"));
                }
            }
            if command == "goal" && (!session.ready || handle.is_none()) {
                return Err(Error::Conflict(
                    "the agent is starting; try again in a few seconds",
                ));
            }
            if command == "rewind" {
                if local.sessions.values().any(|child| {
                    child.parent_session.as_deref() == Some(id)
                        && (child.current_request.is_some()
                            || !child.queue.is_empty()
                            || matches!(
                                child.state,
                                SessionState::Pending
                                    | SessionState::Starting
                                    | SessionState::Resuming
                                    | SessionState::WaitingForFiles
                            ))
                }) {
                    return Err(Error::Conflict(
                        "wait for child agents before editing a message",
                    ));
                }
                // A fork (a new Cloud thread from another's conversation) may copy the whole conversation.
                if input["fork"] != true
                    && input["before"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .is_none()
                    && input["last_turn_id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .is_none()
                {
                    return Err(Error::Conflict("a native rewind checkpoint is required"));
                }
                if let Some(replacement) = input.get("replacement") {
                    let key = replacement["request_id"]
                        .as_str()
                        .ok_or(Error::Conflict("replacement request ID required"))?;
                    if key == request || session.receipts.contains_key(key) {
                        return Err(Error::Conflict("replacement request ID already exists"));
                    }
                }
                if session.compacting {
                    return Err(Error::Conflict("wait for compaction"));
                }
                if !session.queue.is_empty() {
                    return Err(Error::Conflict(
                        "send or remove queued messages before editing a message",
                    ));
                }
                if session.current_request.is_some()
                    || !matches!(session.state, SessionState::Idle | SessionState::Failed)
                {
                    return Err(Error::Conflict(
                        "wait for the active turn to finish before editing a sent message",
                    ));
                }
                if !session.ready || handle.is_none() {
                    return Err(Error::Conflict("harness is not ready to rewind"));
                }
            }
            let deliver_now = command == "prompt"
                && session.ready
                && session.state == SessionState::Idle
                && !session.queue_paused
                && !session.compacting
                && session.queue.is_empty();
            if command == "interrupt"
                && (!session.ready
                    || handle.is_none()
                    || session.current_request.as_deref() != input["target_request_id"].as_str())
            {
                return Err(Error::Conflict(
                    "interrupt target is no longer the active request",
                ));
            }
            let target = session.current_request.clone();
            let deliver_now = deliver_now && !self.sleep_for_login(&mut local, id);
            let receipt = Receipt {
                request_id: request.clone(),
                command: command.into(),
                input: input.clone(),
                state: "accepted".into(),
                model: None,
                provider: None,
                workspace: None,
                error: None,
            };
            local.append(
                id,
                "receipt",
                serde_json::to_value(&receipt).map_err(io::Error::other)?,
                None,
            )?;
            if command == "resume" {
                local.drop_pending_sleep(id)?;
            }
            let next = match command {
                "prompt" if deliver_now => {
                    self.begin_turn(&mut local, id, &request)?;
                    Next::Deliver(handle.expect("ready harness"), request.clone())
                }
                "prompt" => {
                    self.wake(&mut local, id)?;
                    Next::None
                }
                "edit" | "cancel" | "reorder" | "attach" | "model" => {
                    local.finish_receipt(id, &request, "completed")?;
                    Next::None
                }
                "resume" if retry_lost => {
                    self.schedule_resume(&mut local, id, false)?;
                    Next::None
                }
                "resume" => {
                    local.finish_receipt(id, &request, "completed")?;
                    Next::Resume
                }
                "stop" if target.is_none() || handle.is_none() => {
                    local.finish_receipt(id, &request, "completed")?;
                    Next::None
                }
                "steer" => Next::Steer(
                    handle.expect("validated live steer target"),
                    input["target_request_id"]
                        .as_str()
                        .expect("validated steer target")
                        .to_owned(),
                    request.clone(),
                ),
                "compact" => {
                    local.append(id, "state", json!({"state":SessionState::Running}), None)?;
                    Next::Compact(handle.expect("validated compact harness"), request.clone())
                }
                "goal" => Next::Goal(
                    handle.expect("validated goal harness"),
                    input,
                    request.clone(),
                ),
                "rewind" => Next::Rewind(
                    handle.expect("validated rewind harness"),
                    input,
                    request.clone(),
                ),
                "close" => {
                    let session = &local.sessions[id];
                    let data = json!({"state":SessionState::Closing,"request_id":session.current_request,"turn_id":session.current_turn});
                    local.append(id, "state", data, None)?;
                    local.fail_pending(id)?;
                    if handle.is_none() {
                        local.append(id, "state", json!({"state":SessionState::Closed}), None)?;
                        local.finish_receipt(id, &request, "completed")?;
                    }
                    Next::Close(handle)
                }
                _ => Next::Interrupt(
                    handle.expect("validated live interrupt target"),
                    target.expect("validated target"),
                ),
            };
            (receipt, next)
        };
        match next {
            Next::None => {}
            Next::Resume => self.advance(&mut self.local.lock().unwrap(), id, false),
            Next::Close(handle) => {
                if let Some(handle) = handle {
                    handle.request_shutdown();
                }
            }
            Next::Deliver(handle, request) => self.clone().deliver(id.to_owned(), request, handle),
            Next::Steer(handle, target, request) => {
                self.clone().steer(id.to_owned(), request, target, handle)
            }
            Next::Compact(handle, request) => self.clone().compact(id.to_owned(), request, handle),
            Next::Goal(handle, input, request) => {
                let manager = self.clone();
                let id = id.to_owned();
                tokio::spawn(async move {
                    let result = handle.goal(&input).await;
                    let mut local = manager.local.lock().unwrap();
                    if let Err(error) = &result
                        && let Some(receipt) = local
                            .sessions
                            .get_mut(&id)
                            .and_then(|session| session.receipts.get_mut(&request))
                    {
                        receipt.error = Some(error.to_string());
                    }
                    let state = if result.is_ok() {
                        "completed"
                    } else {
                        "failed"
                    };
                    let _ = local.finish_receipt(&id, &request, state);
                });
            }
            Next::Rewind(handle, input, request) => {
                self.clone().rewind(id.to_owned(), request, input, handle)
            }
            Next::Interrupt(handle, target) => {
                let manager = self.clone();
                let id = id.to_owned();
                tokio::spawn(async move {
                    let result = handle.interrupt(&target).await;
                    let state = match &result {
                        Ok(_) => "completed",
                        Err(e) if e.kind() == io::ErrorKind::InvalidInput => "failed",
                        Err(_) => "unknown",
                    };
                    let mut local = manager.local.lock().unwrap();
                    if !local.sessions[&id]
                        .handle
                        .as_ref()
                        .is_some_and(|current| current.same_process(&handle))
                    {
                        return;
                    }
                    let _ = local.finish_receipt(&id, &request, state);
                    // A settled interrupt returns the session to idle or the next turn.
                    if matches!(state, "completed" | "failed") {
                        manager.advance(&mut local, &id, false);
                    }
                });
            }
        }
        Ok(receipt)
    }

    /// Pi's process keeps the last thinking level. Remember the level it started with
    /// so a later message that omits reasoning can put that default back.
    fn remember_launch_reasoning(
        &self,
        local: &mut Local,
        id: &str,
        handle: &runtime::Handle,
    ) -> io::Result<()> {
        if local.sessions[id].reasoning.is_some() {
            return Ok(());
        }
        let Some(level) = handle.launch_baseline() else {
            return Ok(());
        };
        local.append(id, "launch_reasoning", json!({"reasoning": level}), None)?;
        Ok(())
    }

    /// Record the start of a queued or immediate turn; dequeues the request. A paused browser resumes first (#610).
    fn begin_turn(&self, local: &mut Local, id: &str, request: &str) -> io::Result<()> {
        local.browser_turn();
        local.append(
            id,
            "state",
            json!({"state":SessionState::StartingTurn,"request_id":request}),
            None,
        )?;
        Ok(())
    }

    /// Deliver one prompt to the harness and record the outcome. On rejection the
    /// turn never began, so advance to the next queued prompt.
    fn deliver(self: Arc<Self>, id: String, request: String, handle: runtime::Handle) {
        tokio::spawn(async move {
            let (input, reasoning) = {
                let local = self.local.lock().unwrap();
                let session = &local.sessions[&id];
                let input = prompt::latest(&session.prompts, &session.receipts, &request)
                    .cloned()
                    .unwrap_or_else(|| json!({"text":""}));
                let reasoning = prompt::reasoning(&input).or_else(|| session.reasoning.clone());
                // Every turn runs the session's model, whoever sent it: Claude switches first (`set_model`).
                let mut input = input;
                if let (runtime::Kind::Claude, Some(model)) = (session.harness, &session.model) {
                    input["model"] = json!(model);
                }
                (input, reasoning)
            };
            let (input, notice) = prompt::with_notice(&self.config.state_dir, input);
            // A switched session's first prompt carries the note on its history, whoever sends it (#237).
            let (input, handed) = prompt::with_session_note(&self.config.state_dir, &id, input);
            // The stored handle keeps the launch level. This copy is only for the turn being started.
            let handle = handle.with_reasoning(reasoning);
            let result = async {
                handle.prepare_turn().await?;
                handle.send_prompt(&request, &input).await
            }
            .await;
            if let (Err(_), Some(note)) = (&result, &notice) {
                prompt::put_back_notice(&self.config.state_dir, note);
            }
            if let (Err(_), Some(note)) = (&result, &handed) {
                prompt::add_session_note(&self.config.state_dir, &id, note);
            }
            let state = match &result {
                Ok(_) => "delivered",
                Err(e) if e.kind() == io::ErrorKind::InvalidInput => "failed",
                Err(_) => "unknown",
            };
            let mut local = self.local.lock().unwrap();
            if !local.sessions[&id]
                .handle
                .as_ref()
                .is_some_and(|current| current.same_process(&handle))
            {
                return;
            }
            for warning in result.as_ref().map(Vec::as_slice).unwrap_or_default() {
                let mut data = warning.clone();
                data["request_id"] = json!(request);
                let _ = local.append(&id, "prompt_warning", data, None);
            }
            if let Err(error) = &result
                && let Some(receipt) = local
                    .sessions
                    .get_mut(&id)
                    .and_then(|session| session.receipts.get_mut(&request))
            {
                receipt.error = Some(error.to_string());
            }
            let _ = local.finish_receipt(&id, &request, state);
            if result.is_err_and(|e| e.kind() == io::ErrorKind::InvalidInput)
                && local.sessions.get(&id).is_some_and(|s| {
                    s.current_request.as_deref() == Some(&request) && s.close_request.is_none()
                })
            {
                self.advance(&mut local, &id, true);
            }
        });
    }

    fn steer(
        self: Arc<Self>,
        id: String,
        request: String,
        target: String,
        handle: runtime::Handle,
    ) {
        tokio::spawn(async move {
            let text = {
                let local = self.local.lock().unwrap();
                local.sessions[&id]
                    .receipts
                    .get(&request)
                    .map(|receipt| {
                        receipt.input["text"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned()
                    })
                    .unwrap_or_default()
            };
            let result = handle.steer(&target, &text).await;
            let state = match &result {
                Ok(_) => "completed",
                Err(e) if e.kind() == io::ErrorKind::InvalidInput => "failed",
                Err(_) => "unknown",
            };
            let mut local = self.local.lock().unwrap();
            if !local.sessions[&id]
                .handle
                .as_ref()
                .is_some_and(|current| current.same_process(&handle))
            {
                return;
            }
            if let Err(error) = &result
                && let Some(receipt) = local
                    .sessions
                    .get_mut(&id)
                    .and_then(|session| session.receipts.get_mut(&request))
            {
                receipt.error = Some(error.to_string());
            }
            let _ = local.finish_receipt(&id, &request, state);
        });
    }

    fn compact(self: Arc<Self>, id: String, request: String, handle: runtime::Handle) {
        tokio::spawn(async move {
            let result = handle.compact().await;
            let state = match &result {
                Ok(_) => "delivered",
                Err(e) if e.kind() == io::ErrorKind::InvalidInput => "failed",
                Err(_) => "unknown",
            };
            let mut local = self.local.lock().unwrap();
            if !local.sessions[&id]
                .handle
                .as_ref()
                .is_some_and(|current| current.same_process(&handle))
            {
                return;
            }
            if let Err(error) = &result
                && let Some(receipt) = local
                    .sessions
                    .get_mut(&id)
                    .and_then(|session| session.receipts.get_mut(&request))
                && !matches!(
                    receipt.state.as_str(),
                    "completed" | "failed" | "interrupted"
                )
            {
                receipt.error = Some(error.to_string());
            }
            let _ = local.finish_receipt(&id, &request, state);
            if state == "failed" {
                self.advance(&mut local, &id, false);
            }
        });
    }

    fn rewind(self: Arc<Self>, id: String, request: String, input: Value, handle: runtime::Handle) {
        tokio::spawn(async move {
            let result = self.rewind_native(&id, &request, &input, &handle).await;
            let mut local = self.local.lock().unwrap();
            if !local.sessions[&id]
                .handle
                .as_ref()
                .is_some_and(|current| current.same_process(&handle))
            {
                return;
            }
            match result {
                Ok(_) => {} // The adapter's ordered rewind_ready event commits the identity before capture or dispatch.
                Err(error) if error.kind() == io::ErrorKind::InvalidInput => {
                    if let Some(receipt) = local
                        .sessions
                        .get_mut(&id)
                        .and_then(|session| session.receipts.get_mut(&request))
                    {
                        receipt.error = Some(error.to_string());
                    }
                    let _ = local.finish_receipt(&id, &request, "failed");
                    let _ = local.append(&id, "rewind_failed", json!({"request_id":request}), None);
                }
                Err(error) => {
                    if let Some(receipt) = local
                        .sessions
                        .get_mut(&id)
                        .and_then(|session| session.receipts.get_mut(&request))
                    {
                        receipt.error = Some(error.to_string());
                    }
                    let _ = local.finish_receipt(&id, &request, "unknown");
                }
            }
        });
    }

    async fn rewind_native(
        self: &Arc<Self>,
        id: &str,
        request: &str,
        input: &Value,
        handle: &runtime::Handle,
    ) -> io::Result<Value> {
        let mut config = self.config.clone();
        {
            let local = self.local.lock().unwrap();
            config.repository = local.sessions[id]
                .workspace
                .as_ref()
                .ok_or_else(|| io::Error::other("session workspace missing"))?
                .path
                .canonicalize()?;
        }
        let Some((replacement, events)) = handle.rewind_replacement(&config, input)? else {
            return handle.rewind(input).await;
        };
        let result = async {
            let native = replacement.start_session().await?;
            let path = replacement.native_location()?;
            handle.request_shutdown();
            // Let the original recorder drain before changing its native-history cursor.
            tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    if self.local.lock().unwrap().sessions[id].handle.is_none() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .map_err(|_| {
                io::Error::other("original harness did not finish recording before rewind")
            })?;
            {
                let mut local = self.local.lock().unwrap();
                if self.is_stopping()
                    || local.sessions[id].rewind_request.as_deref() != Some(request)
                {
                    return Err(io::Error::other("rewind ownership changed"));
                }
                local.sessions.get_mut(id).unwrap().handle = Some(replacement.clone());
                local.sessions.get_mut(id).unwrap().ready = true;
                local.sessions.get_mut(id).unwrap().awaken();
                local.append(id, "harness", json!({"pid":replacement.pid()}), None)?;
            }
            self.record_native(
                id,
                &replacement,
                runtime::Event::Record {
                    kind: "rewind_ready",
                    data: json!({"id":native,"path":path,"cursor":{"offset":0}}),
                    native: None,
                },
            )
            .map_err(|_| io::Error::other("could not persist replacement identity"))?;
            self.watch_events(id.to_owned(), replacement.clone(), events);
            Ok(json!({"id":native,"path":path}))
        }
        .await;
        if result.is_err() {
            replacement.request_shutdown();
        }
        result
    }

    /// Move a ready session to its next turn: dispatch the next queued prompt, wait
    /// out a pending interrupt, or return to idle. `turn_ended` bypasses the active
    /// turn guard when the just-finished turn is the reason for advancing.
    fn advance(self: &Arc<Self>, local: &mut Local, id: &str, turn_ended: bool) {
        if local.sessions[id].state == SessionState::Sleeping {
            let _ = self.wake(local, id);
            return;
        }
        let session = &local.sessions[id];
        if session.close_request.is_some()
            || session.rewind_request.is_some()
            || !session.ready
            || self.is_stopping()
        {
            return;
        }
        if !turn_ended && session.current_request.is_some() {
            return; // a turn is still active; wait for its completion
        }
        if session.interrupt_pending() {
            let _ = local.append(
                id,
                "state",
                json!({"state":SessionState::Interrupting}),
                None,
            );
            return;
        }
        if self.storage.blocks()
            || session.storage_paused
            || session.queue_paused
            || session.compacting
        {
            let state = if session.compacting {
                SessionState::Running
            } else {
                SessionState::Idle
            };
            // A stopped queue is the user's call: nothing continues on its own after it.
            if session.queue_paused {
                local.sessions.get_mut(id).unwrap().switched_mid_turn = false;
            }
            let _ = local.append(id, "state", json!({"state":state}), None);
            return;
        }
        // A plan limit stopped this turn on a login the user has since replaced: a switch mid-turn, or one a
        // background job kept the agent awake through. It restarts on the new login now, ending that job, before
        // queued work fails on the old login too. Queued work then runs first, in place of "keep working".
        let replaced = session.switched_mid_turn
            || (turn_ended
                && (session.handle.as_ref()).is_some_and(|h| h.login_changed(&self.config)));
        if replaced && session.usage_limited && session.can_resume() {
            let queued = session.has_work();
            local.sessions.get_mut(id).unwrap().switched_mid_turn = false;
            let _ = local.append(id, "state", json!({"state":SessionState::Idle}), None);
            if queued {
                self.release(local, id);
            } else {
                self.continue_sessions(local, vec![id.to_owned()]);
            }
            return;
        }
        // A queued `plan_only` loop run is checked again right before it starts (ADR 0292).
        if let Some(next) = session.queue.first().cloned()
            && session
                .receipts
                .get(&next)
                .is_some_and(|r| r.input["plan_only"] == true)
            && self.on_credits(session.harness)
        {
            let _ = local.finish_receipt_with(id, &next, "failed", Some(PLAN_ONLY_REFUSED.into()));
            local
                .sessions
                .get_mut(id)
                .unwrap()
                .queue
                .retain(|queued| queued != &next);
            return self.advance(local, id, turn_ended);
        }
        let session = &local.sessions[id];
        if let Some(next) = session.queue.first().cloned()
            && let Some(handle) = session.handle.clone()
            && self.begin_turn(local, id, &next).is_ok()
        {
            self.clone().deliver(id.to_owned(), next, handle);
            return;
        }
        let _ = local.append(id, "state", json!({"state":SessionState::Idle}), None);
        // Kept through queued turns that still worked on the old login; dropped once the session settles.
        local.sessions.get_mut(id).unwrap().switched_mid_turn = false;
    }

    fn snapshot_usage(self: Arc<Self>, id: String, handle: runtime::Handle) {
        tokio::spawn(async move {
            let Ok(Some(usage)) = handle.usage().await else {
                return;
            };
            let mut local = self.local.lock().unwrap();
            if !local.sessions.get(&id).is_some_and(|session| {
                session
                    .handle
                    .as_ref()
                    .is_some_and(|current| current.same_process(&handle))
            }) {
                return;
            }
            if usage["sessionId"]
                .as_str()
                .is_some_and(|native| local.sessions[&id].native_id.as_deref() != Some(native))
            {
                return;
            }
            self.append_usage(&mut local, &id, usage);
        });
    }

    /// Saves a `usage` reading and records the tokens spent since the last one (`tokens` diagnostics).
    fn append_usage(&self, local: &mut Local, id: &str, usage: Value) {
        let spent = local
            .sessions
            .get(id)
            .filter(|session| !session.tokens_restored)
            .and_then(|session| {
                let spent = tokens::Tokens::of(&usage, session.harness)?.since(session.tokens);
                (spent != tokens::Tokens::default()).then(|| Signal::Tokens {
                    harness: session.harness,
                    model: session.model.clone(),
                    child: session.parent_session.is_some(),
                    tokens: spent,
                })
            });
        if local.append(id, "usage", usage, None).is_ok()
            && let Some(spent) = spent
        {
            self.observability.record(spent);
        }
    }

    /// Forward native events into the record path, shutting the harness if recording fails.
    fn watch_events(
        self: &Arc<Self>,
        id: String,
        handle: runtime::Handle,
        mut events: mpsc::Receiver<runtime::Event>,
    ) {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut failed = false;
            while let Some(event) = events.recv().await {
                // After a failed record, only the harness exit still matters: it settles the turn (core #55).
                if failed && !matches!(event, runtime::Event::Exited { .. }) {
                    continue;
                }
                if manager.record_native(&id, &handle, event).is_err() && !failed {
                    failed = true;
                    if let Some(handle) = manager
                        .local
                        .lock()
                        .unwrap()
                        .sessions
                        .get(&id)
                        .and_then(|s| s.handle.clone())
                    {
                        handle.request_shutdown();
                    }
                }
            }
        });
    }

    /// Reconcile the previous service's protected workloads before admitting starts.
    /// Native handshakes then run in the background, keeping reconnects responsive.
    pub async fn restore_all(self: &Arc<Self>) -> io::Result<()> {
        runtime::reconcile(&self.config).await?;
        let mut local = self.local.lock().unwrap();
        let now = now_ms();
        let ids: Vec<_> = local
            .sessions
            .values()
            .filter(|s| s.can_resume() && s.handle.is_none())
            .map(|s| s.session_id.clone())
            .collect();
        for id in ids {
            if local.sessions[&id].restores_awake(now) {
                self.schedule_resume(&mut local, &id, false)
                    .map_err(|_| io::Error::other("cannot save recovery state"))?;
            } else if local.sessions[&id].state != SessionState::Sleeping {
                local.append(&id, "state", json!({"state":SessionState::Sleeping}), None)?;
            }
        }
        for session in local.sessions.values() {
            if let Some(request) = session.waiting_start() {
                let (manager, id) = (self.clone(), session.session_id.clone());
                tokio::spawn(async move {
                    manager.launch(id, request).await;
                });
            }
        }
        self.watch_children(&local);
        self.watch_reports(&local);
        self.watch_thread_reports(&local);
        self.resume_continues(&local);
        self.watch_child_starts(&local);
        Ok(())
    }

    fn schedule_resume(
        self: &Arc<Self>,
        local: &mut Local,
        id: &str,
        recovery: bool,
    ) -> Result<()> {
        // Claim a crash recovery durably before spawning; a failed or interrupted attempt
        // cannot trigger an endless restart loop. Completed turns rearm recovery.
        // Planned resumes (wake, restart, teleport) leave the one crash recovery unused.
        local.append(
            id,
            "state",
            json!({"state":SessionState::Resuming,"recovery":recovery}),
            None,
        )?;
        let (manager, id) = (self.clone(), id.to_owned());
        tokio::spawn(async move {
            manager.relaunch(id).await;
        });
        Ok(())
    }

    async fn relaunch(self: Arc<Self>, id: String) {
        let Ok(_startup) = self.startups.acquire().await else {
            return;
        };
        let result = async {
            loop {
                {
                    let mut local = self.local.lock().unwrap();
                    if local.sessions[&id].close_request.is_some() {
                        return Ok(());
                    }
                    if self.is_stopping() {
                        local.append(
                            &id,
                            "state",
                            json!({"state":SessionState::Suspended}),
                            None,
                        )?;
                        return Ok(());
                    }
                }
                if !self.storage.blocks() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let kind = self.local.lock().unwrap().sessions[&id].harness;
            runtime::prepare(&self.config, kind, &self.storage).await?;
            let previous = self.local.lock().unwrap().sessions[&id].harness_pid;
            if self.config.storage.is_none()
                && let Some(pid) = previous
            {
                runtime::wait_for_exit(pid).await?;
            }
            let (handle, events, native) = {
                let mut local = self.local.lock().unwrap();
                let session = &local.sessions[&id];
                if session.close_request.is_some() || self.is_stopping() {
                    return Ok(());
                }
                let native = session
                    .native_id
                    .clone()
                    .ok_or_else(|| io::Error::other("missing native identity"))?;
                let kind = session.harness;
                let mut saved = session
                    .resume()
                    .ok_or_else(|| io::Error::other("missing native resume state"))?;
                let profile = self
                    .config
                    .harnesses
                    .get(&kind)
                    .ok_or_else(|| io::Error::other("harness not configured"))?;
                // Capture any final orphan writes after ownership reconciliation.
                runtime::recover_records(
                    profile,
                    kind,
                    &saved,
                    self.config.storage.as_ref(),
                    |event| {
                        if let runtime::Event::Record { kind, data, native } = event {
                            local.append(&id, kind, data, native)?;
                        }
                        Ok(())
                    },
                )?;
                saved.cursor = local.sessions[&id].native_cursor.clone();
                let mut config = self.config.clone();
                config.repository = local.sessions[&id]
                    .workspace
                    .as_ref()
                    .ok_or_else(|| io::Error::other("session workspace missing"))?
                    .path
                    .canonicalize()?;
                let (handle, events) = runtime::Handle::spawn_guarded(
                    &config,
                    kind,
                    Some(saved),
                    local.sessions[&id].command_guard_enabled(),
                    local.sessions[&id].strip_ai_co_authors(),
                    local.sessions[&id].system_prompt(),
                )?;
                local.sessions.get_mut(&id).unwrap().handle = Some(handle.clone());
                local.append(&id, "harness", json!({"pid":handle.pid()}), None)?;
                (handle, events, native)
            };
            self.watch_events(id.clone(), handle.clone(), events);
            handle.start_session().await?;
            let mut local = self.local.lock().unwrap();
            self.remember_launch_reasoning(&mut local, &id, &handle)?;
            if local.sessions[&id].close_request.is_some() || self.is_stopping() {
                return Ok(());
            }
            if local.sessions[&id].handle.is_none() {
                return Err(io::Error::other("resumed harness exited"));
            }
            local.sessions.get_mut(&id).unwrap().ready = true;
            local.sessions.get_mut(&id).unwrap().awaken();
            local.append(
                &id,
                "native_identity",
                handle.native_identity(&native)?,
                None,
            )?;
            local.append(&id, "state", json!({"state":SessionState::Idle}), None)?;
            let retries: Vec<_> = local.sessions[&id]
                .receipts
                .values()
                .filter(|r| r.command == "resume" && r.state == "accepted")
                .map(|r| r.request_id.clone())
                .collect();
            for request in retries {
                local
                    .finish_receipt(&id, &request, "completed")
                    .map_err(|_| io::Error::other("cannot record resume outcome"))?;
            }
            if local.sessions[&id].storage_paused {
                local.append(
                    &id,
                    "storage_recovered",
                    json!({"text":"Cloudroom: workload resumed after restart."}),
                    None,
                )?;
            }
            self.advance(&mut local, &id, true);
            Ok::<_, io::Error>(())
        }
        .await;
        if let Err(error) = result {
            if self.is_stopping() {
                return;
            }
            let mut local = self.local.lock().unwrap();
            if local.sessions[&id].close_request.is_none() {
                let check = self.recovery_check(&local.sessions[&id]);
                let (code, reason) = if error.kind() == io::ErrorKind::TimedOut {
                    (
                        "startup_timeout",
                        "Harness startup timed out; saved history and queued prompts are preserved. Retry resume when load settles.",
                    )
                } else if check["status"] == "empty" {
                    (
                        "empty_session",
                        "No saved native conversation exists and no turn was dispatched; nothing can be resumed.",
                    )
                } else if check["status"] == "missing" {
                    (
                        "missing_history",
                        "Saved native conversation is missing; refusing to replace it or replay work.",
                    )
                } else {
                    (
                        "resume_failed",
                        "Native resume failed; inspect native history and protected local harness diagnostics for this session, then retry explicitly after correcting the cause.",
                    )
                };
                let lost = format!("{reason} Cause: {error}");
                let _ = local.append(
                    &id,
                    "state",
                    json!({"state":SessionState::ProcessLost,"reason":lost,"startup_error":code}),
                    None,
                );
                if code != "startup_timeout" {
                    let _ = local.fail_pending_because(&id, Some(&lost));
                }
                let retries: Vec<_> = local.sessions[&id]
                    .receipts
                    .values()
                    .filter(|r| r.command == "resume" && r.state == "accepted")
                    .map(|r| r.request_id.clone())
                    .collect();
                for request in retries {
                    let _ = local.finish_receipt(&id, &request, "failed");
                }
            }
            if let Some(handle) = local.sessions[&id].handle.as_ref() {
                handle.request_shutdown();
            }
        }
    }

    fn record_native(
        self: &Arc<Self>,
        id: &str,
        handle: &runtime::Handle,
        event: runtime::Event,
    ) -> Result<()> {
        let mut local = self.local.lock().unwrap();
        if !local.sessions[id]
            .handle
            .as_ref()
            .is_some_and(|current| current.same_process(handle))
        {
            return Ok(());
        }
        match event {
            runtime::Event::Authentication { accepted } => {
                if local.sessions[id].harness == runtime::Kind::Claude {
                    self.claude_auth.request(accepted, &self.observability);
                }
            }
            runtime::Event::ChildRequest(child) => {
                self.start_child(&mut local, id, handle, child)?;
            }
            runtime::Event::Record {
                kind: "rewind_ready",
                mut data,
                ..
            } => {
                let request = local.sessions[id]
                    .rewind_request
                    .clone()
                    .ok_or(Error::Conflict("unexpected native replacement"))?;
                let input = local.sessions[id].receipts[&request].input.clone();
                data["request_id"] = json!(request);
                data["before"] = input["before"].clone();
                if let Some(replacement) = input.get("replacement") {
                    data["replacement"] = json!(Receipt {
                        request_id: replacement["request_id"]
                            .as_str()
                            .ok_or(Error::Conflict("invalid replacement"))?
                            .into(),
                        command: "prompt".into(),
                        input: replacement["input"].clone(),
                        state: "accepted".into(),
                        model: None,
                        provider: None,
                        workspace: None,
                        error: None,
                    });
                }
                local.append(id, "rewind", data, None)?;
                self.advance(&mut local, id, true);
            }
            runtime::Event::Record {
                kind,
                mut data,
                native,
            } => {
                let usage = data.get("usage").cloned().filter(|value| !value.is_null());
                // An agent still on a login the user has replaced reports that old account, not the saved one.
                let old_login = || {
                    (local.sessions[id].handle.as_ref())
                        .is_some_and(|h| h.login_changed(&self.config))
                };
                // Plan limits and credits (ADR 0292). `plan_ok` only ends holds; it is not history.
                if kind == "plan_ok" {
                    if let Some(harness) = data["harness"].as_str().filter(|_| !old_login()) {
                        self.clear_plan(harness, false);
                    }
                    return Ok(());
                }
                let current = local.sessions[id].current_request.clone();
                // The running turn's guard; the harness's own continuation turns keep the guard of the turn they follow.
                let plan_only = current.is_some() && local.sessions[id].guarded_turn;
                if kind == "usage_limited" && plan_only {
                    data["plan_only"] = json!(true);
                }
                if matches!(kind, "usage_limited" | "plan_credits")
                    && data["model_only"] != true
                    && !old_login()
                {
                    self.report_limit(&data, kind == "plan_credits");
                }
                // A loop run that must not spend extra credits stops at their first sign (ADR 0292).
                if kind == "plan_credits"
                    && plan_only
                    && let Some(request) = current
                    && local.sessions[id].credits_stop.as_ref() != Some(&request)
                {
                    local.sessions.get_mut(id).unwrap().credits_stop = Some(request.clone());
                    self.clone()
                        .stop_for_credits(id.to_owned(), request, handle.clone());
                }
                local.append(id, kind, data, native)?;
                if let Some(usage) = usage {
                    self.append_usage(&mut local, id, usage);
                }
            }
            runtime::Event::Background { running } => {
                local.sessions.get_mut(id).unwrap().background_bash(running);
            }
            runtime::Event::Compacted { status } => {
                if let Some(request) = local.sessions[id].compact_request.clone() {
                    let status = match status.as_str() {
                        "completed" => "completed",
                        "interrupted" => "interrupted",
                        _ => "failed",
                    };
                    if status == "failed" {
                        local
                            .sessions
                            .get_mut(id)
                            .unwrap()
                            .receipts
                            .get_mut(&request)
                            .unwrap()
                            .error = Some("Context compaction failed; see native history".into());
                    }
                    local.finish_receipt(id, &request, status)?;
                    self.clone().snapshot_usage(id.to_owned(), handle.clone());
                    self.advance(&mut local, id, false);
                }
            }
            runtime::Event::Started {
                request,
                native_turn,
                auto,
            } => {
                let session = &local.sessions[id];
                // A turn the harness began itself gets a receipt, so it can finish, stop and recover like a prompt.
                if auto
                    && session.ready
                    && session.current_request.is_none()
                    && session.close_request.is_none()
                    && session.rewind_request.is_none()
                    && !session.compacting
                {
                    let receipt = Receipt {
                        request_id: request.clone(),
                        command: "auto".into(),
                        input: json!({}),
                        state: "running".into(),
                        model: None,
                        provider: None,
                        workspace: None,
                        error: None,
                    };
                    let receipt = serde_json::to_value(receipt).map_err(io::Error::other)?;
                    local.append(id, "receipt", receipt, None)?;
                    self.begin_turn(&mut local, id, &request)?;
                    // A guarded run's own continuation stops at once while its harness is known to be on credits.
                    let session = &local.sessions[id];
                    if session.guarded_turn && self.on_credits(session.harness) {
                        local.sessions.get_mut(id).unwrap().credits_stop = Some(request.clone());
                        self.clone().stop_for_credits(
                            id.to_owned(),
                            request.clone(),
                            handle.clone(),
                        );
                    }
                }
                let session = &local.sessions[id];
                if !session.ready || session.current_request.as_deref() != Some(&request) {
                    return Ok(());
                }
                let state = if session.close_request.is_some() {
                    SessionState::Closing
                } else {
                    SessionState::Running
                };
                let data = json!({"state":state,"request_id":request,"turn_id":native_turn});
                local.append(id, "state", data, None)?;
            }
            runtime::Event::Finished {
                request,
                status,
                mut error,
            } => {
                // Only a loop that will fire may promise a resume time.
                if local.sessions[id].limit_resumes >= accounts::MAX_RESUMES {
                    error = error.map(accounts::unpromise);
                }
                // A `plan_only` turn stopped for extra credits says so, once it really ended without completing.
                if local.sessions[id].credits_stop.as_deref() == Some(&request) {
                    local.sessions.get_mut(id).unwrap().credits_stop = None;
                    if status != "completed" {
                        error = Some(PLAN_ONLY_STOPPED.into());
                    }
                }
                if local.sessions[id].current_request.as_deref() == Some(&request) {
                    let session = &local.sessions[id];
                    let checkpoint = session
                        .current_turn
                        .clone()
                        .map(|turn| json!({"kind":"turn","id":turn,"request_id":request}));
                    if let Some(checkpoint) = checkpoint {
                        let _ = local.append(id, "checkpoint", checkpoint, None);
                    }
                    self.clone().snapshot_usage(id.to_owned(), handle.clone());
                    if let Some(request) = local.sessions[id].current_request.clone() {
                        let session = local.sessions.get(id).ok_or(Error::NotFound)?;
                        if status == "completed"
                            && (session.parent_session.is_some()
                                || session.parent_thread().is_some())
                        {
                            // Saved before the turn completes, so `thread output` and the parent's notice still have
                            // it once the child sleeps or Core restarts (#339).
                            let text = handle.seen_text();
                            children::save_reply(&self.config.state_dir, id, &request, &text);
                            local.append(
                                id,
                                "child_reply",
                                json!({"request_id":request,"text":children::capped_reply(&text)}),
                                None,
                            )?;
                        }
                        local.finish_receipt_with(id, &request, &status, error)?;
                    }
                    self.advance(&mut local, id, true);
                }
            }
            runtime::Event::Exited {
                reason,
                expected,
                cleaned_up,
                details,
            } => {
                // Signal 9 that Core didn't send, with the kernel's OOM kill count up: the sandbox ran out of memory.
                let out_of_memory = details.code.is_none()
                    && details.signal == Some(9)
                    && !details.killed
                    && oom_kills_grew();
                let exit = match (details.code, details.signal) {
                    (Some(code), _) => format!("exit code {code}"),
                    // Core's own kill is signal 9 too; saying so keeps it from reading as out of memory.
                    (None, Some(_)) if details.killed => "stopped by Core".into(),
                    (None, Some(_)) if out_of_memory => "out of memory".into(),
                    (None, Some(signal)) => format!("signal {signal}"),
                    _ => "no exit status".into(),
                };
                let stderr = stderr_tail(details.stderr());
                let cause = details.cause.clone();
                let diagnostic_id = self.observability.agent_exit(
                    Some(id),
                    local.sessions[id].harness,
                    reason,
                    expected,
                    details,
                );
                // An unconfirmed steer dies with its agent: its late answer is dropped (`same_process`). Settling it
                // lets a child notice it carried fall back to the queue, even across a rewind (#1579).
                let steers: Vec<_> = (local.sessions[id].receipts.values())
                    .filter(|r| r.command == "steer" && r.state == "accepted")
                    .map(|r| r.request_id.clone())
                    .collect();
                for request in steers {
                    local.finish_receipt(id, &request, "unknown_after_restart")?;
                }
                if expected && cleaned_up && local.sessions[id].rewind_request.is_some() {
                    let session = local.sessions.get_mut(id).ok_or(Error::NotFound)?;
                    session.handle = None;
                    session.ready = false;
                    local.append(id, "harness", json!({"pid":null}), None)?;
                    return Ok(());
                }
                let session = &local.sessions[id];
                if session.releasing && cleaned_up && session.close_request.is_none() {
                    return self.slept(&mut local, id);
                }
                let session = local.sessions.get_mut(id).ok_or(Error::NotFound)?;
                session.releasing = false;
                let restoring = session.state == SessionState::Resuming
                    && session.native_id.is_some()
                    && session.native_path.is_some();
                let resumable = cleaned_up
                    && ((session.ready && session.can_resume())
                        || (self.is_stopping() && restoring));
                // An archived thread that crashes stays down: nothing waits for it (feedback #614).
                let recover = resumable
                    && !self.is_stopping()
                    && !session.recovery_attempted
                    && !session.archived;
                // Launch already recorded the real cause; stopping its harness must not hide it.
                let failed = session
                    .failure
                    .clone()
                    .filter(|_| session.state == SessionState::Failed);
                session.handle = None;
                session.ready = false;
                let request = session.current_request.clone();
                let close = session.close_request.clone();
                let preserve_queue = session.startup_error.as_deref() == Some("startup_timeout");
                let interrupts: Vec<_> = session
                    .receipts
                    .values()
                    .filter(|r| {
                        matches!(r.command.as_str(), "interrupt" | "stop")
                            && matches!(r.state.as_str(), "accepted" | "delivered" | "unknown")
                    })
                    .map(|r| r.request_id.clone())
                    .collect();
                let lost = failed.clone().unwrap_or_else(|| match &cause {
                    Some(cause) => format!("{reason}: {cause} ({exit})"),
                    None => format!("{reason} ({exit})"),
                });
                if let Some(request) = request {
                    // Keep the cause on the lost turn: an automatic recovery leaves the thread idle and error-free. A
                    // turn stopped for extra credits keeps that reason, so its loop never counts it as a failure.
                    let stopped =
                        local.sessions[id].credits_stop.as_deref() == Some(request.as_str());
                    local.finish_receipt_with(
                        id,
                        &request,
                        if self.is_stopping() || close.is_some() {
                            "unknown"
                        } else {
                            "unknown_after_restart"
                        },
                        if stopped {
                            Some(PLAN_ONLY_STOPPED.into())
                        } else {
                            (!expected).then(|| lost.clone())
                        },
                    )?;
                }
                for request in interrupts {
                    local.finish_receipt(id, &request, "unknown_after_restart")?;
                }
                if cleaned_up {
                    local.append(id, "harness", json!({"pid":null}), None)?;
                }
                let state = if expected && close.is_some() {
                    SessionState::Closed
                } else if resumable && (self.is_stopping() || recover) {
                    SessionState::Suspended
                } else if failed.is_some() {
                    SessionState::Failed
                } else {
                    SessionState::ProcessLost
                };
                let lost_or_failed =
                    matches!(state, SessionState::ProcessLost | SessionState::Failed);
                local.append(
                    id,
                    "state",
                    json!({"state":state,"reason":lost,"diagnostic_id":diagnostic_id,"stderr":(lost_or_failed && !stderr.is_empty()).then_some(stderr),"out_of_memory":out_of_memory.then_some(true)}),
                    None,
                )?;
                if let Some(request) = close {
                    local.finish_receipt(
                        id,
                        &request,
                        if expected { "completed" } else { "unknown" },
                    )?;
                }
                if state != SessionState::Suspended && !preserve_queue {
                    local.fail_pending_because(id, Some(&lost))?;
                }
                local.sessions.get_mut(id).unwrap().credits_stop = None;
                if recover {
                    self.schedule_resume(&mut local, id, true)?;
                }
            }
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.codex_auth.shutdown().await;
        self.claude_auth.shutdown().await;
        self.claude_login.shutdown().await;
        self.cursor_auth.shutdown().await;
        let mut changed = self.subscribe();
        {
            let mut local = self.local.lock().unwrap();
            self.stopping.store(true, Ordering::Relaxed);
            let waiting: Vec<_> = local
                .sessions
                .values()
                .filter(|s| s.state == SessionState::Resuming && s.handle.is_none())
                .map(|s| s.session_id.clone())
                .collect();
            for id in waiting {
                let _ = local.append(&id, "state", json!({"state":SessionState::Suspended}), None);
            }
            // Before the harness cleanup, which may outlast the deadline. Its few records replay next start.
            local.save_snapshot();
            local.changed.send_replace(0);
            // Signal all harnesses together; their recorded Exited events confirm cleanup.
            for handle in local.sessions.values().filter_map(|s| s.handle.as_ref()) {
                handle.request_shutdown();
            }
        }
        let cleanup = async {
            while self
                .local
                .lock()
                .unwrap()
                .sessions
                .values()
                .any(|s| s.handle.is_some())
            {
                if changed.changed().await.is_err() {
                    break;
                }
            }
            runtime::shutdown().await;
            // The harnesses' last records, then diagnostics. A drain already saved the rest; systemd waits 10 s.
            self.flush_history(Duration::from_secs(2), false).await;
            self.observability.shutdown().await;
        };
        if tokio::time::timeout(runtime::SHUTDOWN_GRACE + Duration::from_secs(4), cleanup)
            .await
            .is_err()
        {
            eprintln!("Cloudroom shutdown cleanup deadline reached");
        }
    }
}

/// Last lines of harness stderr, shown under unexpected exits so the cause is visible in chat (ADR 0123).
/// What other clients get while Teleport to Local or an agent switch holds a session (#237).
pub const MOVING: &str = "This thread is moving to a computer. Send it again when that's done.";
pub const SWITCHING: &str = "This thread is switching agents. Send it again in a moment.";
/// A switch waits this long for the website before it answers "pending" and keeps trying (#237).
const CONTINUE_WAIT: Duration = Duration::from_secs(60);
/// How long a Teleport's freeze holds without a renewal (#237).
const FREEZE_MS: u64 = 5 * 60_000;
const HISTORY_FILE: &str = "conversation-history.md";
const HISTORY_CHARS: usize = 4_000_000;
const TAIL_CHARS: usize = 8_000;

/// A prompt's text as the user wrote it: Cloudroom's own instructions in it are left out.
fn visible_text(text: &str) -> String {
    let (mut out, mut rest) = (String::new(), text);
    while let Some(start) = rest.find("<cloudroom_custom_instructions>") {
        out.push_str(&rest[..start]);
        rest = rest[start..]
            .find("</cloudroom_custom_instructions>")
            .map_or("", |end| {
                &rest[start + end + "</cloudroom_custom_instructions>".len()..]
            });
    }
    out.push_str(rest);
    out.trim().to_owned()
}

fn random_request() -> String {
    format!(
        "core_{}",
        thread::random_key().unwrap_or_else(|_| now_ms().to_string())
    )
}

/// A prompt the user sent from an app (`app_…`, or an older app's UUID) or the phone, not Core's own (notices,
/// teleports, children's tasks) or a loop's (#237).
pub(crate) fn user_request(id: &str) -> bool {
    id.starts_with("app_")
        || (id.len() == 36
            && id.as_bytes()[8] == b'-'
            && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
}

fn stderr_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(2000)..]);
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(20)..].join("\n")
}

/// Whether the kernel killed a process in this sandbox for lack of memory since the last check: cgroup v2's
/// `memory.events`, which counts kills from this sandbox's own limit and the whole machine's alike.
fn oom_kills_grew() -> bool {
    static SEEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = std::fs::read_to_string("/sys/fs/cgroup/memory.events")
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("oom_kill "))
                .and_then(|value| value.trim().parse::<u64>().ok())
        })
        .unwrap_or(0);
    SEEN.swap(count, Ordering::Relaxed) < count
}
