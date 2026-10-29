use serde::Serialize;

/// Agent counts sampled with each resource reading. The website charts them from saved diagnostics
/// (`cloudroom_metrics`, docs/database/0066); Core no longer reads them back.
#[derive(Clone, Copy, Default, Serialize)]
pub(crate) struct AgentCounts {
    pub working: usize,
    pub queued: usize,
    pub waiting: usize,
    pub sleeping: usize,
    pub failed: usize,
    /// Agents with background jobs still running, beyond the harness itself (ADR 0031).
    pub background: usize,
    /// The newest session activity (ms), so work that starts and ends between samples still counts.
    #[serde(skip)]
    pub last_activity: Option<u64>,
}
