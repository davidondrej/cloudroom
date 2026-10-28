//! Observe Claude's native login without reading, copying or renewing credentials ourselves.
use super::{Kind, claude};
use crate::{
    config::Config,
    observability::{Observability, Signal, now_ms},
};
use serde::Serialize;
use std::{
    io,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{Mutex as AsyncMutex, watch},
    task::JoinHandle,
};

const CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);
const SUMMARY_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Credentials {
    #[default]
    Unknown,
    Present,
    Missing,
    CheckFailed,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RequestStatus {
    #[default]
    Unknown,
    Accepted,
    Rejected,
}

#[derive(Default)]
struct State {
    credentials: Credentials,
    request: RequestStatus,
    request_at_ms: Option<u64>,
    recorded: Option<Instant>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Probe {
    credentials: Credentials,
    reason: &'static str,
}

pub(crate) struct ClaudeAuth {
    state: Mutex<State>,
    check: AsyncMutex<Option<(Instant, Probe)>>,
    stop: watch::Sender<bool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Default for ClaudeAuth {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::default()),
            check: AsyncMutex::new(None),
            stop: watch::channel(false).0,
            worker: Mutex::new(None),
        }
    }
}

impl ClaudeAuth {
    pub fn start(self: &Arc<Self>, config: &Config, diagnostics: &Observability) {
        let mut worker = self.worker.lock().unwrap();
        if worker.is_some() || *self.stop.borrow() || !config.harnesses.contains_key(&Kind::Claude)
        {
            return;
        }
        let (this, config, diagnostics) = (self.clone(), config.clone(), diagnostics.clone());
        let mut stop = self.stop.subscribe();
        *worker = Some(tokio::spawn(async move {
            let mut tick = tokio::time::interval(CHECK_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    _ = stop.changed() => break,
                    _ = tick.tick() => { let _ = this.ready(&config, &diagnostics).await; }
                }
            }
        }));
    }

    pub async fn ready(&self, config: &Config, diagnostics: &Observability) -> io::Result<bool> {
        let started = Instant::now();
        let mut check = self.check.lock().await;
        // Concurrent starts share the check they waited for, not a stale readiness cache.
        let probe = if let Some((at, probe)) = *check
            && at >= started
        {
            probe
        } else {
            let mut stop = self.stop.subscribe();
            if *stop.borrow() {
                return Err(io::Error::other("Claude login monitor stopped"));
            }
            let result = tokio::select! {
                biased;
                _ = stop.changed() => return Err(io::Error::other("Claude login monitor stopped")),
                result = claude::auth_ready(config) => result,
            };
            let probe = match result {
                Ok(true) => Probe {
                    credentials: Credentials::Present,
                    reason: "credentials_present",
                },
                Ok(false) => Probe {
                    credentials: Credentials::Missing,
                    reason: "credentials_missing",
                },
                Err(error) => Probe {
                    credentials: Credentials::CheckFailed,
                    reason: if error.kind() == io::ErrorKind::TimedOut {
                        "check_timeout"
                    } else {
                        "check_failed"
                    },
                },
            };
            let changed = check.is_none_or(|(_, previous)| previous != probe);
            *check = Some((Instant::now(), probe));
            let mut state = self.state.lock().unwrap();
            state.credentials = probe.credentials;
            Self::record(&mut state, diagnostics, changed, probe.reason);
            probe
        };
        match probe.credentials {
            Credentials::Present => Ok(true),
            Credentials::Missing => Ok(false),
            _ => Err(io::Error::other("Claude account could not be checked")),
        }
    }

    pub fn request(&self, accepted: bool, diagnostics: &Observability) {
        let mut state = self.state.lock().unwrap();
        let request = if accepted {
            RequestStatus::Accepted
        } else {
            RequestStatus::Rejected
        };
        let changed = state.request != request;
        state.request = request;
        state.request_at_ms = Some(now_ms());
        Self::record(
            &mut state,
            diagnostics,
            changed,
            if accepted {
                "inference_succeeded"
            } else {
                "authentication_failed"
            },
        );
    }

    fn record(state: &mut State, diagnostics: &Observability, changed: bool, reason: &'static str) {
        if changed
            || state
                .recorded
                .is_none_or(|at| at.elapsed() >= SUMMARY_INTERVAL)
        {
            diagnostics.record(Signal::AuthHealth {
                harness: Kind::Claude,
                credentials: state.credentials,
                last_request: state.request,
                last_request_at_ms: state.request_at_ms,
                reason: if !changed && state.recorded.is_some() {
                    "daily_summary"
                } else {
                    reason
                },
            });
            state.recorded = Some(Instant::now());
        }
    }

    pub async fn shutdown(&self) {
        self.stop.send_replace(true);
        let worker = self.worker.lock().unwrap().take();
        if let Some(worker) = worker {
            let _ = worker.await;
        }
    }
}
