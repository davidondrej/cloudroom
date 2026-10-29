use super::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

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
