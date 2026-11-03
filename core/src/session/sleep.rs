//! Idle sessions release their harness process and resume on the next message (ADR 0031).
use super::*;

/// ADR 0031: stop the harness after 30 minutes without active work.
const IDLE_SLEEP_MS: u64 = 30 * 60 * 1000;
/// A child in its parent's sandbox shares its memory, so a finished one frees its agent soon (#339).
/// Its reply is already saved for the parent; its next message resumes it.
const SHARED_IDLE_SLEEP_MS: u64 = 30 * 1000;
const CHECK_EVERY: Duration = Duration::from_secs(5);

/// The running harness and its workload size when it became ready.
#[derive(Clone, Copy)]
pub(super) struct Awake {
    pid: u32,
    since_ms: u64,
    processes: Option<usize>,
}

impl Session {
    pub(super) fn awaken(&mut self) {
        self.awake = self.handle.as_ref().map(|handle| Awake {
            pid: handle.pid(),
            since_ms: now_ms(),
            processes: handle.process_count(),
        });
    }

    pub(super) fn sleep_pending(&self) -> bool {
        self.receipts
            .values()
            .any(|r| r.command == "sleep" && r.state == "accepted")
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
    pub(super) fn has_background_jobs(&self) -> bool {
        let (Some(handle), Some(awake)) = (&self.handle, self.awake) else {
            return false;
        };
        awake.pid == handle.pid()
            && handle
                .process_count()
                .zip(awake.processes)
                .is_some_and(|(now, baseline)| now > baseline)
    }

    fn idle_limit(&self) -> u64 {
        if self.parent_session.is_some() {
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
            // An archived thread asked to exit leaves its background jobs behind (thread.rs `retire`).
            && (!background || (s.archived && s.sleep_pending()))
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
        // ADR 0031: background jobs keep the sandbox awake. The website stops it two hours after the last activity.
        if local.agent_counts().background > 0 {
            return json!({"drained":false,"reason":"background_jobs"});
        }
        local.draining = true;
        // The sandbox stops next, so its next start replays almost nothing.
        local.save_snapshot();
        json!({"drained":true,"pending_records":local.journal.last() - local.journal.saved()})
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

    fn release(&self, local: &mut Local, id: &str) {
        let session = local.sessions.get_mut(id).unwrap();
        session.ready = false;
        session.releasing = true;
        if let Some(handle) = &session.handle {
            handle.request_shutdown();
        }
    }

    /// Claude reads its login only at start, so after a new sign-in an idle agent sleeps
    /// before its next prompt; the queued prompt wakes it with the new login.
    pub(super) fn sleep_for_login(&self, local: &mut Local, id: &str) -> bool {
        let session = &local.sessions[id];
        let changed = session.can_resume()
            && local.can_sleep(id)
            && session
                .handle
                .as_ref()
                .is_some_and(|h| h.login_changed(&self.config));
        if changed {
            self.release(local, id);
        }
        changed
    }

    /// Archive asks for sleep. It applies once any running turn or interrupt settles.
    pub(super) fn request_sleep(
        self: &Arc<Self>,
        local: &mut Local,
        id: &str,
        request: String,
    ) -> Result<Receipt> {
        let receipt = Receipt {
            request_id: request.clone(),
            command: "sleep".into(),
            input: json!({}),
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
