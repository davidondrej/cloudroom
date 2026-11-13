//! Tokens a session spent, from its `usage` readings (docs/observability.md `tokens`). A session's totals only grow,
//! so its use is the change since the last saved total. A drop means the agent restarted its count; Codex and Pi bring
//! back their old totals on resume, so a new process can't simply count from zero. The desktop app's Settings →
//! Analytics uses the same rule.

use crate::runtime::Kind;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
