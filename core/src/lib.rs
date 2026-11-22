// Only `git` (the app's Git panel) and `fs` (its files) build on Windows; everything else needs Unix.
#[cfg(unix)]
pub mod api;
#[cfg(unix)]
pub mod computer_use;
#[cfg(unix)]
pub mod config;
pub mod fs;
pub mod git;
#[cfg(unix)]
pub mod gpu;
#[cfg(unix)]
pub mod helper;
#[cfg(unix)]
pub mod mac;
#[cfg(unix)]
mod observability;
#[cfg(unix)]
pub mod preview;
#[cfg(unix)]
pub mod runtime;
#[cfg(unix)]
pub mod secrets;
#[cfg(unix)]
pub mod session;
#[cfg(unix)]
pub mod sync;
#[cfg(unix)]
pub mod workspace;

/// Bumped by `tools/release-core.py` on every release (ADR 0120).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// The git commit this binary was built from, set by `build.rs`.
pub const COMMIT: &str = env!("CLOUDROOM_COMMIT");
/// Features `/v1/capabilities` always reports. Release pins record this list, so CI can
/// check that new VMs support everything the app uses.
pub const FEATURES: &[&str] = &[
    // Every computer follows a Cloud thread (#237): thread reports, `continue_from`, freeze, Stop `after`, the
    // session list's title, archive and `last_app_prompt`, and archive or unarchive of a session.
    "cloud_threads",
    "stop",
    "resume",
    "launch_settings",
    "prompt_reasoning",
    "workspaces",
    "sync",
    "mcp_sync",
    "direct_workspaces",
    "root_workspace",
    "teleport",
    "teleport_lineage",
    "command_guard",
    "strip_ai_co_authors",
    "system_prompt",
    "computer_use",
    "gpu",
    "codex_auth",
    "codex_auth_import",
    "cursor_auth",
    "claude_auth",
    "pi_auth_import",
    "pi_setup",
    "structured_prompt",
    "queue_edit",
    "queue_cancel",
    "queue_reorder",
    "resume_keep_paused",
    "steer",
    "rewind",
    "fork",
    "side_chat",
    "side_chat_fresh",
    "attachments",
    "upload_parts",
    "compact",
    // `thread compact` waits for a running turn to end, then queues its follow-up.
    "compact_after_turn",
    "goal",
    "usage",
    "subagents",
    "child_threads",
    "relay",
    "session_list",
    "drain",
    "terminals",
    "files_wait",
    "long_prompts",
    "agent_limits",
    "plan_only",
    "loop_report",
    "mac_device",
    "credits_usage",
    "room_ids",
    // `cloudroom fs` (the app's file commands) and `cloudroom terminal` (a program on a new terminal over stdio):
    // the host daemon checks these before using them, so a stale build falls back to the old TypeScript.
    "fs",
    "local_terminal",
];

/// The harness binary Core starts, resolved once here. A wake can switch OpenCode 1 to 2, another package behind the
/// same link, so OpenCode keeps its link (absolute, since agents start in the workspace) and each start follows it;
/// else OpenCode 1 opens the database OpenCode 2 made and exits (#2267).
#[cfg(unix)]
fn launch_path(
    kind: runtime::Kind,
    binary: &std::path::Path,
) -> std::io::Result<std::path::PathBuf> {
    let resolved = binary.canonicalize()?;
    if kind == runtime::Kind::OpenCode {
        return std::path::absolute(binary);
    }
    Ok(resolved)
}

#[cfg(unix)]
pub async fn serve(mut config: config::Config) -> Result<(), Box<dyn std::error::Error>> {
    use std::{future::IntoFuture, time::Duration};
    use tokio::signal::unix::{SignalKind, signal};
    config.account_home = config.account_home.canonicalize()?;
    config.repository = config.repository.canonicalize()?;
    for (kind, profile) in config.harnesses.iter_mut() {
        profile.home = profile.home.canonicalize()?;
        profile.binary = launch_path(*kind, &profile.binary)?;
    }
    // A bind failure must not mutate saved sessions or claim their recovery.
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    // A stop during recovery must be delivered to graceful shutdown, even before the server is polled.
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let manager = session::Manager::open(config.clone())?;
    manager.check_storage().await;
    runtime::warm_codex(&config).await;
    // Reconcile previous workloads before the API or storage guard can start work.
    manager.restore_all().await?;
    manager.previews.listen().await?;
    if let Err(error) = mac::listen(&manager).await {
        eprintln!("Mac access unavailable: {error}");
    }
    manager.start_storage_guard();
    manager.start_idle_sleeper();
    manager.start_memory_guard();
    manager.start_limit_resumer();
    manager.start_uploader();
    manager.start_auth_monitor();
    manager.start_repo_sync();
    eprintln!("Cloudroom listening on {}", listener.local_addr()?);
    let shutdown = manager.clone();
    let mut changed = manager.subscribe();
    let server = axum::serve(listener, api::router(manager.clone(), config.token))
        .with_graceful_shutdown(async move {
            tokio::select! { _=interrupt.recv()=>{}, _=terminate.recv()=>{} }
            shutdown.shutdown().await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => result?,
        _ = async {
            let _ = changed.wait_for(|_| manager.is_stopping()).await;
            // A peer may stop reading bytes already buffered by HTTP, outside the SSE queue.
            tokio::time::sleep(runtime::SHUTDOWN_GRACE + Duration::from_secs(2)).await;
        } => eprintln!("Cloudroom stopped waiting for unresponsive HTTP clients"),
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::{launch_path, runtime::Kind};
    use std::path::Path;

    #[test]
    fn opencode_keeps_its_link_as_an_absolute_path() {
        // Relative, as a relative account home gives it: agents start in the workspace, not Core's folder.
        let dir = Path::new("target").join(format!("launch-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("opencode-1"), "").unwrap();
        std::os::unix::fs::symlink("opencode-1", dir.join("opencode")).unwrap();
        let link = dir.join("opencode");
        let path = launch_path(Kind::OpenCode, &link).unwrap();
        assert_eq!(path, std::env::current_dir().unwrap().join(&link));
        let pinned = launch_path(Kind::Codex, &link).unwrap();
        assert_eq!(pinned, dir.join("opencode-1").canonicalize().unwrap());
        assert!(launch_path(Kind::OpenCode, &dir.join("missing")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
