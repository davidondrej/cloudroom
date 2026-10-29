//! Harness account logins: Codex, Claude Code, and Cursor, and resuming work a plan limit stopped (ADR 0117).
use super::*;
use crate::runtime::RESUME_WITHIN_MS;
use std::time::{SystemTime, UNIX_EPOCH};

/// Resumes in a row a plan limit gets before the user must step in (provider-retry's rule).
pub(super) const MAX_RESUMES: u32 = 4;
const RESUME_CHECK: Duration = Duration::from_secs(10);
/// A limit Core will not resume at its reset (over 6 hours away, unknown, or 4 resumes used) still gets a loop,
/// saved paused, so only an account switch runs it and wakes the sandbox (web/lib/automations.ts
/// `resumeAfterSwitch`). Its time is a placeholder.
const PAUSED_SECS: u64 = 30 * 24 * 60 * 60;
/// How long a plan limit holds the account's loops when the harness gave no reset time (Pi, some credits).
const LIMIT_HOLD_MS: u64 = 60 * 60 * 1000;
/// A report like the last one sent (same credits, a reset within 10 minutes) waits this long, so a limit with an
/// unknown reset renews the website's one-hour hold without a write on every event.
const REPORT_AGAIN_MS: u64 = 20 * 60 * 1000;
const SAME_RESET_MS: u64 = 10 * 60 * 1000;
const PLAN_FILE: &str = "plan-limits.json";

/// Plan limits, credits and their ends still to be sent to the website (the newest per harness, with a generation so
/// an older one in flight never replaces it), what each harness last sent, until when each harness pays with extra
/// credits (ms), and the login each hold belongs to. Saved in the state folder, so a restart keeps them (ADR 0292).
#[derive(Default, Serialize, Deserialize)]
pub(super) struct PlanState {
    #[serde(default)]
    credits_until: BTreeMap<String, u64>,
    #[serde(default)]
    /// Per harness: (generation, report, the login it was seen with).
    reports: BTreeMap<String, (u64, Value, Option<String>)>,
    #[serde(default)]
    generation: u64,
    /// Per harness: (credits, until, sent at); a cleared harness has until 0.
    #[serde(default)]
    sent: BTreeMap<String, (bool, u64, u64)>,
    /// The login a credits hold was seen with; another login means the hold is not its own.
    #[serde(default)]
    logins: BTreeMap<String, String>,
    /// The Codex limit its login check last saw: (credits, reset ms).
    #[serde(default)]
    pub(super) codex_seen: Option<(bool, Option<u64>)>,
}
impl PlanState {
    pub(super) fn load(dir: &std::path::Path) -> Self {
        std::fs::read(dir.join(PLAN_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }
    fn save(&self, dir: &std::path::Path) {
        let (path, tmp) = (dir.join(PLAN_FILE), dir.join(format!("{PLAN_FILE}.tmp")));
        if let Ok(bytes) = serde_json::to_vec(self)
            && std::fs::write(&tmp, bytes).is_ok()
        {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// A plan-limit error that promised a resume time Core will not keep (4 resumes used): point to a switch instead.
pub(super) fn unpromise(mut error: String) -> String {
    if let Some(start) = error.find("Resumes at ")
        && let Some(end) = error[start..].find("accounts.")
    {
        error.replace_range(
            start..start + end + "accounts.".len(),
            "Switch accounts to keep working.",
        );
    }
    error
}

/// A prompt from a resume loop: the website opens it with the loop's name (web/lib/automations.ts `promptText`).
fn resume_prompt(input: &Value) -> bool {
    input["text"].as_str().is_some_and(|t| {
        t.starts_with("[Cloudroom automation \"Resume after ") && t.contains("plan limit · ")
    })
}

/// Whether `request` is a run of loop `id`: the website names each run `auto_<id without dashes>_<due>`.
pub(super) fn loop_request(id: &str, request: &str) -> bool {
    request.starts_with(&format!("auto_{}_", id.replace('-', "")))
}

/// What this session's resume loop needs on the website.
enum Change {
    /// At this reset, or paused (`None`).
    Create(Option<u64>),
    Delete(String),
}

impl Session {
    /// Whether a prompt is a guarded loop run (ADR 0292): sent with `plan_only`, or a resume prompt inheriting it.
    pub(super) fn plan_only(&self, input: &Value) -> bool {
        input["plan_only"] == true
            || (input.get("plan_only").is_none() && self.resume_plan_only && resume_prompt(input))
    }

    /// A resume prompt runs only from this limit's own loop, while the limit still stops the thread and no newer work
    /// waits. One from a retired or unknown loop, or sent after the thread moved on or was stopped, is refused.
    pub(super) fn resume_accepts(&self, request: &str, input: &Value) -> bool {
        let from_loop = resume_prompt(input)
            || self
                .resume_loop
                .iter()
                .chain(&self.resume_spent)
                .any(|id| loop_request(id, request));
        !from_loop
            || (self.usage_limited
                && !self.queue_paused
                && self.queue.is_empty()
                && self
                    .resume_loop
                    .as_deref()
                    .is_some_and(|id| loop_request(id, request)))
    }

    fn resume_change(&self, now: u64) -> Option<Change> {
        if let Some(id) = self.resume_spent.first() {
            return Some(Change::Delete(id.clone()));
        }
        let stopped = self.usage_limited
            && !self.queue_paused
            && !self.archived
            && self.close_request.is_none()
            && self.state != "closed";
        match &self.resume_loop {
            Some(id) => (!stopped).then(|| Change::Delete(id.clone())),
            None if stopped && !self.resume_refused => {
                Some(Change::Create(self.usage_resets_ms.filter(|at| {
                    self.limit_resumes < MAX_RESUMES && at.saturating_sub(now) <= RESUME_WITHIN_MS
                })))
            }
            None => None,
        }
    }

    /// Names the whole session, so two sessions never share a loop, and the provider, so the website can run a
    /// provider's loops on an account switch.
    fn resume_name(&self) -> String {
        let provider = match self.harness {
            runtime::Kind::Claude => "Claude ",
            runtime::Kind::Codex => "Codex ",
            _ => "",
        };
        format!("Resume after {provider}plan limit · {}", self.session_id)
    }
}

impl Manager {
    pub async fn claude_auth_status(&self) -> runtime::auth::Status {
        self.claude_login.status(&self.config).await
    }

    pub async fn claude_account(
        &self,
        action: &str,
        id: String,
        code: Option<String>,
        state: Option<String>,
    ) -> Result<runtime::auth::Status> {
        if self.is_stopping() {
            return Err(Error::Conflict("service is stopping"));
        }
        Ok(self
            .claude_login
            .action(&self.config, action, id, code, state)
            .await)
    }

    pub fn start_auth_monitor(&self) {
        self.claude_auth.start(&self.config, &self.observability);
    }

    pub async fn codex_auth_status(self: &Arc<Self>) -> runtime::auth::Status {
        let status = self.codex_auth.status(&self.config).await;
        let switched = self.codex_auth.take_switched().await;
        // The old login's limits go first; the new login's status applies before any work continues.
        if switched {
            self.codex_login_changed();
        }
        self.apply_codex_status(&status);
        if switched {
            self.continue_limited(&[runtime::Kind::Codex, runtime::Kind::Pi]);
        }
        status
    }

    /// The login check is where real Codex shows its plan limit and reset (ADR 0292). A failed check says nothing.
    fn apply_codex_status(&self, status: &runtime::auth::Status) {
        if !matches!(status.state, "connected" | "limited") {
            return;
        }
        *self.codex_login.lock().unwrap() = status.email.clone();
        let seen = std::mem::replace(&mut *self.codex_reported.lock().unwrap(), status.limit);
        if seen != status.limit {
            let mut plan = self.plan.lock().unwrap();
            plan.codex_seen = status.limit;
            plan.save(&self.config.state_dir);
        }
        match status.limit {
            Some((credits, resets)) => {
                self.report_limit(&json!({"harness":"codex","resets_at_ms":resets}), credits)
            }
            // Only a limit this check saw ends here: a turn's limit may be another bucket (a model's) than the
            // account-wide one this check reads; it ends with that turn's own signal or its reset.
            None if seen.is_some() => self.clear_plan("codex", false),
            None => {}
        }
    }

    /// A loop run marked `plan_only` never starts while its harness pays with extra credits (ADR 0292). Codex is checked
    /// through its login check (cached up to 15 s, given at most 5 s here); other harnesses by the credits their turns
    /// here last reported.
    pub async fn check_plan_only(self: &Arc<Self>, id: &str, input: &Value) -> Result<()> {
        let Some(harness) = self
            .local
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .filter(|s| s.plan_only(input))
            .map(|s| s.harness)
        else {
            return Ok(());
        };
        if harness == runtime::Kind::Codex {
            let _ = tokio::time::timeout(Duration::from_secs(5), self.codex_auth_status()).await;
        }
        if self.on_credits(harness) {
            return Err(Error::Conflict(super::PLAN_ONLY_REFUSED));
        }
        Ok(())
    }

    /// Whether this harness pays with extra credits now, as its turns and login checks last reported. A hold seen with
    /// another login (a switch while this sandbox slept) is dropped, with that login's unsent report.
    pub(super) fn on_credits(&self, harness: runtime::Kind) -> bool {
        let Some(name) = serde_json::to_value(harness)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
        else {
            return false;
        };
        let login = self.login_of(&name);
        let mut plan = self.plan.lock().unwrap();
        if let (Some(login), Some(held)) = (login, plan.logins.get(&name))
            && login != *held
        {
            plan.credits_until.remove(&name);
            plan.logins.remove(&name);
            plan.reports.remove(&name);
            plan.save(&self.config.state_dir);
            return false;
        }
        plan.credits_until
            .get(&name)
            .is_some_and(|until| *until > now_ms())
    }

    /// The login a harness runs with now, when Core can tell, as a stable hash (FNV-1a), so the login itself is never
    /// saved: Claude Code's login files, Codex's account email.
    fn login_of(&self, harness: &str) -> Option<String> {
        let bytes = match harness {
            "claude-code" => runtime::claude_login(&self.config),
            "codex" => self.codex_login.lock().unwrap().clone()?.into_bytes(),
            _ => return None,
        };
        let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
        });
        Some(format!("{hash:016x}"))
    }

    /// A new Codex login: the old account's limits and credits no longer apply, here or on the website.
    fn codex_login_changed(&self) {
        *self.codex_reported.lock().unwrap() = None;
        self.clear_plan("codex", true);
        self.clear_plan("pi", true);
    }

    /// Verify a login installed outside the core, then continue quota-stopped work.
    pub async fn codex_switched(self: &Arc<Self>) -> (runtime::auth::Status, Vec<String>) {
        let status = self.codex_auth.verify(&self.config).await;
        let continued = if status.state == "connected" {
            self.codex_login_changed();
            self.apply_codex_status(&status);
            self.continue_limited(&[runtime::Kind::Codex, runtime::Kind::Pi])
        } else {
            Vec::new()
        };
        (status, continued)
    }

    /// The website wrote a new Claude login (ADR 0197): continue Claude work its plan limit stopped.
    pub fn claude_switched(self: &Arc<Self>) -> Vec<String> {
        self.clear_plan("claude-code", true);
        self.continue_limited(&[runtime::Kind::Claude])
    }

    /// Send "keep working" to these harnesses' sessions stopped by a usage limit.
    /// The harness restarts or wakes first, so it loads the new login before the prompt runs.
    fn continue_limited(self: &Arc<Self>, harnesses: &[runtime::Kind]) -> Vec<String> {
        if self.is_stopping() || self.storage.blocks() {
            return Vec::new();
        }
        let mut local = self.local.lock().unwrap();
        let ids: Vec<_> = local
            .sessions
            .values()
            .filter(|s| {
                s.usage_limited
                    && !s.archived
                    && harnesses.contains(&s.harness)
                    // Awake and idle, going to sleep (the app's switch asks for it), or asleep.
                    && ((s.ready && s.handle.is_some() && s.state == "idle")
                        || s.releasing
                        || (s.handle.is_none() && s.state == "sleeping"))
                    && s.current_request.is_none()
                    && s.queue.is_empty()
                    && !s.queue_paused
                    && !s.compacting
                    && s.close_request.is_none()
                    && s.rewind_request.is_none()
            })
            .map(|s| s.session_id.clone())
            .collect();
        let mut continued = Vec::new();
        for id in ids {
            // The continuation of a `plan_only` loop run stays `plan_only` (ADR 0292).
            let mut input = json!({"text":"keep working"});
            if local.sessions[&id].resume_plan_only {
                input["plan_only"] = json!(true);
            }
            let receipt = Receipt {
                request_id: format!("continue_{}", now_ms()),
                command: "prompt".into(),
                input,
                state: "accepted".into(),
                model: None,
                provider: None,
                workspace: None,
                error: None,
            };
            let Ok(data) = serde_json::to_value(&receipt) else {
                continue;
            };
            if local.append(&id, "receipt", data, None).is_err() {
                continue;
            }
            if let Some(handle) = &local.sessions[&id].handle {
                handle.request_shutdown();
            } else if self.wake(&mut local, &id).is_err() {
                continue;
            }
            continued.push(id);
        }
        continued
    }

    /// Cloud only: a thread a plan limit stopped gets one website loop that sends "keep working" just after the
    /// reset, since its sandbox is asleep by then (ADRs 0212, 0225). Once the thread moves on (a switch, the user's
    /// message, the loop itself), the loop is removed, so it never fires twice.
    pub fn start_limit_resumer(self: &Arc<Self>) {
        if self.history.api.is_none() {
            return;
        }
        let manager = self.clone();
        tokio::spawn(async move {
            while !manager.is_stopping() {
                manager.sync_resume_loops().await;
                tokio::time::sleep(RESUME_CHECK).await;
            }
        });
    }

    /// Queues a plan limit, or a switch to paid credits, for the website, which holds the account's Cloud loops on
    /// that harness until it resets (ADR 0292). A report like the last one sent waits `REPORT_AGAIN_MS`. Each report
    /// says when it was seen (`at`), so the website ignores one older than a clear, and carries its login, so it is
    /// dropped unsent once another login is in use.
    pub(super) fn report_limit(&self, data: &Value, credits: bool) {
        let Some(harness) = data["harness"].as_str() else {
            return;
        };
        let now = now_ms();
        // A Codex turn at its limit carries no reset (real Codex sends `primary: null` then); its login check does.
        let known = (harness == "codex")
            .then(|| {
                self.codex_reported
                    .lock()
                    .unwrap()
                    .and_then(|(_, resets)| resets)
            })
            .flatten()
            .filter(|at| *at > now);
        let reset = data["resets_at_ms"].as_u64().or(known);
        let until = reset.unwrap_or(now + LIMIT_HOLD_MS);
        let login = self.login_of(harness);
        let mut plan = self.plan.lock().unwrap();
        // Paying with credits until the reset, for this login; a hard limit means no credits are being spent.
        let paid = plan.credits_until.get(harness).copied();
        if credits {
            plan.credits_until
                .insert(harness.to_owned(), paid.unwrap_or(0).max(until));
            match login.clone() {
                Some(login) => plan.logins.insert(harness.to_owned(), login),
                None => plan.logins.remove(harness),
            };
        } else {
            plan.credits_until.remove(harness);
        }
        // A guessed reset moves with every report, so only its credits and age decide a repeat.
        let repeat = plan.sent.get(harness).is_some_and(|&(was, sent, at)| {
            was == credits
                && sent != 0
                && (reset.is_none() || sent.abs_diff(until) < SAME_RESET_MS)
                && now.saturating_sub(at) < REPORT_AGAIN_MS
        });
        if !repeat && self.history.api.is_some() {
            plan.generation += 1;
            let generation = plan.generation;
            let report = json!({"harness":harness,"until":until,"credits":credits,"at":now});
            plan.reports
                .insert(harness.to_owned(), (generation, report, login));
            plan.sent.insert(harness.to_owned(), (credits, until, now));
        }
        if !repeat || plan.credits_until.get(harness).copied() != paid {
            plan.save(&self.config.state_dir);
        }
    }

    /// The harness is on its plan again (a reset, an upgrade) or another login is in use (`switch`): its credits hold
    /// ends here and, through a `clear` report, on the website. Without a switch, only if this Core held or reported
    /// that harness, so healthy sandboxes add no traffic.
    pub(super) fn clear_plan(&self, harness: &str, switch: bool) {
        let now = now_ms();
        let mut plan = self.plan.lock().unwrap();
        let held = plan.credits_until.remove(harness).is_some();
        plan.logins.remove(harness);
        let reported = plan
            .sent
            .get(harness)
            .is_some_and(|&(_, until, _)| until != 0);
        if !switch && !held && !reported {
            return;
        }
        // A clear replaces any report still waiting for this harness, so an older one is never sent after it.
        if self.history.api.is_some() {
            plan.generation += 1;
            let generation = plan.generation;
            let report = json!({"harness":harness,"clear":true,"at":now});
            plan.reports
                .insert(harness.to_owned(), (generation, report, None));
            plan.sent.insert(harness.to_owned(), (false, 0, now));
        } else {
            plan.reports.remove(harness);
            plan.sent.remove(harness);
        }
        plan.save(&self.config.state_dir);
    }

    /// Stops a `plan_only` turn that would spend extra credits: interrupts it, tries again while it still runs (Codex
    /// needs its turn ID first), and stops the harness if no interrupt lands, so no more paid requests go out.
    pub(super) fn stop_for_credits(
        self: Arc<Self>,
        id: String,
        request: String,
        handle: runtime::Handle,
    ) {
        tokio::spawn(async move {
            let running = |manager: &Self| {
                manager
                    .local
                    .lock()
                    .unwrap()
                    .sessions
                    .get(&id)
                    .is_some_and(|s| s.current_request.as_deref() == Some(request.as_str()))
            };
            // At most 10 s in all: each interrupt may wait on a stuck harness.
            let landed = tokio::time::timeout(Duration::from_secs(10), async {
                for attempt in 1..=5 {
                    if handle.interrupt(&request).await.is_ok() || !running(&self) {
                        return true;
                    }
                    tokio::time::sleep(Duration::from_millis(400 * attempt)).await;
                }
                false
            })
            .await
            .unwrap_or(false);
            if !landed && running(&self) {
                // The turn ends as lost, not interrupted; its receipt still says why.
                if let Some(receipt) = self
                    .local
                    .lock()
                    .unwrap()
                    .sessions
                    .get_mut(&id)
                    .and_then(|s| s.receipts.get_mut(&request))
                {
                    receipt.error = Some(super::PLAN_ONLY_STOPPED.into());
                }
                handle.request_shutdown();
            }
        });
    }

    /// Sends the newest report per harness. An outage keeps it and backs off (10 s doubling to 5 min); a refusal
    /// drops it. A report replaced while in flight (a newer limit, a clear, a switch) is never put back, and one seen
    /// with a login no longer in use is dropped unsent. Also runs before the sandbox stops (`/v1/drain`).
    pub async fn send_plan_reports(&self) {
        let Some(api) = &self.history.api else {
            return;
        };
        let now = now_ms();
        if now < self.report_retry.lock().unwrap().0 {
            return;
        }
        let reports: Vec<(String, u64, Value, Option<String>)> = {
            let plan = self.plan.lock().unwrap();
            plan.reports
                .iter()
                .map(|(harness, (generation, report, login))| {
                    (harness.clone(), *generation, report.clone(), login.clone())
                })
                .collect()
        };
        let mut outage = false;
        for (harness, generation, report, login) in reports {
            let current = self.login_of(&harness);
            if login.is_some() && current.is_none() {
                continue;
            }
            let stale = login.is_some() && login != current;
            if stale {
                self.plan.lock().unwrap().sent.remove(&harness);
            } else {
                outage = matches!(
                    api.post("limit", &report).await,
                    Err(super::history::ApiError::Network(_))
                        | Err(super::history::ApiError::Status(429 | 500.., _))
                );
                if outage {
                    break;
                }
            }
            let mut plan = self.plan.lock().unwrap();
            if plan
                .reports
                .get(&harness)
                .is_some_and(|(newest, ..)| *newest == generation)
            {
                plan.reports.remove(&harness);
                plan.save(&self.config.state_dir);
            }
        }
        let mut retry = self.report_retry.lock().unwrap();
        *retry = if outage {
            let wait = (retry.1 * 2).clamp(10_000, 300_000);
            (now + wait, wait)
        } else {
            (0, 0)
        };
    }

    /// A drain gave up on sending: wait before trying again, like an outage.
    pub fn delay_plan_reports(&self) {
        let mut retry = self.report_retry.lock().unwrap();
        let wait = (retry.1 * 2).clamp(10_000, 300_000);
        *retry = (now_ms() + wait, wait);
    }

    async fn sync_resume_loops(&self) {
        let Some(api) = &self.history.api else {
            return;
        };
        self.send_plan_reports().await;
        let now = now_ms();
        let changes: Vec<_> = self
            .local
            .lock()
            .unwrap()
            .sessions
            .values()
            .filter_map(|s| {
                let change = s.resume_change(now)?;
                Some((
                    s.session_id.clone(),
                    s.resume_name(),
                    s.limit_episode,
                    change,
                ))
            })
            .collect();
        // A refused change (a deleted loop, an archived thread, 100 loops) stays refused; an outage does not.
        use super::history::ApiError::Status;
        for (session, name, episode, change) in changes {
            let data = match change {
                Change::Delete(id) => match api
                    .post("automation", &json!({"action":"delete","id":id}))
                    .await
                {
                    Ok(_) => json!({"deleted":id}),
                    Err(Status(status, _)) if status < 500 => json!({"deleted":id}),
                    Err(_) => continue,
                },
                Change::Create(at) => {
                    // A create whose answer was lost, or a restart, may have left this session a loop: remove it
                    // first, since its schedule may be an earlier limit's, so there is never a second one.
                    let Ok(list) = api.post("automation", &json!({"action":"list"})).await else {
                        continue;
                    };
                    let mut cleared = true;
                    for l in list["automations"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|l| {
                            l["name"] == name.as_str()
                                && (l["session_id"].is_null()
                                    || l["session_id"] == session.as_str())
                        })
                    {
                        cleared &= match api
                            .post("automation", &json!({"action":"delete","id":l["id"]}))
                            .await
                        {
                            Ok(_) => true,
                            Err(Status(status, _)) => status < 500,
                            Err(_) => false,
                        };
                    }
                    if !cleared {
                        continue;
                    }
                    // 1-3 minutes after the reset, so threads on one account do not all retry at once.
                    let jitter = u64::from(
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .subsec_millis(),
                    ) * 120;
                    let delay = at.map_or(PAUSED_SECS, |at| {
                        at.saturating_sub(now) / 1000 + 60 + jitter / 1000
                    });
                    let body = json!({"action":"create","name":name,"prompt":"keep working","delay":format!("{delay} seconds"),"new_thread":false,"session":session});
                    match api.post("automation", &body).await {
                        Ok(answer) => match answer["id"].as_str() {
                            Some(id) => {
                                if at.is_none() {
                                    // Left unpaused by a lost answer, it still waits a month first.
                                    let _ = api
                                        .post("automation", &json!({"action":"pause","id":id}))
                                        .await;
                                }
                                json!({"id":id,"episode":episode})
                            }
                            None => {
                                json!({"id":null,"failed":"the website returned no loop","episode":episode})
                            }
                        },
                        Err(Status(status, message)) if status < 500 => {
                            json!({"id":null,"failed":message,"episode":episode})
                        }
                        Err(_) => continue,
                    }
                }
            };
            let _ = self
                .local
                .lock()
                .unwrap()
                .append(&session, "resume_loop", data, None);
        }
    }

    fn check_codex_login(&self) -> Result<()> {
        if self.is_stopping() {
            return Err(Error::Conflict("service is stopping"));
        }
        if self.storage.blocks() {
            return Err(Error::Conflict("storage unsafe; new execution is blocked"));
        }
        if self.local.lock().unwrap().sessions.values().any(|s| {
            s.harness == runtime::Kind::Codex
                && (s.current_request.is_some()
                    || (!s.queue_paused && !s.queue.is_empty())
                    || matches!(s.state.as_str(), "starting" | "resuming" | "pending"))
        }) {
            return Err(Error::Conflict(
                "finish active Codex work before signing in",
            ));
        }
        Ok(())
    }

    pub async fn codex_login(&self, request: String) -> Result<runtime::auth::Status> {
        self.check_codex_login()?;
        Ok(self.codex_auth.login(&self.config, request).await)
    }

    pub async fn import_codex_login(
        self: &Arc<Self>,
        credentials: Value,
    ) -> Result<runtime::auth::Status> {
        self.check_codex_login()?;
        let status = self
            .codex_auth
            .import(&self.config, &self.storage, credentials)
            .await;
        if self.codex_auth.take_switched().await {
            self.codex_login_changed();
            self.apply_codex_status(&status);
            self.continue_limited(&[runtime::Kind::Codex, runtime::Kind::Pi]);
        }
        Ok(status)
    }

    pub async fn cancel_codex_login(&self, request: &str) -> runtime::auth::Status {
        self.codex_auth.cancel(request).await
    }

    pub async fn cursor_auth_status(&self) -> runtime::auth::Status {
        self.cursor_auth.status(&self.config, &self.storage).await
    }
    pub async fn cursor_account(
        &self,
        action: &str,
        request: String,
        key: Option<String>,
    ) -> Result<runtime::auth::Status> {
        if action == "cancel" {
            return Ok(self.cursor_auth.cancel(&request).await);
        }
        if self.is_stopping() {
            return Err(Error::Conflict("service is stopping"));
        }
        if self.storage.blocks() {
            return Err(Error::Conflict("storage unsafe; new execution is blocked"));
        }
        if self.local.lock().unwrap().sessions.values().any(|session| {
            session.harness == runtime::Kind::Cursor
                && (session.handle.is_some()
                    || session.current_request.is_some()
                    || (!session.queue_paused && !session.queue.is_empty())
                    || matches!(session.state.as_str(), "starting" | "resuming" | "pending"))
        }) {
            return Err(Error::Conflict(
                "close Cursor sessions before changing the cloud login",
            ));
        }
        Ok(if let Some(key) = key {
            self.cursor_auth
                .set_key(&self.config, &self.storage, key)
                .await
        } else {
            self.cursor_auth
                .login(&self.config, &self.storage, request)
                .await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 60 * 60 * 1000;

    /// A journal with one idle Codex session, and a helper that accepts a prompt for it.
    fn limited_session(dir: &str) -> (Local, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("cloudroom-resume-{dir}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut local = Local::open(&dir).unwrap();
        let start = json!({"request_id":"s1","command":"start","state":"accepted","input":{"harness":"codex"}});
        local.append("a", "receipt", start, None).unwrap();
        local
            .append("a", "state", json!({"state":"idle"}), None)
            .unwrap();
        (local, dir)
    }

    fn prompt(local: &mut Local, request: &str) {
        let receipt = json!({"request_id":request,"command":"prompt","state":"accepted","input":{"text":"keep working"}});
        local.append("a", "receipt", receipt, None).unwrap();
    }

    fn change(local: &Local, now: u64) -> String {
        match local.sessions["a"].resume_change(now) {
            Some(Change::Create(Some(_))) => "create timed".into(),
            Some(Change::Create(None)) => "create paused".into(),
            Some(Change::Delete(id)) => format!("delete {id}"),
            None => "none".into(),
        }
    }

    #[test]
    fn sessions_with_the_same_ending_get_their_own_loops() {
        let named = |id: &str| Session {
            session_id: id.into(),
            harness: runtime::Kind::Claude,
            ..Session::default()
        };
        let first = named("cr_auto_00000000000000000000000000000001_1792500000").resume_name();
        let second = named("cr_auto_00000000000000000000000000000002_1792500000").resume_name();
        assert_ne!(first, second);
        assert!(first.starts_with("Resume after Claude plan limit · "));
    }

    #[test]
    fn a_new_limit_after_a_continuation_replaces_the_old_schedule() {
        let (mut local, dir) = limited_session("episode");
        let now = now_ms();
        // Enabled loop for a reset in 2 minutes; a switch continues the thread; the next turn's reset is 7 h away.
        local
            .append(
                "a",
                "usage_limited",
                json!({"resets_at_ms": now + 120_000}),
                None,
            )
            .unwrap();
        assert_eq!(change(&local, now), "create timed");
        let episode = local.sessions["a"].limit_episode;
        local
            .append(
                "a",
                "resume_loop",
                json!({"id":"timed-1","episode":episode}),
                None,
            )
            .unwrap();
        prompt(&mut local, "continue_1");
        local
            .append(
                "a",
                "usage_limited",
                json!({"resets_at_ms": now + 7 * HOUR}),
                None,
            )
            .unwrap();
        // The old loop goes first, before any poll sees the thread unlimited; then a paused loop for the new limit.
        assert_eq!(change(&local, now), "delete timed-1");
        local
            .append("a", "resume_loop", json!({"deleted":"timed-1"}), None)
            .unwrap();
        assert_eq!(change(&local, now), "create paused");
        let episode = local.sessions["a"].limit_episode;
        local
            .append(
                "a",
                "resume_loop",
                json!({"id":"paused-1","episode":episode}),
                None,
            )
            .unwrap();
        // And back: a user retry hits a limit that resets soon, so the paused loop gives way to a timed one.
        prompt(&mut local, "user_1");
        local
            .append(
                "a",
                "usage_limited",
                json!({"resets_at_ms": now + 120_000}),
                None,
            )
            .unwrap();
        assert_eq!(change(&local, now), "delete paused-1");
        local
            .append("a", "resume_loop", json!({"deleted":"paused-1"}), None)
            .unwrap();
        assert_eq!(change(&local, now), "create timed");
        assert_eq!(local.sessions["a"].limit_resumes, 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_late_answer_for_an_earlier_limit_is_retired() {
        let (mut local, dir) = limited_session("late");
        let now = now_ms();
        local
            .append(
                "a",
                "usage_limited",
                json!({"resets_at_ms": now + 120_000}),
                None,
            )
            .unwrap();
        let earlier = local.sessions["a"].limit_episode;
        // Before the website answers, the thread moves on and hits another limit.
        prompt(&mut local, "user_1");
        local
            .append(
                "a",
                "usage_limited",
                json!({"resets_at_ms": now + 120_000}),
                None,
            )
            .unwrap();
        local
            .append(
                "a",
                "resume_loop",
                json!({"id":"late-1","episode":earlier}),
                None,
            )
            .unwrap();
        assert_eq!(local.sessions["a"].resume_loop, None);
        assert_eq!(change(&local, now), "delete late-1");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_limit_on_a_turn_with_newer_work_queued_behind_it_ends_when_that_work_starts() {
        let (mut local, dir) = limited_session("queued");
        let now = now_ms();
        let run = |local: &mut Local, request: &str, state: &str| {
            local
                .append(
                    "a",
                    "state",
                    json!({"state":state,"request_id":request}),
                    None,
                )
                .unwrap();
        };
        let finish = |local: &mut Local, request: &str, state: &str| {
            let receipt =
                json!({"request_id":request,"command":"prompt","state":state,"input":{"text":"x"}});
            local.append("a", "receipt", receipt, None).unwrap();
        };
        // A runs; B is accepted behind it; then A hits the limit, so the limit is recorded after B's acceptance.
        prompt(&mut local, "a_task");
        run(&mut local, "a_task", "starting_turn");
        prompt(&mut local, "b_task");
        local
            .append(
                "a",
                "usage_limited",
                json!({"resets_at_ms": now + 120_000}),
                None,
            )
            .unwrap();
        finish(&mut local, "a_task", "failed");
        // While B waits in the queue, a loop's run may not slip in behind it.
        let episode = local.sessions["a"].limit_episode;
        local
            .append(
                "a",
                "resume_loop",
                json!({"id":"aaaa-1111","episode":episode}),
                None,
            )
            .unwrap();
        let resume = json!({"text":"[Cloudroom automation \"Resume after Codex plan limit · a\" due: x]\n\nkeep working"});
        assert!(!local.sessions["a"].resume_accepts("auto_aaaa1111_1", &resume));
        // B starts: A's limit no longer stops the thread, and its loop retires while B runs and after it completes.
        run(&mut local, "b_task", "starting_turn");
        assert!(!local.sessions["a"].usage_limited);
        assert!(!local.sessions["a"].resume_accepts("auto_aaaa1111_1", &resume));
        assert_eq!(change(&local, now), "delete aaaa-1111");
        local
            .append("a", "resume_loop", json!({"deleted":"aaaa-1111"}), None)
            .unwrap();
        finish(&mut local, "b_task", "completed");
        run(&mut local, "", "idle");
        assert_eq!(change(&local, now), "none");
        assert!(!local.sessions["a"].resume_accepts("auto_aaaa1111_1", &resume));
        // A real limit on later work still gets its own loop.
        prompt(&mut local, "c_task");
        run(&mut local, "c_task", "starting_turn");
        local
            .append(
                "a",
                "usage_limited",
                json!({"resets_at_ms": now + 120_000}),
                None,
            )
            .unwrap();
        finish(&mut local, "c_task", "failed");
        assert_eq!(change(&local, now), "create timed");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_the_current_loop_may_resume_the_thread() {
        let (mut local, dir) = limited_session("guard");
        let now = now_ms();
        let text = |id: &str| json!({"text": format!("[Cloudroom automation \"Resume after Codex plan limit · a\" due: {id}]\n\nkeep working")});
        local
            .append(
                "a",
                "usage_limited",
                json!({"resets_at_ms": now + 120_000}),
                None,
            )
            .unwrap();
        let episode = local.sessions["a"].limit_episode;
        local
            .append(
                "a",
                "resume_loop",
                json!({"id":"aaaa-1111","episode":episode}),
                None,
            )
            .unwrap();
        let s = &local.sessions["a"];
        assert!(s.resume_accepts("auto_aaaa1111_1792500000", &text("aaaa-1111")));
        assert!(
            !s.resume_accepts("auto_bbbb2222_1792500000", &text("bbbb-2222")),
            "another loop's run"
        );
        assert!(
            s.resume_accepts("user_1", &json!({"text":"hello"})),
            "an ordinary prompt"
        );
        // The thread moves on: the loop is retired, and stays refused even once a new limit stops the thread.
        prompt(&mut local, "user_2");
        assert!(
            !local.sessions["a"].resume_accepts("auto_aaaa1111_1792500000", &text("aaaa-1111"))
        );
        local
            .append(
                "a",
                "usage_limited",
                json!({"resets_at_ms": now + 120_000}),
                None,
            )
            .unwrap();
        assert!(
            !local.sessions["a"]
                .resume_accepts("auto_aaaa1111_1792500000", &json!({"text":"keep working"}))
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
