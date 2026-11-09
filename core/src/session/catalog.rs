//! Read-only views: the session list, dashboard, harness capabilities, and model checks.
use super::*;

/// What starting Claude with an exact model its catalog omits found for that model (#1059).
#[derive(Clone)]
enum Probe {
    Listed(Vec<String>),
    Unlisted,
    Failed(Instant),
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
            "resources":{"cpu":resources["cpu"],"memory":resources["memory"],"disk":resources["disk"]},
            "resourceBytes":{"memoryUsedBytes":resources["memoryUsedBytes"],"memoryTotalBytes":resources["memoryTotalBytes"],
                "diskAvailableBytes":resources["diskAvailableBytes"],"diskTotalBytes":resources["diskTotalBytes"]},
            "storage":storage,
            "diskThresholds":self.config.storage.as_ref().map(|policy| json!({"warningBytes":policy.warning_bytes,"pauseBytes":policy.pause_bytes})),
            "onboarding":{"localConnected":null,"offlineTaskVerified":null},
            "capabilities":{"settings":true,"updates":false},
            "sessionCount":sessions.len(),"agents":local.agent_counts(),"sessions":summaries,
            "terminals":self.terminals.summary(),"previews":{"lastActivity":self.previews.last_activity()}})
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
                "current_request":s.current_request,"queued":s.queue.len(),
                "last_sequence":s.last_sequence,"last_activity_ms":s.last_activity})
            })
            .collect();
        json!({"total":sessions.len(),"sessions":summaries})
    }

    pub(super) async fn codex_models(&self) -> Result<Vec<runtime::Model>> {
        self.model_catalog(runtime::Kind::Codex).await
    }

    pub(super) async fn model_catalog(&self, kind: runtime::Kind) -> Result<Vec<runtime::Model>> {
        self.catalog(kind, false).await
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
        if check(&self.catalog(kind, true).await?) == Some(true) {
            return Ok(true);
        }
        check(&self.model_catalog(kind).await?).ok_or(Error::Conflict("invalid model"))
    }

    /// Why the catalog refuses `reasoning` for `model`, naming the levels it takes (ADR 0123).
    pub(super) async fn effort_refusal(
        &self,
        kind: runtime::Kind,
        model: &str,
        reasoning: &str,
    ) -> Option<Error> {
        let models = self.catalog(kind, true).await.ok()?;
        runtime::supports(kind, &models, model, reasoning)
            .err()
            .map(Error::Effort)
    }

    /// The effort levels of a Claude model's own catalog row. Claude lists an exact model its catalog omits only once
    /// it runs it, so that row comes from a Claude started with the model, without inference (#1059). One probe per
    /// model runs at a time, within the startup limit, in a task of its own, so a dropped request never cuts it short.
    /// Its answer is kept, even "not listed"; a failure only for a minute.
    pub(super) async fn claude_levels(self: &Arc<Self>, model: &str) -> Option<Vec<String>> {
        type Slots =
            Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<Option<Probe>>>>>;
        static PROBES: std::sync::LazyLock<Slots> = std::sync::LazyLock::new(Mutex::default);
        let models = self.catalog(runtime::Kind::Claude, true).await.ok()?;
        if let Some(entry) = models.into_iter().find(|entry| entry.model == model) {
            return Some(entry.reasoning_levels);
        }
        let slot = PROBES
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

    pub(super) async fn catalog(
        &self,
        kind: runtime::Kind,
        saved_ok: bool,
    ) -> Result<Vec<runtime::Model>> {
        let cache = match kind {
            runtime::Kind::Codex => &self.codex_models,
            runtime::Kind::Claude => &self.claude_models,
            runtime::Kind::Cursor => &self.cursor_models,
            _ => return Err(Error::Conflict("model catalog unavailable")),
        };
        let mut cached = cache.lock().await;
        if let Some((checked, models)) = &*cached
            && (saved_ok || checked.elapsed() < Duration::from_secs(60))
        {
            return Ok(models.clone());
        }
        let (result, exit) = if kind == runtime::Kind::Cursor {
            let models = runtime::cursor_models::list(&self.config, &self.storage).await;
            (models, None)
        } else {
            runtime::models(&self.config, kind).await
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
        let failure = match result {
            Ok(models) => {
                *cached = Some((Instant::now(), models.clone()));
                return Ok(models);
            }
            Err(_) if kind == runtime::Kind::Cursor => "model catalog unavailable",
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                "model catalog unavailable (agent timed out listing models)"
            }
            Err(_) if !started => "model catalog unavailable (agent could not start)",
            Err(_) if crashed => {
                "model catalog unavailable (agent exited while starting; try again)"
            }
            Err(_) => "model catalog unavailable (agent sent an invalid model list)",
        };
        eprintln!("{kind:?} {failure}");
        Err(Error::Conflict(failure))
    }

    pub async fn capabilities(&self) -> Value {
        let mut harnesses = Vec::new();
        for (kind, profile) in &self.config.harnesses {
            let mut harness = json!({"id":kind,"model":profile.model,"provider":profile.provider});
            match kind {
                runtime::Kind::Codex | runtime::Kind::Claude => {
                    harness["models"] = if self.storage.blocks() {
                        Value::Null
                    } else {
                        match self.model_catalog(*kind).await {
                            Ok(models) => json!(models),
                            Err(_) => Value::Null,
                        }
                    };
                    harness["steer"] = json!(true);
                    harness["goal"] = json!(*kind == runtime::Kind::Codex);
                    harness["compact"] = json!(true);
                    harness["service_tier"] = json!(kind.fast());
                    harness["skill_mentions"] = json!(*kind == runtime::Kind::Claude);
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
                | runtime::Kind::OpenClaw => {
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
                        runtime::Kind::OpenClaw => runtime::OPENCLAW_REASONING_LEVELS,
                        _ => runtime::PI_REASONING_LEVELS,
                    });
                    // Cursor and OpenCode open images from the attached path; fx gets them inline.
                    harness["attachments"] = json!({"images":true,"files":true});
                    harness["provider_selection"] = json!(false);
                    // fx switches effort per turn; the others keep the launch level.
                    if *kind == runtime::Kind::Fx {
                        harness["reasoning_levels"] =
                            json!([runtime::PI_REASONING_LEVELS, &["max"]].concat());
                        harness["prompt_reasoning"] = json!(true);
                    }
                    if *kind == runtime::Kind::Cursor {
                        harness["models"] = if self.storage.blocks() {
                            Value::Null
                        } else {
                            match self.model_catalog(*kind).await {
                                Ok(models) => json!(models),
                                Err(_) => Value::Null,
                            }
                        };
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
            runtime::Kind::OpenClaw => runtime::OPENCLAW_REASONING_LEVELS.contains(&reasoning),
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
        if tier != "default" && tier != "fast" {
            return Err(Error::Conflict("invalid service tier"));
        }
        let kind = self
            .local
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .ok_or(Error::NotFound)?
            .harness;
        if !kind.fast() && tier == "fast" {
            return Err(Error::Conflict("invalid service tier"));
        }
        Ok(())
    }
}
