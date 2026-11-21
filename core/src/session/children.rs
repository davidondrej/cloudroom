use super::*;

impl Manager {
    pub(super) fn start_child(
        self: &Arc<Self>,
        local: &mut Local,
        parent: &str,
        handle: &runtime::Handle,
        child: runtime::ChildRequest,
    ) -> Result<()> {
        let runtime::ChildRequest {
            request,
            id: key,
            tool_call_id,
            prompt: text,
        } = child;
        let session = &local.sessions[parent];
        if !matches!(session.harness, runtime::Kind::Pi | runtime::Kind::Claude)
            || session.current_request.as_deref() != Some(&request)
        {
            return Err(Error::Conflict(
                "child requires the current managed parent turn",
            ));
        }
        if self.storage.blocks() || self.is_stopping() {
            let handle = handle.clone();
            tokio::spawn(async move {
                let _ = handle.child_result(&request, json!({"id":key,"error":"Cloudroom cannot start a child while storage or shutdown blocks execution"})).await;
            });
            return Ok(());
        }
        let id = format!("cr_child_{key}");
        let start_id = format!("child_{key}");
        let prompt_id = format!("task_{key}");
        let reasoning = prompt::latest(&session.prompts, &session.receipts, &request)
            .and_then(prompt::reasoning)
            .or_else(|| session.reasoning.clone());
        let mut input = json!({"harness":session.harness,"parent_session":parent,"parent_request":request,"tool_call_id":tool_call_id,"prompt":text,"reasoning":reasoning});
        if !session.command_guard_enabled() {
            input["command_guard_enabled"] = json!(false);
        }
        if !session.strip_ai_co_authors() {
            input["strip_ai_co_authors"] = json!(false);
        }
        if let Some(system_prompt) = session.system_prompt() {
            input["system_prompt"] = json!(system_prompt);
        }
        if let Some(project) = session.project_id() {
            input["project_id"] = json!(project);
        }
        if let Some(existing) = local.sessions.get(&id) {
            Self::retry(existing, &start_id, "start", &input)?
                .ok_or(Error::Conflict("child identity conflict"))?;
        } else {
            let start = Receipt {
                request_id: start_id.clone(),
                command: "start".into(),
                input,
                state: "accepted".into(),
                model: session.model.clone(),
                provider: session.provider.clone(),
                workspace: session.workspace.clone(),
                error: None,
            };
            // The child task is part of its durable start so a crash cannot strand an empty child.
            local.append(&id, "receipt", json!(start), None)?;
            local.append(
                parent,
                "child",
                json!({"id":id,"request_id":request,"tool_call_id":tool_call_id,"state":"started"}),
                None,
            )?;
            let manager = self.clone();
            let child = id.clone();
            tokio::spawn(async move {
                manager.launch(child, start_id).await;
            });
        }
        let manager = self.clone();
        let handle = handle.clone();
        let parent = parent.to_owned();
        let mut changed = local.changed.subscribe();
        tokio::spawn(async move {
            loop {
                let result = {
                    let local = manager.local.lock().unwrap();
                    let child = &local.sessions[&id];
                    let receipt = child.receipts.get(&prompt_id);
                    match receipt.map(|receipt| receipt.state.as_str()) {
                        Some("completed") => Some(Ok(child.handle.clone())),
                        Some("failed" | "interrupted" | "unknown" | "unknown_after_restart") => {
                            Some(Err(receipt.and_then(|r| r.error.clone()).unwrap_or_else(
                                || "Child task failed or its outcome is uncertain".into(),
                            )))
                        }
                        _ if matches!(
                            child.state,
                            SessionState::Failed | SessionState::Closed | SessionState::ProcessLost
                        ) =>
                        {
                            Some(Err("Child runtime is unavailable".into()))
                        }
                        _ => None,
                    }
                };
                if let Some(outcome) = result {
                    let mut reply = json!({"id":key,"session_id":id});
                    match outcome {
                        Ok(Some(child)) => match child.last_text().await {
                            Ok(text) => {
                                reply["result"] =
                                    json!(text.chars().take(32768).collect::<String>())
                            }
                            Err(_) => {
                                reply["error"] = json!(
                                    "Child completed; result is available in its saved history"
                                )
                            }
                        },
                        Ok(None) => {
                            reply["error"] = json!("Child completed; runtime is no longer attached")
                        }
                        Err(error) => reply["error"] = json!(error),
                    }
                    {
                        let mut local = manager.local.lock().unwrap();
                        if local.append(&parent, "child", json!({"id":id,"request_id":request,"tool_call_id":tool_call_id,"state":if reply.get("error").is_some() {"failed"} else {"completed"},"result":reply}), None).is_err() { return; }
                    }
                    let _ = handle.child_result(&request, reply).await;
                    return;
                }
                if manager.is_stopping() || changed.changed().await.is_err() {
                    return;
                }
            }
        });
        Ok(())
    }
}

/// Harnesses a child sharing its parent's sandbox may run. Cursor and fx children run in sandboxes of their own.
const CHILD_HARNESSES: [runtime::Kind; 11] = [
    runtime::Kind::Codex,
    runtime::Kind::Claude,
    runtime::Kind::Pi,
    runtime::Kind::OpenCode,
    runtime::Kind::Hermes,
    runtime::Kind::Devin,
    runtime::Kind::Droid,
    runtime::Kind::Kimi,
    runtime::Kind::Antigravity,
    runtime::Kind::OpenClaw,
    runtime::Kind::AgentZero,
];
pub(super) const FINISHED: [&str; 5] = [
    "completed",
    "failed",
    "interrupted",
    "unknown",
    "unknown_after_restart",
];
/// How long a child stays quiet before its parent hears of the turns it began itself (#217).
pub(super) const QUIET_MS: u64 = 2 * 60 * 1000;
/// Self-started turns that ended before this (ms) report at once: the sandbox was about to sleep (`flush_held`).
static FLUSH_BEFORE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// When a self-started turn that replied ended, which its receipt keeps (#217). A failed one reports at once.
fn replied(r: &Receipt) -> Option<u64> {
    (r.command == "auto" && r.input["replied"] == true && r.error.is_none())
        .then(|| r.input["ended"].as_u64())
        .flatten()
}

/// A child's finished turns its parent hasn't heard of (`told`), each with when it is due. A prompt's turn reports at
/// once, and so does one the harness began itself (#217) that failed. One that replied waits until the child has been
/// quiet for `QUIET_MS` (no turn running, none it began itself ending), so a child polling a job doesn't wake its
/// parent on every check; then only the newest reports, and older ones count as told with it. An empty one never
/// reports (F#427), nor one from an older Core, which lacks `report`: an update never sends them.
pub(super) fn untold(s: &Session, told: impl Fn(&Receipt) -> bool) -> Vec<(&Receipt, u64)> {
    let (told, owed): (Vec<_>, Vec<_>) = (s.receipts.values())
        .filter(|r| FINISHED.contains(&r.state.as_str()))
        .filter(|r| {
            r.command == "prompt"
                || (r.command == "auto"
                    && r.input["report"] == true
                    && (r.error.is_some() || replied(r).is_some()))
        })
        .partition(|r| told(r));
    let last_told = told.into_iter().filter_map(replied).max();
    let newest = owed.iter().filter_map(|r| replied(r)).max();
    // A child that can start no more turns owes them at once; one running a turn isn't quiet.
    let ended = (s.receipts.values()).filter(|r| r.command == "auto");
    let quiet = if s.archived || s.close_request.is_some() || s.state == SessionState::Closed {
        0
    } else if s.current_request.is_some() {
        u64::MAX
    } else {
        let last = ended.filter_map(|r| r.input["ended"].as_u64()).max();
        let last = last.unwrap_or(0);
        if last <= FLUSH_BEFORE.load(std::sync::atomic::Ordering::Relaxed) {
            0
        } else {
            last.saturating_add(QUIET_MS)
        }
    };
    let mut owed: Vec<_> = (owed.into_iter())
        .filter_map(|r| match replied(r) {
            None => Some((r, 0)),
            Some(at) => (Some(at) == newest && Some(at) > last_told).then_some((r, quiet)),
        })
        .collect();
    // Oldest first, as the turns ended, not by request ID (`auto_` sorts first): after a retry too, the parent's last
    // word is the newest. Ones from an older Core, without `ended`, go first.
    owed.sort_by_key(|(r, _)| r.input["ended"].as_u64().unwrap_or(0));
    owed
}

/// A child's turns its parent hasn't heard of, if it tells one: in another sandbox through the website, or in this one
/// (`true`), as long as that parent is open. A turn marked reported counts as heard of either way.
fn owed_by<'a>(local: &'a Local, c: &'a Session) -> Option<(Vec<(&'a Receipt, u64)>, bool)> {
    if c.parent_thread().is_some() {
        return Some((untold(c, |r| c.reported.contains(&r.request_id)), false));
    }
    let p = (c.parent_session.as_ref())
        .and_then(|p| local.sessions.get(p))
        .filter(|p| p.close_request.is_none() && p.state != SessionState::Closed)?;
    notifies(c).then(|| (untold(c, |r| notified(p, c, r)), true))
}

/// The reports children here hold until they are quiet (#217): whether one still waits, and whether one is due for a
/// parent in this sandbox but its notice isn't queued yet (one for another sandbox is `report_pending`'s).
fn holding(local: &Local) -> (bool, bool) {
    let now = now_ms();
    let (mut held, mut unqueued) = (false, false);
    for c in local.sessions.values() {
        let Some((owed, here)) = owed_by(local, c) else {
            continue;
        };
        for (_, at) in owed
            .iter()
            .filter(|(r, at)| replied(r).is_some() && *at != u64::MAX)
        {
            held |= *at > now;
            unqueued |= *at <= now && here;
        }
    }
    (held, unqueued)
}

/// Before the sandbox sleeps (drain): a report a child still holds until it is quiet (#217) is sent now instead, so it
/// never keeps the sandbox awake, nor waits for a wake that may not come. True when one was.
pub(super) fn flush_held(local: &Local) -> bool {
    let (held, _) = holding(local);
    if held {
        FLUSH_BEFORE.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
        local.changed.send_modify(|_| {});
    }
    held
}

/// A report `flush_held` sent to a parent in this sandbox whose notice isn't queued yet.
pub(super) fn unqueued(local: &Local) -> bool {
    holding(local).1
}

/// A turn its parent hears of at once (a prompt's, or a self-started one that failed) is newer than the report its child
/// still holds until quiet (#217): that one, and so every older one, is marked reported without a notice, so the
/// parent's last word is the newest. Its text stays in the thread.
pub(super) fn supersede(local: &mut Local, id: &str, ended: &Receipt) -> Result<()> {
    let at_once = ended.command == "prompt" || (ended.command == "auto" && ended.error.is_some());
    let Some(c) =
        (local.sessions.get(id)).filter(|_| at_once && FINISHED.contains(&ended.state.as_str()))
    else {
        return Ok(());
    };
    let moot: Vec<String> = owed_by(local, c).map_or(vec![], |(owed, _)| {
        (owed.into_iter())
            .filter(|(r, _)| replied(r).is_some())
            .map(|(r, _)| r.request_id.clone())
            .collect()
    });
    for request in moot {
        local.append(id, "parent_report", json!({"request_id":request}), None)?;
    }
    Ok(())
}

/// A child that tells its parent in this sandbox when its turns end.
fn notifies(c: &Session) -> bool {
    (c.receipts.values()).any(|r| r.command == "start" && r.input["notify"] == true)
}

/// Whether the parent has the notice for child `c`'s turn: delivered, or still being steered into the turn it targets,
/// or none is owed since a newer turn's report covers it (`supersede`).
fn notified(p: &Session, c: &Session, r: &Receipt) -> bool {
    let (steer, queued) = notice_ids(&c.session_id, &r.request_id);
    let legacy = legacy_notice_id(&c.session_id, &r.request_id);
    // A steer whose turn ends first may still reach the agent, so it settles before any queued copy (#1579). Only one
    // that failed, or whose agent was lost (its turn ended unknown, or no agent runs), falls back to the queue.
    let lost = |s: &Receipt| {
        let target = s.input["target_request_id"].as_str();
        p.handle.is_none()
            || target
                .and_then(|t| p.receipts.get(t))
                .is_some_and(|t| t.state.starts_with("unknown"))
    };
    let steered = |s: &Receipt| s.state == "completed" || (s.state == "accepted" && !lost(s));
    c.reported.contains(&r.request_id)
        || p.receipts.contains_key(&queued)
        || p.receipts.contains_key(&legacy)
        || p.receipts.get(&steer).is_some_and(steered)
        || p.receipts
            .get(&format!("{legacy}_steer"))
            .is_some_and(steered)
}

/// Waits for a change, or until `due` (ms) when a held report falls due. False once nothing will change again.
pub(super) async fn changed_or_due(changed: &mut watch::Receiver<u64>, due: Option<u64>) -> bool {
    match due.filter(|at| *at != u64::MAX) {
        Some(at) => {
            let wait = Duration::from_millis(at.saturating_sub(now_ms()));
            !matches!(
                tokio::time::timeout(wait, changed.changed()).await,
                Ok(Err(_))
            )
        }
        None => changed.changed().await.is_ok(),
    }
}

/// How much of a child's reply its parent's notice quotes, as for Local threads.
pub(super) const NOTICE_REPLY_CHARS: usize = 4000;
/// How much of a child's reply the journal keeps. The whole latest one sits in a file beside it (#280).
const SAVED_REPLY_CHARS: usize = 32768;

/// The journal's copy of a child's reply, marked when cut so it is never silently short.
pub(super) fn capped_reply(text: &str) -> String {
    let total = text.chars().count();
    let mut kept: String = text.chars().take(SAVED_REPLY_CHARS).collect();
    if total > SAVED_REPLY_CHARS {
        kept.push_str(&format!(
            "\n\n[reply truncated: {total} chars, showing first {SAVED_REPLY_CHARS}]"
        ));
    }
    kept
}

/// A child's whole latest reply, kept outside the history journal so history stays small.
fn reply_file(state_dir: &std::path::Path, child: &str) -> std::path::PathBuf {
    state_dir.join("replies").join(format!("{child}.json"))
}

/// Saves a child's whole reply for `thread output`. Best effort: the journal keeps a capped copy.
pub(super) fn save_reply(state_dir: &std::path::Path, child: &str, request: &str, text: &str) {
    let file = reply_file(state_dir, child);
    let temporary = file.with_extension("tmp");
    let saved = std::fs::create_dir_all(state_dir.join("replies"))
        .and_then(|_| {
            std::fs::write(
                &temporary,
                json!({"request_id":request,"text":text}).to_string(),
            )
        })
        .and_then(|_| std::fs::rename(&temporary, &file));
    if saved.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
}

/// The whole saved reply to `request`, or else the journal's copy of it.
fn saved_reply(
    state_dir: &std::path::Path,
    child: &str,
    (request, kept): &(String, String),
) -> String {
    std::fs::read(reply_file(state_dir, child))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(|saved| saved["request_id"] == request.as_str())
        .and_then(|saved| saved["text"].as_str().map(str::to_owned))
        .unwrap_or_else(|| kept.clone())
}

/// A child thread the parent does not wait for: `room-cli thread spawn`, or the app's API.
pub struct Spawn {
    pub harness: Option<runtime::Kind>,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub title: Option<String>,
    pub prompt: String,
    /// `fast` runs the child's turns in the harness's fast tier, where it has one.
    pub service_tier: Option<String>,
}

/// A side chat's source (ADR 0189): `session`'s conversation, cut before user message `before`
/// (Claude Code) or after turn `last_turn_id` (Codex). Without either, the whole conversation.
/// A `fresh` side chat (ADR 0273) copies no conversation: a new agent in the source's folder.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ForkFrom {
    pub session: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fresh: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub through: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn_id: Option<String>,
}

/// The session a side chat was forked from.
fn fork_of(session: &Session) -> Option<&str> {
    let start = session.receipts.values().find(|r| r.command == "start")?;
    start.input["fork"]["session"].as_str()
}

/// Whether `child` was started by `ancestor` or by a thread under it.
fn under(local: &Local, ancestor: &str, child: &Session) -> bool {
    let mut parent = child.parent_session.as_deref();
    // Bounded, in case saved history ever holds a parent loop.
    for _ in 0..local.sessions.len() {
        match parent {
            Some(p) if p == ancestor => return true,
            Some(p) => {
                parent = local
                    .sessions
                    .get(p)
                    .and_then(|s| s.parent_session.as_deref())
            }
            None => return false,
        }
    }
    false
}

/// The session `session` took over in Core's own agent switch or project move (#237), recorded by Core, while that
/// one can't run: closed, closing, or crashed (a lost agent can't be closed). One resumed again counts no more.
fn continued_from<'a>(local: &'a Local, session: &Session) -> Option<&'a str> {
    let from = session.continued.as_ref()?["from"].as_str()?;
    let (from, old) = local.sessions.get_key_value(from)?;
    let gone = matches!(
        old.state,
        SessionState::Closing
            | SessionState::Closed
            | SessionState::Failed
            | SessionState::ProcessLost
    );
    (gone || old.close_request.is_some()).then_some(from.as_str())
}

/// Any thread above a child may use it, so no grandchild outlives the threads above it.
/// A side chat may use the child threads of the thread it was forked from, like its own,
/// and a session the child threads of the sessions it continued once they closed (#1296).
fn may_use(local: &Local, caller: &str, child: &Session) -> bool {
    let mut caller = Some(caller);
    // Bounded, in case saved history ever holds a loop.
    for _ in 0..=local.sessions.len() {
        let Some(id) = caller else { return false };
        let session = local.sessions.get(id);
        if under(local, id, child)
            || session
                .and_then(fork_of)
                .is_some_and(|source| under(local, source, child))
        {
            return true;
        }
        caller = session.and_then(|s| continued_from(local, s));
    }
    false
}

pub(super) const NOT_IN_TREE: &str = "not in this thread's tree: tell reaches its subagents, its parent (`room-cli thread tell --parent TEXT`) and the threads under its parent";

/// `thread tell` also reaches the caller's parent and every thread under that parent, like Local threads (#177).
/// Some(true) for a thread the caller may use, Some(false) for the others, which see who sent it.
pub(super) fn may_tell(local: &Local, caller: &str, target: &str) -> Option<bool> {
    let t = local.sessions.get(target)?;
    let parent = local.sessions.get(caller)?.parent_session.as_deref();
    if may_use(local, caller, t) {
        Some(true)
    } else {
        (target != caller && parent.is_some_and(|p| p == target || under(local, p, t)))
            .then_some(false)
    }
}

/// The latest saved history of a side chat's source, read as the side chat launches.
pub(super) fn fork_history(
    local: &Local,
    id: &str,
    request: &str,
) -> io::Result<Option<runtime::Fork>> {
    let Some(fork) = local.sessions[id]
        .receipts
        .get(request)
        .map(|r| &r.input["fork"])
    else {
        return Ok(None);
    };
    if fork.is_null() {
        return Ok(None);
    }
    let fork: ForkFrom = serde_json::from_value(fork.clone())?;
    if fork.fresh {
        return Ok(None);
    }
    let source = local.sessions.get(&fork.session).and_then(|s| s.resume());
    Ok(Some(runtime::Fork {
        source: source.ok_or_else(|| io::Error::other("the side chat's source is unavailable"))?,
        before: fork.before,
        through: fork.through,
        last_turn_id: fork.last_turn_id,
    }))
}

/// A notice's two delivery attempts: steered into the parent's running turn, then queued as a prompt.
/// Request IDs hold at most 64 characters, so a longer one becomes a stable FNV-1a hash.
pub(super) fn notice_ids(child: &str, request: &str) -> (String, String) {
    let mut queued = legacy_notice_id(child, request);
    if queued.len() + "_steer".len() > 64 {
        let hash = queued.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        });
        queued = format!("notice_{hash:016x}");
    }
    (format!("{queued}_steer"), queued)
}

/// Core 0.1.57 and older never shortened it, so a notice they delivered is still found.
fn legacy_notice_id(child: &str, request: &str) -> String {
    format!("notice_{child}_{request}")
}

/// A thread as `room-cli thread list`, `show` and `status` print it. `reasoningLevel`, `threadId` and `projectId` are the
/// Local CLI's names (ADR 20261110-235800): the running turn's effort as sent to the agent, else the session's, and the
/// app's IDs from the start. Null when Core wasn't told: an effort left to the agent's default, a shared child the app
/// hasn't named yet. Its parent is named as the parent's own `status` names it: the app's thread ID when Core has it
/// (#1803).
fn item(local: &Local, c: &Session) -> Value {
    let busy = c.current_request.is_some() || c.has_work() || c.compacting;
    let reasoning = match &c.turn_reasoning {
        Some((request, sent)) if c.current_request.as_ref() == Some(request) => sent.clone(),
        _ => (c.current_request.as_ref())
            .and_then(|r| prompt::latest(&c.prompts, &c.receipts, r))
            .and_then(prompt::reasoning)
            .or_else(|| c.reasoning.clone()),
    };
    let parent = c.parent_session.as_deref().map(|p| {
        let session = local.sessions.get(p);
        session.and_then(Session::thread_id).unwrap_or(p)
    });
    json!({"id":c.session_id,"title":title(c),"harness":c.harness,"model":c.model,"reasoningLevel":reasoning,"state":c.state,"status":status(c.state.name(), busy),"busy":busy,"error":c.failure.clone().or_else(|| c.last_prompt_error.clone()),"archived":c.archived,"parent":parent.or(c.parent_thread()),"threadId":c.thread_id(),"projectId":c.project_id()})
}

/// The shared child's parent session when `id` is the thread ID its `status` names that parent by, so a `tell` to it
/// stays in this sandbox, as `tell --parent` does, instead of going to the website, which can't send it back (#1803).
pub(super) fn local_parent(local: &Local, sender: &str, id: &str) -> Option<String> {
    let parent = local.sessions.get(sender)?.parent_session.as_deref()?;
    (local.sessions.get(parent)?.thread_id() == Some(id)).then(|| parent.to_owned())
}

/// The calling thread under the app's thread ID, as `ROOM_THREAD_ID`, spawn and the website name it, not Core's
/// session ID (#1803). A shared child or an older start has none: its session ID, which its parent's commands take,
/// stays.
fn this_thread(local: &Local, id: &str) -> Option<Value> {
    let session = local.sessions.get(id)?;
    let mut thread = item(local, session);
    if let Some(thread_id) = session.thread_id() {
        thread["id"] = json!(thread_id);
    }
    // The app names a top-level thread, so Core often has no title: leave it out instead of saying null.
    if thread["title"].is_null() {
        thread.as_object_mut()?.remove("title");
    }
    Some(thread)
}

/// The Local CLI's word for a Cloud `state`, so one filter reads both (ADR 20261110-235800).
pub(super) fn status(state: &str, busy: bool) -> &'static str {
    match state {
        "failed" | "process_lost" | "error" => "error",
        "pending" | "waiting_for_files" | "starting" | "resuming" | "starting_turn" | "running"
        | "interrupting" | "rewinding" => "active",
        _ if busy => "active",
        _ => "idle",
    }
}

fn title(session: &Session) -> Option<String> {
    session
        .receipts
        .values()
        .find(|r| r.command == "start")
        .and_then(|r| r.input["title"].as_str())
        .map(str::to_owned)
}

pub(super) fn notice(
    child: &str,
    title: Option<String>,
    state: &str,
    error: Option<String>,
    reply: Option<String>,
) -> String {
    let name = title.map_or(child.to_owned(), |t| format!("\"{t}\" ({child})"));
    match state {
        "completed" => {
            let reply = reply.filter(|r| !r.trim().is_empty()).map_or(
                format!(
                    "Its reply is in its thread; read it with `room-cli thread output {child}`."
                ),
                |r| {
                    let mut text: String = r.trim().chars().take(NOTICE_REPLY_CHARS).collect();
                    if r.trim().chars().count() > NOTICE_REPLY_CHARS {
                        text.push_str(&format!("\n\n[... reply truncated. Read all of it with `room-cli thread output {child}` ...]"));
                    }
                    text
                },
            );
            format!("[Cloudroom] Child thread {name} completed:\n\n{reply}")
        }
        "interrupted" => format!(
            "[Cloudroom] Child thread {name} was interrupted. If the user stopped it, do not restart or replace its work unless they ask."
        ),
        // It continues by itself at the reset or after an account switch (accounts.rs).
        _ if error
            .as_deref()
            .is_some_and(|e| e.contains(crate::runtime::PLAN_LIMIT)) =>
        {
            format!(
                "[Cloudroom] Child thread {name} failed or its outcome is uncertain. Cause: {} Do not resend its task.",
                error.unwrap_or_default().trim()
            )
        }
        _ => {
            let cause = error.map_or(String::new(), |e| {
                let oom = if e.contains("signal 9") {
                    " Signal 9 usually means the sandbox ran out of memory."
                } else {
                    ""
                };
                format!(" Cause: {}.{oom} Its turn did not finish; resend the task if it still matters.", e.trim().trim_end_matches('.'))
            });
            format!(
                "[Cloudroom] Child thread {name} failed or its outcome is uncertain.{cause} Check it with `room-cli thread output {child}` before deciding next steps."
            )
        }
    }
}

/// A level a Claude child's model's own row lacks is refused as for a model its catalog lists; `none` always runs.
pub(super) fn claude_effort_refusal(
    claude: Option<&(String, Vec<String>)>,
    reasoning: Option<&str>,
) -> Option<Error> {
    let ((model, levels), reasoning) = (claude?, reasoning.filter(|r| *r != "none")?);
    let row = [runtime::Model {
        model: model.clone(),
        reasoning_levels: levels.clone(),
        service_tiers: Vec::new(),
    }];
    let refusal = runtime::supports(runtime::Kind::Claude, &row, model, reasoning).err();
    refusal.map(Error::Effort)
}

/// How long a child keeps asking again when its account check could not finish (#1949).
const UNVERIFIED_RETRY: Duration = Duration::from_secs(20);

impl Manager {
    /// An account check that could not finish is kept only 2 s (auth.rs), so a child asks again every 3 s for a
    /// while, like the website's starts (#826). Missing or rejected logins and usage limits fail at once.
    async fn child_harness_ready(self: &Arc<Self>, kind: runtime::Kind) -> Result<()> {
        let started = Instant::now();
        loop {
            match self.harness_ready(kind).await {
                Err(Error::Conflict(why)) if why.contains("account could not be verified") => {
                    if started.elapsed() >= UNVERIFIED_RETRY {
                        return Err(Error::Refused(format!(
                            "{why}. Cloudroom retried for {} seconds and started no child; try again in a minute",
                            UNVERIFIED_RETRY.as_secs()
                        )));
                    }
                }
                other => return other,
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    }

    /// Starts a child thread in the parent's folder with any supported harness and model. The parent keeps
    /// working; Core queues it a notice whenever one of the child's turns ends, even while the app is offline.
    pub async fn spawn_child(
        self: &Arc<Self>,
        parent: &str,
        key: &str,
        spawn: Spawn,
    ) -> Result<(String, Receipt)> {
        let id = format!("cr_child_{key}");
        let start_id = format!("child_{key}");
        // A Claude model's own row gives a child with no effort `none` if it takes none, and refuses a level it lacks (#1059).
        let claude = match spawn.reasoning.as_deref() {
            Some("none") => None,
            _ => {
                self.child_claude_levels(parent, spawn.harness, spawn.model.as_deref())
                    .await
            }
        };
        let no_effort =
            spawn.reasoning.is_none() && claude.as_ref().is_some_and(|(_, l)| *l == ["none"]);
        let (kind, input, model, provider, workspace) = {
            let local = self.local.lock().unwrap();
            let p = local.sessions.get(parent).ok_or(Error::NotFound)?;
            if p.close_request.is_some() || p.state == SessionState::Closed {
                return Err(Error::Conflict("the parent thread is closed"));
            }
            let kind = spawn.harness.unwrap_or(p.harness);
            if !CHILD_HARNESSES.contains(&kind) {
                return Err(Error::Conflict(
                    "Only codex, claude-code, pi, opencode, hermes, devin, droid, kimi, antigravity, openclaw and agent-zero children can share this sandbox. Omit --shared-sandbox to start it in a sandbox of its own.",
                ));
            }
            let same = kind == p.harness;
            // Pi models are `provider/model`, as in the app's picker.
            let split = spawn
                .model
                .as_deref()
                .filter(|_| kind == runtime::Kind::Pi)
                .and_then(|m| m.split_once('/'))
                .filter(|(provider, name)| !provider.is_empty() && !name.is_empty());
            let (chosen_provider, chosen_model) = match split {
                Some((provider, name)) => (Some(provider.to_owned()), Some(name.to_owned())),
                None => (None, spawn.model.clone()),
            };
            let model = chosen_model
                .clone()
                .or(same.then(|| p.model.clone()).flatten());
            // Many Pi models lack "medium" (DeepSeek V4, Kimi K3), so Pi keeps its own default level.
            let reasoning = spawn
                .reasoning
                .clone()
                .or(no_effort.then(|| "none".into()))
                .or(same.then(|| p.reasoning.clone()).flatten())
                .or((kind != runtime::Kind::Pi).then(|| "medium".into()));
            let mut input =
                json!({"harness":kind,"parent_session":parent,"prompt":spawn.prompt,"notify":true});
            if let Some(reasoning) = &reasoning {
                input["reasoning"] = json!(reasoning);
            }
            if let Some(model) = &chosen_model {
                input["model"] = json!(model);
            }
            if let Some(provider) = &chosen_provider {
                input["provider"] = json!(provider);
            }
            if let Some(title) = &spawn.title {
                input["title"] = json!(title);
            }
            if let Some(tier) = &spawn.service_tier {
                if tier == "fast" && !kind.fast() {
                    return Err(Error::Conflict("invalid service tier"));
                }
                input["service_tier"] = json!(tier);
            }
            if !p.command_guard_enabled() {
                input["command_guard_enabled"] = json!(false);
            }
            if !p.strip_ai_co_authors() {
                input["strip_ai_co_authors"] = json!(false);
            }
            if let Some(system_prompt) = p.system_prompt() {
                input["system_prompt"] = json!(system_prompt);
            }
            if let Some(project) = p.project_id() {
                input["project_id"] = json!(project);
            }
            if let Some(existing) = local.sessions.get(&id) {
                return Self::retry(existing, &start_id, "start", &input)?
                    .map(|r| (id.clone(), r))
                    .ok_or(Error::Conflict("child identity conflict"));
            }
            let provider = chosen_provider.or(same.then(|| p.provider.clone()).flatten());
            (kind, input, model, provider, p.workspace.clone())
        };
        if !self.recording_available() {
            return Err(Error::Storage(JOURNAL_UNWRITABLE.into()));
        }
        if !self.config.harnesses.contains_key(&kind) {
            return Err(Error::Conflict("harness is not configured"));
        }
        self.child_harness_ready(kind).await?;
        let (model, provider) = if kind == runtime::Kind::Pi {
            self.keyed_pi_model(parent, spawn.model.as_deref(), model, provider)
                .await
        } else {
            (model, provider)
        };
        if let Some(reasoning) = input["reasoning"].as_str()
            && let Err(error) = self
                .execution_supported(kind, model.as_ref(), reasoning)
                .await
        {
            let selected = model
                .as_ref()
                .unwrap_or(&self.config.harnesses[&kind].model);
            return Err(match error {
                Error::Conflict("invalid reasoning effort") => self
                    .effort_refusal(kind, selected, reasoning)
                    .await
                    .unwrap_or(error),
                error => error,
            });
        }
        if let Some(error) = claude_effort_refusal(claude.as_ref(), input["reasoning"].as_str()) {
            return Err(error);
        }
        let profile = &self.config.harnesses[&kind];
        let receipt = Receipt {
            request_id: start_id.clone(),
            command: "start".into(),
            input,
            state: "accepted".into(),
            model: Some(model.unwrap_or_else(|| profile.model.clone())),
            provider: provider.or_else(|| profile.provider.clone()),
            workspace,
            error: None,
        };
        {
            let mut local = self.local.lock().unwrap();
            if let Some(existing) = local.sessions.get(&id) {
                return Self::retry(existing, &start_id, "start", &receipt.input)?
                    .map(|r| (id.clone(), r))
                    .ok_or(Error::Conflict("child identity conflict"));
            }
            if self.is_stopping() || local.draining || self.storage.blocks() {
                return Err(Error::Conflict(
                    "new execution is paused; try again shortly",
                ));
            }
            local.append(
                &id,
                "receipt",
                serde_json::to_value(&receipt).map_err(io::Error::other)?,
                None,
            )?;
            // Its own record kind: apps that predate child threads ignore it instead of failing on it.
            local.append(
                parent,
                "child_thread",
                json!({"id":id,"harness":kind,"title":receipt.input["title"]}),
                None,
            )?;
            self.watch_child(&local, id.clone(), Vec::new());
        }
        let (manager, child) = (self.clone(), id.clone());
        tokio::spawn(async move {
            manager.launch(child, start_id).await;
        });
        Ok((id, receipt))
    }

    /// A Claude child's model and its own row's levels, read before the spawn settles its effort (#1059).
    pub(super) async fn child_claude_levels(
        self: &Arc<Self>,
        parent: &str,
        harness: Option<runtime::Kind>,
        model: Option<&str>,
    ) -> Option<(String, Vec<String>)> {
        let claude = runtime::Kind::Claude;
        let model = {
            let local = self.local.lock().unwrap();
            let p = local.sessions.get(parent)?;
            let kind = harness.unwrap_or(p.harness);
            if kind != claude {
                return None;
            }
            let model = model.map(str::to_owned);
            model.or((kind == p.harness).then(|| p.model.clone()).flatten())
        };
        let model = model.or_else(|| Some(self.config.harnesses.get(&claude)?.model.clone()))?;
        let levels = self.claude_levels(&model).await?;
        Some((model, levels))
    }

    /// `anthropic/claude-opus-5.5` from a parent on OpenRouter may name OpenRouter's model of that
    /// ID. Like Pi's own `--model`, prefer the parent's provider when only it has a key.
    async fn keyed_pi_model(
        &self,
        parent: &str,
        requested: Option<&str>,
        model: Option<String>,
        provider: Option<String>,
    ) -> (Option<String>, Option<String>) {
        let found = {
            let local = self.local.lock().unwrap();
            local
                .sessions
                .get(parent)
                .filter(|p| p.harness == runtime::Kind::Pi)
                .and_then(|p| p.handle.clone())
                .and_then(|h| Some((h.provider()?.to_owned(), h)))
        };
        let (Some(requested), Some(name), Some(chosen), Some((own, handle))) =
            (requested, model.as_deref(), provider.as_deref(), found)
        else {
            return (model, provider);
        };
        if own != chosen
            && handle.pi_has_key(&own, requested).await.unwrap_or(false)
            && !handle.pi_has_key(chosen, name).await.unwrap_or(true)
        {
            return (Some(requested.to_owned()), Some(own));
        }
        (model, provider)
    }

    /// Starts a side chat: a new session on a copy of another session's conversation, in its folder,
    /// with its harness, model and settings. The source keeps working and is only read.
    pub async fn fork(
        self: &Arc<Self>,
        request: String,
        harness: Option<runtime::Kind>,
        fork: ForkFrom,
    ) -> Result<(String, Receipt)> {
        let id = format!("cr_{request}");
        let invalid = |v: &Option<String>| {
            v.as_ref()
                .is_some_and(|v| v.is_empty() || v.len() > 256 || v.chars().any(char::is_control))
        };
        let (kind, input, model, provider, workspace) = {
            let local = self.local.lock().unwrap();
            let s = local.sessions.get(&fork.session).ok_or(Error::Conflict(
                "the side chat's source thread was not found",
            ))?;
            let checkpoint_fits = match s.harness {
                _ if fork.fresh => {
                    fork.before.is_none() && fork.through.is_none() && fork.last_turn_id.is_none()
                }
                runtime::Kind::Claude => {
                    fork.last_turn_id.is_none() && (fork.before.is_none() || fork.through.is_none())
                }
                runtime::Kind::Codex => fork.before.is_none() && fork.through.is_none(),
                _ => return Err(Error::Conflict("side chats support Claude Code and Codex")),
            };
            if !checkpoint_fits
                || invalid(&fork.before)
                || invalid(&fork.through)
                || invalid(&fork.last_turn_id)
                || harness.is_some_and(|kind| kind != s.harness)
            {
                return Err(Error::Conflict("invalid side chat request"));
            }
            let mut input = json!({"harness":s.harness,"fork":fork,"reasoning":s.reasoning});
            if !s.command_guard_enabled() {
                input["command_guard_enabled"] = json!(false);
            }
            if !s.strip_ai_co_authors() {
                input["strip_ai_co_authors"] = json!(false);
            }
            if let Some(system_prompt) = s.system_prompt() {
                input["system_prompt"] = json!(system_prompt);
            }
            if let Some(project) = s.project_id() {
                input["project_id"] = json!(project);
            }
            if let Some(existing) = local.sessions.get(&id) {
                return Self::retry(existing, &request, "start", &input)?
                    .map(|r| (id.clone(), r))
                    .ok_or(Error::Conflict("session already exists"));
            }
            if !fork.fresh && (s.resume().is_none() || s.rewind_request.is_some()) {
                return Err(Error::Conflict(
                    "the source thread has no saved conversation yet",
                ));
            }
            if !fork.fresh
                && fork.before.is_none()
                && fork.through.is_none()
                && fork.last_turn_id.is_none()
                && (s.busy() || s.compacting)
            {
                return Err(Error::Conflict(
                    "the source agent is busy; fork from an earlier message or try again shortly",
                ));
            }
            (
                s.harness,
                input,
                s.model.clone(),
                s.provider.clone(),
                s.workspace.clone(),
            )
        };
        if !self.recording_available() {
            return Err(Error::Storage(JOURNAL_UNWRITABLE.into()));
        }
        if !self.config.harnesses.contains_key(&kind) {
            return Err(Error::Conflict("harness is not configured"));
        }
        self.harness_ready(kind).await?;
        let receipt = Receipt {
            request_id: request.clone(),
            command: "start".into(),
            input,
            state: "accepted".into(),
            model: Some(model.unwrap_or_else(|| self.config.harnesses[&kind].model.clone())),
            provider,
            workspace,
            error: None,
        };
        {
            let mut local = self.local.lock().unwrap();
            if let Some(existing) = local.sessions.get(&id) {
                return Self::retry(existing, &request, "start", &receipt.input)?
                    .map(|r| (id.clone(), r))
                    .ok_or(Error::Conflict("session already exists"));
            }
            if self.is_stopping() || local.draining || self.storage.blocks() {
                return Err(Error::Conflict(
                    "new execution is paused; try again shortly",
                ));
            }
            let value = serde_json::to_value(&receipt).map_err(io::Error::other)?;
            local.append(&id, "receipt", value, None)?;
        }
        let (manager, session) = (self.clone(), id.clone());
        tokio::spawn(async move {
            manager.launch(session, request).await;
        });
        Ok((id, receipt))
    }

    /// Resumes parent notices for spawned children after a restart. Turns the restart cut off are
    /// not reported: the parent stopped too, and the app decides what runs next.
    pub(super) fn watch_children(self: &Arc<Self>, local: &Local) {
        for child in local.sessions.values() {
            if notifies(child) {
                let cut = child
                    .receipts
                    .values()
                    .filter(|r| matches!(r.state.as_str(), "unknown" | "unknown_after_restart"))
                    .map(|r| r.request_id.clone())
                    .collect();
                self.watch_child(local, child.session_id.clone(), cut);
            }
        }
    }

    /// Makes the kept live children directly under `parent`, which is being archived, top-level threads, so their
    /// reports never wake it (#603). The app detaches them too, once it sees the archive.
    pub(crate) fn detach_kept(&self, parent: &str, kept: &[String]) -> Result<()> {
        let mut local = self.local.lock().unwrap();
        for id in kept {
            let Some(session) = local.sessions.get(id) else {
                continue;
            };
            if session.parent_session.as_deref() == Some(parent) {
                local.append(id, "detach", json!({}), None)?;
            }
        }
        Ok(())
    }

    /// Makes a child a top-level thread, so its parent hears no more about it (docs/scopes/sandboxes.md).
    pub(crate) fn detach(&self, id: &str) -> Result<()> {
        let mut local = self.local.lock().unwrap();
        let session = local.sessions.get(id).ok_or(Error::NotFound)?;
        if session.parent_session.is_some() {
            local.append(id, "detach", json!({}), None)?;
        }
        Ok(())
    }

    /// Tells the parent about each finished child turn, until either thread closes. A busy parent
    /// gets the notice in its running turn, as in Local threads; otherwise it waits in the queue.
    fn watch_child(self: &Arc<Self>, local: &Local, child: String, cut: Vec<String>) {
        let manager = self.clone();
        let mut changed = local.changed.subscribe();
        tokio::spawn(async move {
            loop {
                let (due, held) = {
                    let local = manager.local.lock().unwrap();
                    let Some(c) = local.sessions.get(&child) else {
                        return;
                    };
                    let Some(p) = c
                        .parent_session
                        .as_ref()
                        .and_then(|p| local.sessions.get(p))
                    else {
                        return;
                    };
                    if p.close_request.is_some() || p.state == SessionState::Closed {
                        return;
                    }
                    let now = now_ms();
                    let owed = untold(c, |r| notified(p, c, r));
                    let owed = owed.iter().filter(|(r, _)| !cut.contains(&r.request_id));
                    let held = owed.clone().map(|(_, at)| *at).filter(|at| *at > now).min();
                    let finished = owed.clone().find(|(_, at)| *at <= now).map(|(r, _)| {
                        (
                            *r,
                            !p.receipts
                                .contains_key(&notice_ids(&child, &r.request_id).0),
                        )
                    });
                    let due = match finished {
                        Some((r, steer)) => Some((
                            p.session_id.clone(),
                            r.request_id.clone(),
                            r.state.clone(),
                            r.error.clone(),
                            c.replies
                                .iter()
                                .find(|(id, _)| *id == r.request_id)
                                .map(|(_, text)| text.clone()),
                            title(c),
                            p.current_request.clone().filter(|_| steer),
                        )),
                        None if c.close_request.is_some() || c.state == SessionState::Closed => {
                            return;
                        }
                        None => None,
                    };
                    (due, held)
                };
                if let Some((parent, request, state, error, reply, title, target)) = due {
                    let text = notice(&child, title, &state, error, reply);
                    let (steer, queued) = notice_ids(&child, &request);
                    // A turn that just ended, or a harness that cannot steer, falls back to the queue.
                    // Storage or a drain can refuse both; retry after a pause, or after the next restart.
                    if target.is_some_and(|target| {
                        manager
                            .command(
                                &parent,
                                steer,
                                "steer",
                                json!({"text":text,"target_request_id":target}),
                            )
                            .is_ok()
                    }) || manager
                        .command(&parent, queued, "prompt", json!({"text":text}))
                        .is_ok()
                    {
                        continue;
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
                if manager.is_stopping() || !changed_or_due(&mut changed, held).await {
                    return;
                }
            }
        });
    }

    /// The caller's own child or a child under it, for `room-cli thread output|tell|stop|archive`.
    pub(crate) fn own_child(&self, parent: &str, child: &str) -> Result<()> {
        let local = self.local.lock().unwrap();
        match local.sessions.get(child) {
            Some(c) if may_use(&local, parent, c) => Ok(()),
            _ => Err(Error::Conflict("not a child thread of this thread")),
        }
    }

    /// `thread tell`'s target: true for a thread under the caller, false for any other it may tell.
    pub(crate) fn tell_target(&self, caller: &str, target: &str) -> Result<bool> {
        may_tell(&self.local.lock().unwrap(), caller, target).ok_or(Error::Conflict(NOT_IN_TREE))
    }

    /// Every thread under `id`: its ID, whether it is archived, and whether to keep it open because it, a thread
    /// above it (below `id`), or a thread under it still works: a turn, queued prompts, or background jobs (#603).
    pub(crate) fn descendants(&self, id: &str) -> Vec<(String, bool, bool)> {
        let local = self.local.lock().unwrap();
        let all: Vec<&Session> = local
            .sessions
            .values()
            .filter(|c| under(&local, id, c))
            .collect();
        let live: Vec<&Session> = all
            .iter()
            .copied()
            .filter(|c| c.busy() || c.has_background_jobs())
            .collect();
        all.iter()
            .map(|c| {
                let keep = live.iter().any(|l| {
                    l.session_id == c.session_id
                        || under(&local, &c.session_id, l)
                        || under(&local, &l.session_id, c)
                });
                (c.session_id.clone(), c.archived, keep)
            })
            .collect()
    }

    /// The calling thread itself, for `room-cli status` and `thread show`.
    pub(crate) fn thread(&self, id: &str) -> Option<Value> {
        this_thread(&self.local.lock().unwrap(), id)
    }

    /// The caller's children, or one child with its latest reply: live when idle, else its last completed one.
    /// Archived children are listed only on request, but `only` still finds one.
    pub(crate) async fn children(&self, parent: &str, only: Option<&str>, archived: bool) -> Value {
        let (mut items, handle, kept) = {
            let local = self.local.lock().unwrap();
            let items: Vec<_> = local
                .sessions
                .values()
                .filter(|c| may_use(&local, parent, c))
                .filter(|c| only.map_or(archived || !c.archived, |id| c.session_id == id))
                .map(|c| item(&local, c))
                .collect();
            let child = only.and_then(|id| local.sessions.get(id));
            let handle = child
                .filter(|c| c.current_request.is_none())
                .and_then(|c| c.handle.clone());
            let kept = child.and_then(|c| Some((c.session_id.clone(), c.replies.last()?.clone())));
            (items, handle, kept)
        };
        // Read outside the lock: the whole reply may be large.
        let kept = kept.map(|(id, reply)| saved_reply(&self.config.state_dir, &id, &reply));
        let reply = match handle {
            // A harness shutting down refuses the read, and a resumed one has seen no text yet: use the saved reply.
            Some(handle) => handle
                .last_text()
                .await
                .ok()
                .filter(|t| !t.is_empty())
                .or(kept),
            None => kept,
        };
        if let (Some(item), Some(reply)) = (items.first_mut(), reply) {
            item["reply"] = json!(reply);
        }
        json!({"children":items})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_output_serves_the_whole_saved_reply_of_a_sleeping_child() {
        let dir = std::env::temp_dir().join(format!("cloudroom-replies-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let long = format!("{} END", "x".repeat(40000));
        let kept = ("p1".to_owned(), capped_reply(&long));
        assert!(
            kept.1
                .ends_with("[reply truncated: 40004 chars, showing first 32768]")
        );
        assert_eq!(saved_reply(&dir, "cr_child_a", &kept), kept.1);
        save_reply(&dir, "cr_child_a", "p1", &long);
        assert_eq!(saved_reply(&dir, "cr_child_a", &kept), long);
        // A file left from an older turn never stands in for a newer reply.
        let newer = ("p2".to_owned(), "newer".to_owned());
        assert_eq!(saved_reply(&dir, "cr_child_a", &newer), "newer");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// #1803: `status` names a thread by the app's ID, which `thread show` and `ROOM_THREAD_ID` use, and a shared
    /// child's parent the same way; a session without one keeps its session ID.
    #[test]
    fn status_names_threads_by_the_app_thread_id() {
        let dir = std::env::temp_dir().join(format!("cloudroom-status-ids-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut local = Local::open(&dir).unwrap();
        for (id, input) in [
            ("cr_top", json!({"thread_id":"thr_top"})),
            ("cr_sub_kid", json!({"parent_session":"cr_top"})),
            (
                "cr_own",
                json!({"thread_id":"thr_own","parent_thread":"thr_boss"}),
            ),
            ("cr_old", json!({})),
        ] {
            let start =
                json!({"request_id":"s","command":"start","state":"completed","input":input});
            local.append(id, "receipt", start, None).unwrap();
        }
        let ids = |id| {
            let t = this_thread(&local, id).unwrap();
            (t["id"].clone(), t["parent"].clone())
        };
        assert_eq!(ids("cr_top"), (json!("thr_top"), json!(null)));
        assert_eq!(ids("cr_sub_kid"), (json!("cr_sub_kid"), json!("thr_top")));
        assert_eq!(ids("cr_own"), (json!("thr_own"), json!("thr_boss")));
        assert_eq!(ids("cr_old"), (json!("cr_old"), json!(null)));
        // `thread tell` to the parent `status` printed reaches the parent session here, not the website.
        let parent = ids("cr_sub_kid").1;
        let tell = |sender, id| local_parent(&local, sender, id);
        assert_eq!(
            tell("cr_sub_kid", parent.as_str().unwrap()),
            Some("cr_top".to_owned())
        );
        assert_eq!(tell("cr_sub_kid", "thr_other"), None);
        assert_eq!(tell("cr_top", "thr_top"), None);
        // An own-sandbox child's parent thread goes to the website, as on main (relay.rs).
        assert_eq!(tell("cr_own", "thr_boss"), None);
        // In the parent's child list, the child keeps the session ID its commands take.
        assert_eq!(
            item(&local, &local.sessions["cr_sub_kid"])["id"],
            "cr_sub_kid"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// #1296: an agent switch or project move continues the thread in a new session; it keeps the old one's children
    /// once the old one closes, along the whole chain, also after a restart. Other sessions get nothing.
    #[test]
    fn a_continued_session_may_use_the_children_of_the_closed_one() {
        let dir = std::env::temp_dir().join(format!("cloudroom-continued-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut local = Local::open(&dir).unwrap();
        for (id, input) in [
            ("a", json!({})),
            ("kid", json!({"parent_session":"a"})),
            ("lost", json!({})),
            ("lost_kid", json!({"parent_session":"lost"})),
        ] {
            let start =
                json!({"request_id":"s","command":"start","state":"completed","input":input});
            local.append(id, "receipt", start, None).unwrap();
        }
        for (id, from) in [("b", "a"), ("c", "b"), ("x", "c"), ("after_crash", "lost")] {
            let start = json!({"request_id":"s","command":"start","state":"completed","input":{}});
            local.append(id, "receipt", start, None).unwrap();
            local
                .append(id, "continued", json!({"from":from}), None)
                .unwrap();
        }
        let start = json!({"request_id":"s","command":"start","state":"completed","input":{}});
        local.append("other", "receipt", start, None).unwrap();
        let use_kid = |local: &Local, caller| may_use(local, caller, &local.sessions["kid"]);
        assert!(!use_kid(&local, "b"), "a is still live");
        for id in ["a", "b"] {
            local
                .append(id, "state", json!({"state":"closed"}), None)
                .unwrap();
        }
        drop(local);
        let local = Local::open(&dir).unwrap();
        for (caller, allowed) in [
            ("a", true),
            ("b", true),
            ("c", true),
            ("x", false),
            ("other", false),
        ] {
            assert_eq!(use_kid(&local, caller), allowed, "{caller}");
        }
        // A switch away from a crashed parent, whose close Core refuses; until that parent runs again.
        let use_lost_kid =
            |local: &Local| may_use(local, "after_crash", &local.sessions["lost_kid"]);
        assert!(!use_lost_kid(&local), "lost is still live");
        let mut local = local;
        let lost = json!({"state":"process_lost"});
        local.append("lost", "state", lost, None).unwrap();
        drop(local);
        let mut local = Local::open(&dir).unwrap();
        assert!(use_lost_kid(&local), "after a restart too");
        assert_eq!(may_tell(&local, "after_crash", "lost_kid"), Some(true));
        local
            .append("lost", "state", json!({"state":"idle"}), None)
            .unwrap();
        assert!(!use_lost_kid(&local), "lost runs again");
        // `thread tell` checks again when its message is accepted (command_from): after a resume, refused.
        assert_eq!(may_tell(&local, "after_crash", "lost_kid"), None);
        assert_eq!(may_tell(&local, "lost", "lost_kid"), Some(true));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
