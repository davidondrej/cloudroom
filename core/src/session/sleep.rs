//! Idle sessions release their harness process and resume on the next message (ADR 0031).
use super::*;

/// ADR 0031: stop the harness after 30 minutes without active work.
const IDLE_SLEEP_MS: u64 = 30 * 60 * 1000;
/// A child in its parent's sandbox shares its memory, so a finished one frees its agent soon (#339).
/// Its reply is already saved for the parent; its next message resumes it.
const SHARED_IDLE_SLEEP_MS: u64 = 30 * 1000;
const CHECK_EVERY: Duration = Duration::from_secs(5);
/// Claude's list saying a background Bash task runs is trusted this long after it came (#1216): longer than most test
/// suites and builds, and half the website's 2-hour cap on background work. A lost clearing list costs at most this;
/// a longer job that the process count also misses then sleeps as before.
const BASH_TRUST_MS: u64 = 60 * 60 * 1000;

/// The running harness and its workload size when it became ready.
#[derive(Clone, Copy)]
pub(super) struct Awake {
    pid: u32,
    since_ms: u64,
    processes: Option<usize>,
    /// When Claude last listed a background Bash task as running. Per harness: a new one starts with none.
    bash: Option<u64>,
}

impl Session {
    pub(super) fn awaken(&mut self) {
        self.awake = self.handle.as_ref().map(|handle| Awake {
            pid: handle.pid(),
            since_ms: now_ms(),
            processes: handle.process_count(),
            bash: None,
        });
    }

    pub(super) fn background_bash(&mut self, running: bool) {
        if let Some(awake) = &mut self.awake {
            awake.bash = running.then(now_ms);
        }
    }

    fn listed_bash(&self, now: u64) -> bool {
        let at = self.awake.and_then(|awake| awake.bash);
        at.is_some_and(|at| now.saturating_sub(at) < BASH_TRUST_MS)
    }

    pub(super) fn sleep_pending(&self) -> bool {
        self.receipts
            .values()
            .any(|r| r.command == "sleep" && r.state == "accepted")
    }

    /// A pending sleep from archive or `thread stop` (`end_jobs`) ends background jobs too; one after an account
    /// switch waits for them, as before (#607).
    fn ends_jobs(&self) -> bool {
        (self.archived && self.sleep_pending())
            || self.receipts.values().any(|r| {
                r.command == "sleep" && r.state == "accepted" && r.input["end_jobs"] == true
            })
    }

    pub(super) fn has_work(&self) -> bool {
        !self.queue.is_empty() && !self.queue_paused
    }

    pub(super) fn busy(&self) -> bool {
        self.current_request.is_some()
            || self.has_work()
            || matches!(
                self.state,
                SessionState::Pending
                    | SessionState::WaitingForFiles
                    | SessionState::Starting
                    | SessionState::Resuming
                    | SessionState::StartingTurn
                    | SessionState::Running
            )
    }

    /// Processes beyond the harness's count at launch: background jobs such as downloads, builds, or dev servers.
    /// Or a background Bash task Claude lists, which the count misses once a launch process (an MCP server) exits.
    pub(super) fn has_background_jobs(&self) -> bool {
        let (Some(handle), Some(awake)) = (&self.handle, self.awake) else {
            return false;
        };
        awake.pid == handle.pid()
            && (self.listed_bash(now_ms())
                || handle
                    .process_count()
                    .zip(awake.processes)
                    .is_some_and(|(now, baseline)| now > baseline))
    }

    /// Started in its parent's sandbox: still true once detached, as when its archived parent kept it open (#603).
    fn shared_child(&self) -> bool {
        self.parent_session.is_some()
            || self
                .receipts
                .values()
                .any(|r| r.command == "start" && r.input["parent_session"].is_string())
    }

    fn idle_limit(&self) -> u64 {
        if self.shared_child() {
            SHARED_IDLE_SLEEP_MS
        } else {
            IDLE_SLEEP_MS
        }
    }

    fn idle_ms(&self, now: u64) -> u64 {
        let since = self.last_activity.unwrap_or(0);
        now.saturating_sub(since.max(self.awake.map_or(0, |a| a.since_ms)))
    }

    /// A restart relaunches only sessions with work or recent activity.
    pub(super) fn restores_awake(&self, now: u64) -> bool {
        self.has_work()
            || (self.state != SessionState::Sleeping
                && self
                    .last_activity
                    .is_none_or(|at| now.saturating_sub(at) < self.idle_limit()))
    }
}

/// The shared browser pauses while nothing may use it, so an open page never burns credits while the sandbox waits to
/// sleep (#610). Unknown at start counts as paused: a Core that stopped while it was paused leaves it so.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Browser {
    Running,
    /// Resumed by a command outside a turn: it runs until the next turn ends, never paused mid-command.
    Held,
    Paused,
}

impl Local {
    /// Resuming after `thread stop` or archive keeps the agent: their sleep, if not begun, is dropped, so it never
    /// ends the new work's background jobs (#607). An account switch's sleep stays, for the new login.
    pub(super) fn drop_pending_sleep(&mut self, id: &str) -> Result<()> {
        let session = &self.sessions[id];
        if session.releasing {
            return Ok(());
        }
        let pending: Vec<_> = session
            .receipts
            .values()
            .filter(|r| {
                r.command == "sleep" && r.state == "accepted" && r.input["end_jobs"] == true
            })
            .map(|r| r.request_id.clone())
            .collect();
        for request in pending {
            self.finish_receipt(id, &request, "interrupted")?;
        }
        Ok(())
    }

    fn set_browser(&mut self, next: Browser) {
        // At startup Paused is only an assumption; enforce it on every idle check.
        if next == Browser::Paused || self.browser == Browser::Paused {
            crate::runtime::linux::pause_browser(next == Browser::Paused, self.browser_owner);
        }
        self.browser = next;
    }

    fn working(&self) -> bool {
        (self.sessions.values()).any(|s| s.state != SessionState::Closed && s.busy())
    }

    /// A turn starts: the browser runs, and pauses again once it ends.
    pub(super) fn browser_turn(&mut self) {
        self.set_browser(Browser::Running);
    }

    /// `room-cli computer-use` (browser-harness runs it first) resumes the browser through here, so the sleeper
    /// knows. Outside a turn it is held until the next turn ends.
    pub(super) fn resume_browser(&mut self, in_turn: bool) {
        let next = if in_turn && self.browser != Browser::Held {
            Browser::Running
        } else {
            Browser::Held
        };
        self.set_browser(next);
    }

    /// Each idle-sleeper check: a turn, a background job, or a cloud-terminal command may use the browser, so it
    /// runs; otherwise it pauses. A held browser waits for the next turn.
    pub(super) fn check_browser(&mut self, terminal: impl FnOnce() -> bool) {
        if self.browser == Browser::Held {
            return;
        }
        if self.working() {
            return self.set_browser(Browser::Running);
        }
        let used = self.agent_counts().background > 0 || terminal();
        self.set_browser(if used {
            Browser::Running
        } else {
            Browser::Paused
        });
    }

    /// Only an idle harness with no queued work, children, or background jobs may stop.
    fn can_sleep(&self, id: &str) -> bool {
        let s = &self.sessions[id];
        if s.handle.is_none() {
            return false;
        }
        // New background jobs (dev servers, watchers) count as activity; uncertain means keep running.
        let background = s.has_background_jobs();
        s.ready
            && !s.releasing
            && s.state == SessionState::Idle
            && !s.busy()
            && !s.compacting
            && s.rewind_request.is_none()
            && s.close_request.is_none()
            && !s.interrupt_pending()
            && !s.storage_paused
            && (!background || s.ends_jobs())
            && !self
                .sessions
                .values()
                .any(|c| c.parent_session.as_deref() == Some(id) && c.busy())
    }
}

impl Manager {
    /// Called by `room-cli computer-use` through the agent socket (#610).
    pub(crate) fn resume_browser(&self, session: Option<&str>) {
        let mut local = self.local.lock().unwrap();
        let in_turn = session
            .and_then(|id| local.sessions.get(id))
            .is_some_and(Session::busy);
        local.resume_browser(in_turn);
    }

    /// Before a sandbox stops, refuse new work, but only when nothing is running.
    /// `hold: false` releases the drain, for example when the stop is cancelled.
    pub fn drain(&self, hold: bool) -> Value {
        let mut local = self.local.lock().unwrap();
        if !hold {
            local.draining = false;
            return json!({"drained": false});
        }
        // Closed sessions keep their close request forever, but nothing of theirs is running.
        // A low-disk pause may never lift on its own, so it must not keep the machine awake.
        let busy = local
            .sessions
            .values()
            .filter(|s| s.state != SessionState::Closed && !s.storage_paused)
            .find(|s| {
                s.busy()
                    || s.compacting
                    || s.rewind_request.is_some()
                    || s.close_request.is_some()
                    || s.interrupt_pending()
            });
        if let Some(session) = busy {
            return json!({"drained":false,"reason":"session_busy","session_id":session.session_id});
        }
        if self.teleports.busy() {
            return json!({"drained":false,"reason":"transfer_running"});
        }
        if super::relay::report_pending(&local) {
            return json!({"drained":false,"reason":"report_pending"});
        }
        if super::relay::start_pending(&local) {
            return json!({"drained":false,"reason":"child_start_pending"});
        }
        // A command waiting on the user's Mac keeps the sandbox awake, also one started from a terminal (feedback 0024).
        // Checked first: a Mac command is often also an agent's background job, and this is the reason that matters.
        if self.mac.waiting() > 0 {
            return json!({"drained":false,"reason":"mac_command"});
        }
        // ADR 0031: background jobs keep the sandbox awake. The website stops it two hours after the last activity.
        if local.agent_counts().background > 0 {
            return json!({"drained":false,"reason":"background_jobs"});
        }
        // A RepoSync check finishes its Git work before the GitHub login is wiped and the sandbox stops.
        if self.repo_sync.running() {
            return json!({"drained":false,"reason":"repo_sync"});
        }
        // Otherwise free to sleep: a report held until its child is quiet (#217) goes now; the API waits for it and
        // drains again in the same call (`held_out`).
        if super::children::flush_held(&local) {
            return json!({"drained":false,"reason":"report_held"});
        }
        local.draining = true;
        // The sandbox stops next, so its next start replays almost nothing.
        local.save_snapshot();
        // Saved with the website's sleep event, to tell busy sandboxes from idle ones: counts only, never content.
        let (mut prompts, mut failed) = (0u64, 0u64);
        for receipt in local.sessions.values().flat_map(|s| s.receipts.values()) {
            if receipt.command != "prompt" {
                continue;
            }
            match receipt.state.as_str() {
                "completed" | "interrupted" => prompts += 1,
                "failed" | "unknown_after_restart" => (prompts, failed) = (prompts + 1, failed + 1),
                _ => {}
            }
        }
        json!({
            "drained": true,
            "pending_records": local.journal.last() - local.journal.saved(),
            "work": {"prompts": prompts, "failed": failed},
        })
    }

    /// Waits up to `wait` until the reports a drain sent instead of holding them (#217) are out.
    pub async fn held_out(&self, wait: Duration) {
        let mut changed = self.local.lock().unwrap().changed.subscribe();
        let pending = || {
            let local = self.local.lock().unwrap();
            super::relay::report_pending(&local) || super::children::unqueued(&local)
        };
        let out = async { while pending() && changed.changed().await.is_ok() {} };
        let _ = tokio::time::timeout(wait, out).await;
    }

    /// Runs `start` unless the sandbox is draining, under the drain's lock, so a drain that begins later sees what it
    /// started: a Mac command's count (mac/mod.rs).
    pub(crate) fn unless_draining<T>(&self, start: impl FnOnce() -> T) -> Option<T> {
        let local = self.local.lock().unwrap();
        (!local.draining).then(start)
    }

    /// RepoSync (workspace/repo_sync.rs) checks every few seconds and when a turn ends. A check counts as running from
    /// under this lock, so a drain that begins later waits for it, and a draining sandbox starts none.
    pub fn start_repo_sync(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move {
            while !manager.is_stopping() {
                manager.repo_sync.wait().await;
                let repos = crate::workspace::repo_sync::RepoSync::repos();
                if repos.is_empty() {
                    continue;
                }
                let (running, targets) = {
                    let local = manager.local.lock().unwrap();
                    if local.draining {
                        continue;
                    }
                    (manager.repo_sync.start(), repo_targets(&local))
                };
                let notices = manager.repo_sync.check(&repos, targets).await;
                drop(running);
                for (i, (session, text)) in notices.into_iter().enumerate() {
                    let request = format!("notice_reposync_{:x}_{i}", now_ms());
                    let _ = manager.command(&session, request, "prompt", json!({"text": text}));
                }
            }
        });
    }

    pub fn start_idle_sleeper(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move {
            while !manager.is_stopping() {
                tokio::time::sleep(CHECK_EVERY).await;
                let mut local = manager.local.lock().unwrap();
                let now = now_ms();
                let ids: Vec<_> = local
                    .sessions
                    .values()
                    .filter(|s| s.handle.is_some())
                    .map(|s| s.session_id.clone())
                    .collect();
                for id in ids {
                    let session = local.sessions.get_mut(&id).unwrap();
                    let pid = session.handle.as_ref().map(|h| h.pid());
                    if session.ready && session.awake.map(|a| a.pid) != pid {
                        session.awaken();
                        continue;
                    }
                    let due =
                        session.sleep_pending() || session.idle_ms(now) >= session.idle_limit();
                    if due && local.can_sleep(&id) {
                        manager.release(&mut local, &id);
                    }
                }
                local.check_browser(|| manager.terminals.running());
            }
        });
    }

    pub(super) fn release(&self, local: &mut Local, id: &str) {
        let session = local.sessions.get_mut(id).unwrap();
        session.ready = false;
        session.releasing = true;
        if let Some(handle) = &session.handle {
            handle.request_shutdown();
        }
    }

    /// Claude reads its login and connects MCP servers only at start, so after a new sign-in
    /// (or cloud MCP sign-in) an idle agent sleeps before its next prompt; the queued prompt
    /// wakes it with the new login.
    pub(super) fn sleep_for_login(&self, local: &mut Local, id: &str) -> bool {
        let session = &local.sessions[id];
        let changed = session.can_resume()
            && local.can_sleep(id)
            && session.handle.as_ref().is_some_and(|h| {
                h.login_changed(&self.config) || h.mcp_login_changed(&self.config)
            });
        if changed {
            self.release(local, id);
        }
        changed
    }

    /// `thread stop` also frees the agent, except Codex: its resume is still unreliable (#605), so it only stops the
    /// turn and the 30-minute idle sleep frees it later.
    pub(super) fn stop_sleeps(&self, id: &str) -> bool {
        self.local
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .is_some_and(|s| s.harness != runtime::Kind::Codex)
    }

    /// Agent Zero refuses the next prompt after a cancel and its commands outlive it, so the app's Stop frees it too: the
    /// next message starts a fresh bridge, and freeing ends the commands it ran (ADR 20261116-153548).
    pub(crate) fn stop_frees(&self, id: &str) -> bool {
        self.local
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .is_some_and(|s| s.harness == runtime::Kind::AgentZero)
    }

    /// Archive and `thread stop` ask for sleep. It applies once any running turn or interrupt settles.
    pub(super) fn request_sleep(
        self: &Arc<Self>,
        local: &mut Local,
        id: &str,
        request: String,
        input: Value,
    ) -> Result<Receipt> {
        let receipt = Receipt {
            request_id: request.clone(),
            command: "sleep".into(),
            input,
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
        let session = &local.sessions[id];
        if session.handle.is_some() {
            if local.can_sleep(id) {
                self.release(local, id);
            }
        } else if !session.busy() {
            if session.can_resume() && session.state != SessionState::Sleeping {
                local.append(id, "state", json!({"state":SessionState::Sleeping}), None)?;
            }
            local.finish_receipt(id, &request, "completed")?;
        }
        Ok(receipt)
    }

    /// The released harness exited; history stays on disk for the next resume.
    pub(super) fn slept(self: &Arc<Self>, local: &mut Local, id: &str) -> Result<()> {
        let session = local.sessions.get_mut(id).ok_or(Error::NotFound)?;
        session.handle = None;
        session.ready = false;
        session.releasing = false;
        session.awake = None;
        local.append(id, "harness", json!({"pid":null}), None)?;
        local.append(id, "state", json!({"state":SessionState::Sleeping}), None)?;
        let pending: Vec<_> = local.sessions[id]
            .receipts
            .values()
            .filter(|r| r.command == "sleep" && r.state == "accepted")
            .map(|r| r.request_id.clone())
            .collect();
        for request in pending {
            local.finish_receipt(id, &request, "completed")?;
        }
        self.wake(local, id)
    }

    /// Work arrived for a sleeping session: resume its native conversation.
    pub(super) fn wake(self: &Arc<Self>, local: &mut Local, id: &str) -> Result<()> {
        let s = &local.sessions[id];
        if s.state == SessionState::Sleeping && s.handle.is_none() && s.has_work() && s.can_resume()
        {
            self.schedule_resume(local, id, false)?;
        }
        Ok(())
    }
}

/// Each live session's folder, with a session to tell about problems (not an archived one) and whether any agent there
/// is mid-turn, and the repos cloned into `/repos`: any agent may edit those, so they wait for every agent here and
/// tell any live thread.
fn repo_targets(local: &Local) -> Vec<crate::workspace::repo_sync::Target> {
    use crate::workspace::repo_sync::Target;
    let mut targets: Vec<Target> = Vec::new();
    let (mut any_busy, mut any_tell) = (false, None);
    let live = local
        .sessions
        .values()
        .filter(|s| s.state != SessionState::Closed);
    for s in live {
        let tell = (!s.archived).then(|| s.session_id.clone());
        any_busy |= s.busy();
        any_tell = any_tell.or(tell.clone());
        let Some(path) = s
            .workspace
            .as_ref()
            .and_then(|w| w.path.canonicalize().ok())
        else {
            continue;
        };
        match targets.iter_mut().find(|t| t.path == path) {
            Some(t) => (t.tell, t.busy) = (t.tell.take().or(tell), t.busy || s.busy()),
            None => targets.push(Target {
                path,
                tell,
                busy: s.busy(),
                shared: false,
            }),
        }
    }
    for entry in std::fs::read_dir("/repos").into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() && !targets.iter().any(|t| t.path == path) {
            targets.push(Target {
                path,
                tell: any_tell.clone(),
                busy: any_busy,
                shared: true,
            });
        }
    }
    targets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listed_bash_task_is_trusted_for_an_hour() {
        let awake = Awake {
            pid: 1,
            since_ms: 0,
            processes: None,
            bash: None,
        };
        let mut session = Session {
            awake: Some(awake),
            ..Default::default()
        };
        session.background_bash(true);
        let at = session.awake.unwrap().bash.unwrap();
        for (later, listed) in [(0, true), (BASH_TRUST_MS - 1, true), (BASH_TRUST_MS, false)] {
            assert_eq!(session.listed_bash(at + later), listed, "{later}");
        }
        session.background_bash(false);
        assert!(!session.listed_bash(at));
    }
}
