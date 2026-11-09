use super::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, fs, path::Path};

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

/// A note whose prompt never reached the agent waits for the next one. It never replaces a note written since.
pub fn put_back_notice(state_dir: &Path, note: &str) {
    use std::io::Write;
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(state_dir.join("notice"));
    if let Ok(mut file) = file {
        let _ = file.write_all(note.as_bytes());
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
