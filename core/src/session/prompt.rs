use super::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, fs, path::Path, sync::Mutex};

/// Claiming, putting back and adding a note take turns, so a note added mid-claim is never lost.
static NOTICE: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PromptState {
    pub revision: u64,
    pub input: Value,
    pub cancelled: bool,
}

pub fn text(input: &Value) -> String {
    input["text"].as_str().unwrap_or_default().to_owned()
}

pub fn reasoning(input: &Value) -> Option<String> {
    input["reasoning"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

pub fn service_tier(input: &Value) -> Option<String> {
    input["service_tier"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

pub fn prompt_payload(input: &Value) -> Value {
    let mut map = Map::new();
    map.insert("text".into(), Value::String(text(input)));
    if let Some(value) = reasoning(input) {
        map.insert("reasoning".into(), Value::String(value));
    }
    if let Some(value) = service_tier(input) {
        map.insert("service_tier".into(), Value::String(value));
    }
    for key in ["content", "attachments"] {
        if let Some(value) = input.get(key).filter(|value| !value.is_null()) {
            map.insert(key.into(), value.clone());
        }
    }
    Value::Object(map)
}

pub fn apply(prompts: &mut BTreeMap<String, PromptState>, receipt: &Receipt) {
    match receipt.command.as_str() {
        "prompt" if receipt.state == "accepted" => {
            prompts
                .entry(receipt.request_id.clone())
                .or_insert(PromptState {
                    revision: 1,
                    input: receipt.input.clone(),
                    cancelled: false,
                });
        }
        "edit" if receipt.state == "accepted" => {
            let Some(target) = receipt.input["target_request_id"].as_str() else {
                return;
            };
            if let Some(prompt) = prompts.get_mut(target)
                && !prompt.cancelled
            {
                prompt.revision = prompt.revision.saturating_add(1);
                let mut updated = prompt_payload(&receipt.input);
                for key in ["reasoning", "service_tier"] {
                    if updated.get(key).is_none()
                        && let Some(value) = prompt.input.get(key)
                    {
                        updated[key] = value.clone();
                    }
                }
                prompt.input = updated;
            }
        }
        "cancel" if matches!(receipt.state.as_str(), "accepted" | "completed") => {
            if let Some(target) = receipt.input["target_request_id"].as_str()
                && let Some(prompt) = prompts.get_mut(target)
            {
                prompt.cancelled = true;
            }
        }
        _ => {}
    }
}

/// The website leaves `notice` in the state folder when it restores a thread onto a fresh machine
/// (web/lib/sandboxes.ts). The next prompt the agent gets carries it, once: deleting the file claims it, so two
/// sessions never both add it. A prompt starting with a slash command stays as it is; the note waits for the next one.
/// Returns the note it took, so a send that fails can put it back (`put_back_notice`).
pub fn with_notice(state_dir: &Path, mut input: Value) -> (Value, Option<String>) {
    if !input.is_object() || text(&input).trim_start().starts_with('/') {
        return (input, None);
    }
    let _turn = NOTICE.lock().unwrap();
    let path = state_dir.join("notice");
    let Ok(note) = fs::read_to_string(&path) else {
        return (input, None);
    };
    if fs::remove_file(&path).is_err() || note.trim().is_empty() {
        return (input, None);
    }
    let note = note.trim().to_owned();
    if let Some(parts) = input.get_mut("content").and_then(Value::as_array_mut)
        && !parts.is_empty()
    {
        parts.push(serde_json::json!({"type":"text","text":format!("\n{note}")}));
    }
    input["text"] = Value::String(format!("{}\n\n{note}", text(&input)));
    (input, Some(note))
}

fn session_note(state_dir: &Path, session: &str) -> std::path::PathBuf {
    state_dir.join("notes").join(session)
}

/// A note for one session's next prompt: a switched session's history (#237). Kept until a prompt delivers it.
pub fn add_session_note(state_dir: &Path, session: &str, note: &str) {
    let path = session_note(state_dir, session);
    let _ = fs::create_dir_all(path.parent().unwrap()).and_then(|_| fs::write(&path, note));
}

fn history_copy(state_dir: &Path, session: &str) -> std::path::PathBuf {
    state_dir.join("histories").join(session)
}

/// Core's own copy of the history a switched session got (#237). The session's next switch reads this one, never the
/// file in the agent's folder: the agent can replace that with a link to a file only Core may read.
pub fn save_history(state_dir: &Path, session: &str, history: &str) {
    let path = history_copy(state_dir, session);
    let _ = fs::create_dir_all(path.parent().unwrap()).and_then(|_| fs::write(&path, history));
}

pub fn saved_history(state_dir: &Path, session: &str) -> Option<String> {
    fs::read_to_string(history_copy(state_dir, session)).ok()
}

/// Adds the session's note to its prompt, once: before the user's text, as the agent should read it first.
pub fn with_session_note(
    state_dir: &Path,
    session: &str,
    mut input: Value,
) -> (Value, Option<String>) {
    let path = session_note(state_dir, session);
    let Ok(note) = fs::read_to_string(&path) else {
        return (input, None);
    };
    if !input.is_object() || fs::remove_file(&path).is_err() {
        return (input, None);
    }
    if let Some(parts) = input.get_mut("content").and_then(Value::as_array_mut) {
        parts.insert(
            0,
            serde_json::json!({"type":"text","text":format!("{note}\n\n")}),
        );
    }
    input["text"] = Value::String(format!("{note}\n\n{}", text(&input)));
    (input, Some(note))
}

/// A note whose prompt never reached the agent waits for the next one, after any note written since.
pub fn put_back_notice(state_dir: &Path, note: &str) {
    add_notice(state_dir, note);
}

/// Core's own notes (idle burn) join any note still waiting, once each, so the next prompt carries them all.
pub fn add_notice(state_dir: &Path, note: &str) {
    let _turn = NOTICE.lock().unwrap();
    let path = state_dir.join("notice");
    let waiting = fs::read_to_string(&path).unwrap_or_default();
    // Bounded: a note that repeats while no prompt comes is added once.
    if waiting.contains(note.trim()) || waiting.len() > 16 * 1024 {
        return;
    }
    let temporary = state_dir.join(".notice");
    let text = format!("{}\n{note}", waiting.trim_end());
    if fs::write(&temporary, text.trim_start()).is_ok() {
        let _ = fs::rename(temporary, path);
    }
}

pub fn latest<'a>(
    prompts: &'a BTreeMap<String, PromptState>,
    receipts: &'a BTreeMap<String, Receipt>,
    request: &str,
) -> Option<&'a Value> {
    prompts
        .get(request)
        .filter(|prompt| !prompt.cancelled)
        .map(|prompt| &prompt.input)
        .or_else(|| receipts.get(request).map(|receipt| &receipt.input))
}
