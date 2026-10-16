//! Cross-platform shims for the Unix permission model.
//!
//! On Unix these re-export the std extension traits unchanged, so call sites
//! keep their exact behavior. Windows has no mode bits: the shims there degrade
//! to no-ops or neutral values until Windows ACL support lands. The workload
//! containment backend is `runtime::containment`, not here.

#[cfg(unix)]
pub use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};

#[cfg(not(unix))]
/// Windows: no-op. Access is decided by ACLs, not mode bits.
pub trait OpenOptionsExt {
    fn mode(&mut self, _mode: u32) -> &mut Self {
        self
    }
}

#[cfg(not(unix))]
impl OpenOptionsExt for std::fs::OpenOptions {}

#[cfg(not(unix))]
/// Windows: no-op. Access is decided by ACLs, not mode bits.
pub trait DirBuilderExt {
    fn mode(&mut self, _mode: u32) -> &mut Self {
        self
    }
}

#[cfg(not(unix))]
impl DirBuilderExt for std::fs::DirBuilder {}

#[cfg(not(unix))]
/// Windows: neutral values. `uid()` reports 0 so "not owned by the agent" checks
/// pass, and `mode()` reports 0o700 so group/other-write checks pass. Every check
/// built on these is advisory until ACL validation replaces it.
pub trait MetadataExt {
    fn uid(&self) -> u32 {
        0
    }
    fn mode(&self) -> u32 {
        0o700
    }
    fn nlink(&self) -> u64 {
        1
    }
    fn dev(&self) -> u64 {
        0
    }
    fn ino(&self) -> u64 {
        0
    }
}

#[cfg(not(unix))]
impl MetadataExt for std::fs::Metadata {}
