//! Tokens a session spent, from its `usage` readings (docs/observability.md `tokens`). A session's totals only grow,
//! so its use is the change since the last saved total. A drop means the agent restarted its count; Codex and Pi bring
//! back their old totals on resume, so a new process can't simply count from zero. The desktop app's Settings →
//! Analytics uses the same rule.

use crate::runtime::Kind;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// `input` is new input: never the cache reads (`cached`) or writes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Tokens {
    pub input: u64,
    pub cached: u64,
    pub cache_write: u64,
    pub output: u64,
}

impl Tokens {
    /// A `usage` reading's running totals, if it has them.
    pub fn of(usage: &Value, harness: Kind) -> Option<Self> {
        let totals = usage.get("tokens").filter(|totals| totals.is_object())?;
        let count = |key: &str| totals[key].as_u64().unwrap_or(0);
        let cached = count("cacheRead");
        // Codex counts cache reads inside its input.
        let input = match harness {
            Kind::Codex => count("input").saturating_sub(cached),
            _ => count("input"),
        };
        Some(Self {
            input,
            cached,
            cache_write: count("cacheWrite"),
            output: count("output"),
        })
    }

    /// What a loop run's turn used, as the website saves it on the run's row (ADR 20261111-222523).
    pub fn report(self, run: &Run, session: &str, harness: Kind, model: Option<&str>) -> Value {
        json!({"action":"tokens","request":run.request,"session":session,"tokens":{
            "harness":harness,"model":crate::observability::public_model(model),"completed":run.completed,
            "input":self.input,"output":self.output,"cacheRead":self.cached,"cacheWrite":self.cache_write}})
    }

    /// Spent between the `last` saved totals and these.
    pub fn since(self, last: Self) -> Self {
        let base = if self.output >= last.output {
            last
        } else {
            Self::default()
        };
        Self {
            input: self.input.saturating_sub(base.input),
            cached: self.cached.saturating_sub(base.cached),
            cache_write: self.cache_write.saturating_sub(base.cache_write),
            output: self.output - base.output,
        }
    }
}

/// A loop run's turn that just ended: its prompt, the session's totals when the turn began, and whether it completed.
pub(crate) struct Run {
    pub request: String,
    pub base: Tokens,
    pub completed: bool,
}

impl Run {
    /// What the turn used, given the totals now. None when unsure: the count restarted (a new harness process).
    pub fn spent(&self, now: Tokens) -> Option<Tokens> {
        let spent = now.since(self.base);
        (now.output >= self.base.output && spent != Tokens::default()).then_some(spent)
    }
}

/// Whether `request` is a loop run's prompt. The website names a run `auto_<loop>_<due>`, and a fresh thread's prompt
/// adds `_p`.
pub(crate) fn loop_run(request: &str) -> bool {
    let run = request.strip_suffix("_p").unwrap_or(request);
    run.strip_prefix("auto_")
        .and_then(|rest| rest.split_once('_'))
        .is_some_and(|(id, due)| {
            id.len() == 32
                && id.bytes().all(|b| b.is_ascii_hexdigit())
                && !due.is_empty()
                && due.bytes().all(|b| b.is_ascii_digit())
        })
}
