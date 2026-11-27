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

/// How long a message from another thread waits before its turn says when it was sent.
const LATE_MS: u64 = 10 * 60_000;
/// The largest prompt (all of it, as JSON) that gets the note: far below every prompt and frame limit.
const NOTED_TEXT: usize = 64 * 1024;

/// A message from another thread (`sent`, set as Core took it) that waited behind other work says when it was sent,
/// after its text: newer messages may have replaced it, and it would otherwise look current (#2633). `sent` itself
/// never reaches the harness, so what it gets and measures is otherwise as before. Pi never gets the note: its input
/// extensions may match a prompt's exact text.
pub fn with_sent_time(mut input: Value, now: u64, harness: crate::runtime::Kind) -> Value {
    let sent = input
        .as_object_mut()
        .and_then(|fields| fields.remove("sent"));
    let Some(sent) = sent.as_ref().and_then(Value::as_u64) else {
        return input;
    };
    let waited = now.saturating_sub(sent);
    if harness == crate::runtime::Kind::Pi {
        return input;
    }
    // One with images, files, selected skills (Claude expands them later) or long text goes as before: the note could
    // push it over a harness's size limit.
    let parts = || input["content"].as_array().into_iter().flatten();
    let as_before = input.to_string().len() > NOTED_TEXT
        || input["attachments"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        || parts().any(|part| {
            part["mentions"].as_array().is_some_and(|m| !m.is_empty())
                || matches!(
                    part["type"].as_str(),
                    Some("image" | "localImage" | "file" | "localFile")
                )
        });
    if waited < LATE_MS || as_before || text(&input).trim_start().starts_with('/') {
        return input;
    }
    let waited = waited / 60_000;
    let clock = sent / 60_000 % 1440;
    let ago = match waited / 60 {
        0 => format!("{waited} min"),
        hours => format!("{hours} h {} min", waited % 60),
    };
    let note = format!(
        "[Cloudroom] This message was sent at {:02}:{:02} UTC, {ago} ago, and waited until now. Newer messages may replace it.",
        clock / 60,
        clock % 60
    );
    // Only beside a text part: Codex reads `text` when no content part is one it takes (runtime/codex.rs).
    if let Some(parts) = input.get_mut("content").and_then(Value::as_array_mut)
        && parts.iter().any(|part| part["type"] == "text")
    {
        parts.push(serde_json::json!({"type":"text","text":format!("\n{note}")}));
    }
    input["text"] = Value::String(format!("{}\n\n{note}", text(&input)));
    input
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

#[cfg(test)]
mod tests {
    use serde_json::json;
    const CODEX: crate::runtime::Kind = crate::runtime::Kind::Codex;

    /// A tell that waited 3 h 4 min says when it was sent; one that ran soon after loses only `sent`, and one with no time stays as is.
    #[test]
    fn a_long_queued_tell_says_when_it_was_sent() {
        let sent = 20 * 86_400_000 + (9 * 60 + 12) * 60_000;
        let input = json!({"text":"old task","sent":sent});
        let late = super::with_sent_time(input.clone(), sent + 184 * 60_000, CODEX);
        assert_eq!(
            late["text"],
            "old task\n\n[Cloudroom] This message was sent at 09:12 UTC, 3 h 4 min ago, and waited until now. Newer messages may replace it."
        );
        assert_eq!(late.get("sent"), None);
        // Pi gets exactly what it would without `sent`: its input extensions may match the exact text.
        let pi =
            super::with_sent_time(input.clone(), sent + 184 * 60_000, crate::runtime::Kind::Pi);
        assert_eq!(pi, json!({"text":"old task"}));
        // Sent soon, the harness gets exactly what it would without `sent`, so size checks measure the same.
        let soon = super::with_sent_time(input.clone(), sent + 60_000, CODEX);
        assert_eq!(soon, json!({"text":"old task"}));
        // Content Codex ignores stays as is, so Codex still reads the text, note included.
        let other = json!({"text":"old task","sent":sent,"content":[{"type":"mention"}]});
        let late = super::with_sent_time(other, sent + 184 * 60_000, CODEX);
        assert_eq!(late["content"], json!([{"type":"mention"}]));
        assert!(late["text"].as_str().unwrap().contains("[Cloudroom]"));
        // With images or files, it goes as before, without the note.
        let image = json!({"text":"old task","sent":sent,"attachments":[{"path":"a.png"}]});
        let late = super::with_sent_time(image, sent + 184 * 60_000, CODEX);
        assert_eq!(
            late,
            json!({"text":"old task","attachments":[{"path":"a.png"}]})
        );
        // So does one with a selected skill or long text.
        let skill = json!({"text":"use a","sent":sent,"content":[{"type":"text","text":"use a","mentions":[{}]}]});
        let late = super::with_sent_time(skill, sent + 184 * 60_000, CODEX);
        assert_eq!(late.get("sent"), None);
        assert_eq!(late["text"], "use a");
        let long = "x".repeat(super::NOTED_TEXT + 1);
        let late =
            super::with_sent_time(json!({"text":long,"sent":sent}), sent + 184 * 60_000, CODEX);
        assert_eq!(late, json!({"text":long}));
        let parts = json!({"text":"x","sent":sent,"content":[{"type":"text","text":long}]});
        let late = super::with_sent_time(parts, sent + 184 * 60_000, CODEX);
        assert_eq!(
            late,
            json!({"text":"x","content":[{"type":"text","text":long}]})
        );
        assert_eq!(
            super::with_sent_time(json!({"text":"x"}), sent, CODEX),
            json!({"text":"x"})
        );
    }
}
