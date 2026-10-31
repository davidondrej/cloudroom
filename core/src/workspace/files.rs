//! `room-cli files wait`: a new Cloud thread's agent waits for its project copy itself (ADR 0209).
//! The Mac app writes `<project folder>.cloudroom-files` next to the folder, so Git never sees it:
//! `copying`, then `ready` or `failed: REASON`. Core starts the agent itself only once the copy lands (`landed`).
use std::{
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const USAGE: &str = "room-cli files wait
Waits until Cloudroom finishes copying this project into the sandbox, up to 10 minutes. Returns at once if no copy is running.";
const FAILURE_NOTE: &str = ".cloudroom/project-copy-failed.txt";
const POLL: Duration = Duration::from_secs(2);
/// A harness starts this soon after its copy lands.
const LAUNCH_POLL: Duration = Duration::from_millis(250);
/// The app writes the status file right after the session starts, so an agent can ask a moment before it exists.
const GRACE: Duration = Duration::from_secs(10);
const LIMIT: Duration = Duration::from_secs(600);

pub async fn cli(args: &[String]) -> io::Result<i32> {
    match args {
        [command] if command == "wait" => wait(&std::env::current_dir()?).await,
        [help] if help == "--help" => {
            println!("{USAGE}");
            Ok(0)
        }
        _ => {
            eprintln!("{USAGE}");
            Ok(2)
        }
    }
}

enum Copy {
    Ready(PathBuf),
    Failed(PathBuf, String),
    NotRunning,
}

/// One look at the project copy. `None` while it runs, or, if `expected`, may be about to start.
fn check(cwd: &Path, expected: bool) -> Option<Copy> {
    let found = status_file(cwd);
    let state = found
        .as_ref()
        .and_then(|(_, file)| std::fs::read_to_string(file).ok());
    match (found, state.as_deref().map(str::trim)) {
        (Some((folder, _)), Some("ready")) => Some(Copy::Ready(folder)),
        (Some((folder, _)), Some(state)) if state.starts_with("failed") => {
            let reason = state
                .trim_start_matches("failed")
                .trim_start_matches(':')
                .trim();
            Some(Copy::Failed(folder, reason.into()))
        }
        (Some(_), _) => None,
        (None, _) if !expected || !looks_empty(cwd) => Some(Copy::NotRunning),
        (None, _) => None,
    }
}

/// Waits quietly until a running project copy lands or fails, up to `limit`.
/// Skills selected in a new thread's first message use this before they give up (ADR 0209).
pub async fn settle(cwd: &Path, limit: Duration) {
    let start = Instant::now();
    while check(cwd, start.elapsed() < GRACE).is_none() && start.elapsed() < limit {
        tokio::time::sleep(POLL).await;
    }
}

/// Waits until a running project copy lands or fails, up to `limit` or until `cancelled`. Harnesses read skills and
/// AGENTS.md or CLAUDE.md only as they start, so Core starts them after this. Unlike `settle`, it never waits for a
/// copy with no status file, unless the app `promised` one it has not marked yet.
pub async fn landed(cwd: &Path, promised: bool, limit: Duration, cancelled: impl Fn() -> bool) {
    let start = Instant::now();
    while check(cwd, promised).is_none() && start.elapsed() < limit && !cancelled() {
        tokio::time::sleep(LAUNCH_POLL).await;
    }
}

async fn wait(cwd: &Path) -> io::Result<i32> {
    let start = Instant::now();
    let mut announced = false;
    loop {
        match check(cwd, start.elapsed() < GRACE) {
            Some(Copy::Ready(folder)) => {
                println!("Project files are ready in {}.", folder.display());
                return Ok(0);
            }
            Some(Copy::Failed(folder, reason)) => {
                // The failure note says the same and where the full project is.
                match std::fs::read_to_string(folder.join(FAILURE_NOTE)) {
                    Ok(note) => println!("{}", note.trim()),
                    Err(_) => println!(
                        "Cloudroom could not copy this project, so do not wait for more files. {reason}"
                    ),
                }
                return Ok(1);
            }
            Some(Copy::NotRunning) => {
                println!(
                    "No project copy is running. If files are missing, the project may be on the user's Mac: pull what you need with `room-cli mac pull`."
                );
                return Ok(0);
            }
            None => {}
        }
        if start.elapsed() >= LIMIT {
            println!(
                "The project is still copying after 10 minutes. Work with the files that are here, or pull what you need from the user's Mac with `room-cli mac pull`."
            );
            return Ok(1);
        }
        if !announced {
            println!("Waiting for Cloudroom to finish copying the project...");
            announced = true;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// The status file of the nearest project folder at or above `cwd`.
fn status_file(cwd: &Path) -> Option<(PathBuf, PathBuf)> {
    cwd.ancestors()
        .filter(|folder| folder.parent().is_some())
        .map(|folder| {
            let mut file = folder.as_os_str().to_owned();
            file.push(".cloudroom-files");
            (folder.to_path_buf(), PathBuf::from(file))
        })
        .find(|(_, file)| file.is_file())
}

/// Empty apart from Cloudroom's own `.cloudroom` folder (attachments, notes), or not made yet.
fn looks_empty(folder: &Path) -> bool {
    match std::fs::read_dir(folder) {
        Ok(entries) => entries
            .flatten()
            .all(|entry| entry.file_name() == ".cloudroom"),
        Err(error) => error.kind() == io::ErrorKind::NotFound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_launch_waits_for_a_copy_only_while_it_runs_and_never_past_its_limit() {
        let root = std::env::temp_dir().join(format!(
            "cloudroom-files-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let (folder, status) = (root.join("project"), root.join("project.cloudroom-files"));
        let waited = async |promised, cancelled: bool| {
            let start = Instant::now();
            landed(&folder, promised, Duration::from_millis(600), || cancelled).await;
            start.elapsed()
        };
        // No copy, or one that was never promised: at once.
        assert!(waited(false, false).await < LAUNCH_POLL);
        // A promised copy the app has not marked yet, and a stuck one: until the limit.
        assert!(waited(true, false).await >= Duration::from_millis(600));
        std::fs::write(&status, "copying").unwrap();
        assert!(waited(false, false).await >= Duration::from_millis(600));
        // A stop or close ends the wait.
        assert!(waited(false, true).await < LAUNCH_POLL);
        // A copy that landed or failed: at once.
        for state in ["ready", "failed: the clone failed"] {
            std::fs::write(&status, state).unwrap();
            assert!(waited(true, false).await < LAUNCH_POLL);
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
