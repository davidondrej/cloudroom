//! Read-only views: the session list, dashboard, harness capabilities, and model checks.
use super::*;

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
            "terminals":self.terminals.summary()})
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

    async fn catalog(&self, kind: runtime::Kind, saved_ok: bool) -> Result<Vec<runtime::Model>> {
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
        let result = if kind == runtime::Kind::Cursor {
            runtime::cursor_models::list(&self.config, &self.storage).await
        } else {
            let (result, exit) = runtime::models(&self.config, kind).await;
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
            result
        };
        let models = result.map_err(|_| Error::Conflict("model catalog unavailable"))?;
        *cached = Some((Instant::now(), models.clone()));
        Ok(models)
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
                | runtime::Kind::OpenClaw => {
                    let capabilities = runtime::cursor::capabilities(*kind);
                    for (key, value) in capabilities.as_object().unwrap() {
                        harness[key] = value.clone();
                    }
                    harness["reasoning_levels"] = json!(match kind {
                        runtime::Kind::OpenCode => runtime::OPENCODE_REASONING_LEVELS,
                        runtime::Kind::Hermes => runtime::HERMES_REASONING_LEVELS,
                        runtime::Kind::Devin => runtime::DEVIN_REASONING_LEVELS,
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
