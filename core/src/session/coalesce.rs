use crate::runtime;
use serde::Serialize;
use serde_json::{Map, Value};
use std::time::Duration;
use tokio::time::Instant;

/// Hold consecutive streaming deltas briefly before journal fsync, invisible below the GUI's 250 ms batching.
const COALESCE_WINDOW: Duration = Duration::from_millis(80);

/// Cap merged delta bytes at 4,000: covers normal LLM bursts while staying under mobile's 4,000-char clip (`web/lib/mobile.ts`).
const MAX_MERGED_DELTA: usize = 4_000;

/// Up to two events released by one `push`: a flushed buffer followed by the incoming event.
pub(super) struct Ready {
    items: [Option<runtime::Event>; 2],
    next: usize,
}

impl Ready {
    fn none() -> Self {
        Self {
            items: [None, None],
            next: 0,
        }
    }
    fn one(a: runtime::Event) -> Self {
        Self {
            items: [Some(a), None],
            next: 0,
        }
    }
    fn two(a: runtime::Event, b: runtime::Event) -> Self {
        Self {
            items: [Some(a), Some(b)],
            next: 0,
        }
    }
}

impl Iterator for Ready {
    type Item = runtime::Event;

    fn next(&mut self) -> Option<Self::Item> {
        while self.next < self.items.len() {
            let i = self.next;
            self.next += 1;
            if let Some(event) = self.items[i].take() {
                return Some(event);
            }
        }
        None
    }
}

#[derive(PartialEq, Eq)]
enum Key {
    /// Claude and ACP (`cursor`, `opencode`, `hermes`, etc.): apps read `data.delta`, not `record.native`.
    Normalized {
        kind: &'static str,
        harness: String,
        item_id: String,
        request_id: Option<String>,
        item_type: Option<String>,
    },
    /// Codex: apps read `record.native` (`{"method":...,"params":{...,"delta":...}}`), and `for_client` fills `data.value` from it.
    Codex {
        kind: &'static str,
        method: String,
        item_id: String,
        request_id: Option<String>,
    },
}

struct CodexParsed {
    method: String,
    params: Map<String, Value>,
    emitted_at_ms: Option<Value>,
}

/// Keep `"method"` first in JSON so `web/lib/mobile.ts` (`record.native.startsWith('{"method":')`) still recognizes Codex frames.
#[derive(Serialize)]
struct CodexFrame<'a> {
    method: &'a str,
    params: &'a Map<String, Value>,
    #[serde(rename = "emittedAtMs", skip_serializing_if = "Option::is_none")]
    emitted_at_ms: Option<&'a Value>,
}

struct Pending {
    key: Key,
    deadline: Instant,
    kind: &'static str,
    data: Value,
    native: Option<String>,
    /// Populated only once a second delta merges; single unmerged deltas flush untouched.
    merged: Option<String>,
    /// Lazily parsed first Codex native frame, reused across further merges in the same burst.
    codex: Option<CodexParsed>,
}

impl Pending {
    fn delta_len(&self) -> usize {
        self.merged
            .as_deref()
            .or_else(|| self.data.get("delta").and_then(Value::as_str))
            .map_or(0, str::len)
    }

    fn into_event(mut self) -> runtime::Event {
        if let Some(delta) = self.merged {
            self.data["delta"] = Value::String(delta.clone());
            self.native = match self.codex {
                Some(mut frame) => {
                    frame.params.insert("delta".into(), Value::String(delta));
                    let wire = CodexFrame {
                        method: &frame.method,
                        params: &frame.params,
                        emitted_at_ms: frame.emitted_at_ms.as_ref(),
                    };
                    Some(serde_json::to_string(&wire).expect("Codex frame serialization failed"))
                }
                None => None,
            };
        }
        runtime::Event::Record {
            kind: self.kind,
            data: self.data,
            native: self.native,
        }
    }
}

/// Coalesces consecutive streaming deltas for the same item before they hit the journal.
pub(super) struct DeltaCoalescer {
    pending: Option<Pending>,
}

impl DeltaCoalescer {
    pub(super) fn new() -> Self {
        Self { pending: None }
    }

    pub(super) fn deadline(&self) -> Option<Instant> {
        self.pending.as_ref().map(|p| p.deadline)
    }

    pub(super) fn flush(&mut self) -> Option<runtime::Event> {
        self.pending.take().map(Pending::into_event)
    }

    pub(super) fn clear(&mut self) {
        self.pending = None;
    }

    pub(super) fn push(&mut self, event: runtime::Event) -> Ready {
        let runtime::Event::Record { kind, data, native } = event else {
            return match self.flush() {
                Some(flushed) => Ready::two(flushed, event),
                None => Ready::one(event),
            };
        };

        let Some((key, delta_len)) = classify(kind, &data, native.as_deref()) else {
            let incoming = runtime::Event::Record { kind, data, native };
            return match self.flush() {
                Some(flushed) => Ready::two(flushed, incoming),
                None => Ready::one(incoming),
            };
        };

        if let Some(pending) = &mut self.pending {
            if pending.key == key
                && pending.delta_len() + delta_len <= MAX_MERGED_DELTA
                && try_merge(pending, &data, native.as_deref())
            {
                if pending.delta_len() >= MAX_MERGED_DELTA {
                    return Ready::one(self.pending.take().unwrap().into_event());
                }
                return Ready::none();
            }
            let flushed = self.pending.take().unwrap().into_event();
            self.pending = Some(Pending {
                key,
                deadline: Instant::now() + COALESCE_WINDOW,
                kind,
                data,
                native,
                merged: None,
                codex: None,
            });
            return Ready::one(flushed);
        }

        self.pending = Some(Pending {
            key,
            deadline: Instant::now() + COALESCE_WINDOW,
            kind,
            data,
            native,
            merged: None,
            codex: None,
        });
        Ready::none()
    }
}

fn is_codex_delta_method(method: &str) -> bool {
    matches!(
        method,
        "item/agentMessage/delta"
            | "item/commandExecution/outputDelta"
            | "item/fileChange/outputDelta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta"
            | "item/plan/delta"
    )
}

fn classify(kind: &'static str, data: &Value, native: Option<&str>) -> Option<(Key, usize)> {
    // Records carrying usage emit a separate `usage` record right after, so never coalesce them.
    if data.get("usage").is_some_and(|v| !v.is_null()) {
        return None;
    }
    let delta = data.get("delta").and_then(Value::as_str)?;
    if delta.len() >= MAX_MERGED_DELTA {
        return None;
    }
    let item_id = data.get("item_id").and_then(Value::as_str)?;
    let request_id = data
        .get("request_id")
        .and_then(Value::as_str)
        .map(str::to_owned);

    if let Some(harness) = data.get("harness").and_then(Value::as_str) {
        // Pi streams from `record.native` (`message_update`); skip it in v1.
        if harness == "pi" || !matches!(kind, "text_delta" | "thinking_delta" | "tool_delta") {
            return None;
        }
        let item_type = data
            .get("item_type")
            .and_then(Value::as_str)
            .map(str::to_owned);
        return Some((
            Key::Normalized {
                kind,
                harness: harness.to_owned(),
                item_id: item_id.to_owned(),
                request_id,
                item_type,
            },
            delta.len(),
        ));
    }

    let method = data.get("method").and_then(Value::as_str)?;
    if native.is_none()
        || !is_codex_delta_method(method)
        || !matches!(kind, "text_delta" | "tool_delta" | "native_event")
    {
        return None;
    }
    Some((
        Key::Codex {
            kind,
            method: method.to_owned(),
            item_id: item_id.to_owned(),
            request_id,
        },
        delta.len(),
    ))
}

fn parse_codex_frame(
    raw: &str,
    expected_method: &str,
    expected_delta: &str,
) -> Option<CodexParsed> {
    let Value::Object(mut obj) = serde_json::from_str::<Value>(raw).ok()? else {
        return None;
    };
    if !obj
        .keys()
        .all(|k| matches!(k.as_str(), "method" | "params" | "emittedAtMs"))
    {
        return None;
    }
    let method = obj.remove("method").and_then(|v| match v {
        Value::String(s) if s == expected_method => Some(s),
        _ => None,
    })?;
    let Value::Object(params) = obj.remove("params")? else {
        return None;
    };
    if params.get("delta").and_then(Value::as_str) != Some(expected_delta) {
        return None;
    }
    let emitted_at_ms = obj.remove("emittedAtMs");
    Some(CodexParsed {
        method,
        params,
        emitted_at_ms,
    })
}

fn codex_params_match(a: &Map<String, Value>, b: &Map<String, Value>) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .all(|(k, v)| k == "delta" || b.get(k).is_some_and(|other| other == v))
}

fn try_merge(pending: &mut Pending, next_data: &Value, next_native: Option<&str>) -> bool {
    let Some(next_delta) = next_data.get("delta").and_then(Value::as_str) else {
        return false;
    };
    if let Key::Codex { method, .. } = &pending.key {
        if pending.codex.is_none() {
            let Some(first_raw) = pending.native.as_deref() else {
                return false;
            };
            let Some(first_delta) = pending.data.get("delta").and_then(Value::as_str) else {
                return false;
            };
            let Some(parsed) = parse_codex_frame(first_raw, method, first_delta) else {
                return false;
            };
            pending.codex = Some(parsed);
        }
        let Some(second_raw) = next_native else {
            return false;
        };
        let Some(second) = parse_codex_frame(second_raw, method, next_delta) else {
            return false;
        };
        if !codex_params_match(&pending.codex.as_ref().unwrap().params, &second.params) {
            return false;
        }
    }

    let merged = pending.merged.get_or_insert_with(|| {
        pending
            .data
            .get("delta")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    });
    merged.push_str(next_delta);
    true
}
