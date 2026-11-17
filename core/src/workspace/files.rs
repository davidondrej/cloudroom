//! `room-cli files wait`: a new Cloud thread's agent waits for its project copy itself (ADR 0209).
//! The Mac app writes `<project folder>.cloudroom-files` next to the folder, so Git never sees it:
//! `copying`, then `ready` or `failed: REASON`. Whenever `wait` lets the agent go ahead (`ready` too, and when SIGTERM or
//! SIGHUP stops it), it leaves `<project folder>.cloudroom-files-gave-up`, so a move's uncommitted edits that land later
//! go aside instead of over the agent's work (#1970).
use std::{
    io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const USAGE: &str = "room-cli files wait
Waits until Cloudroom finishes copying this project into the sandbox, up to 10 minutes. Returns at once if no copy is running, and fails if the folder is empty.";
const FAILURE_NOTE: &str = ".cloudroom/project-copy-failed.txt";
const POLL: Duration = Duration::from_secs(2);
/// The app writes the status file right after the session starts, so an agent can ask a moment before it exists.
const GRACE: Duration = Duration::from_secs(10);
const LIMIT: Duration = Duration::from_secs(600);
/// Core puts every project's folder right under it.
const ROOT: &str = "/code";
const GAVE_UP: &str = ".cloudroom-files-gave-up";

pub async fn cli(args: &[String]) -> io::Result<i32> {
    match args {
        [command] if command == "wait" => {
            let cwd = std::env::current_dir()?;
            tokio::select! {
                code = wait(&cwd) => code,
                // A harness's timeout that stops the wait lets the agent go ahead too.
                () = stopped() => {
                    go_ahead(&cwd);
                    Ok(143)
                }
            }
        }
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
    Missing,
    NoProject,
}

/// One look at the project copy. `None` while it runs, or may be about to start.
fn check(cwd: &Path, waited: Duration) -> Option<Copy> {
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
        // Threads without a project start in the bare workspace root, where nothing is ever copied.
        (None, _) if cwd == Path::new(ROOT) => Some(Copy::NoProject),
        (None, _) if !looks_empty(cwd) => Some(Copy::NotRunning),
        // No status and no files: the copy never started, or its status never arrived (#337).
        (None, _) if waited >= GRACE => Some(Copy::Missing),
        (None, _) => None,
    }
}

/// Waits quietly until a running project copy lands or fails, up to `limit`.
/// Skills selected in a new thread's first message use this before they give up (ADR 0209).
pub async fn settle(cwd: &Path, limit: Duration) {
    let start = Instant::now();
    while check(cwd, start.elapsed()).is_none() && start.elapsed() < limit {
        tokio::time::sleep(POLL).await;
    }
}

async fn wait(cwd: &Path) -> io::Result<i32> {
    let start = Instant::now();
    let mut announced = false;
    loop {
        let copy = check(cwd, start.elapsed());
        // The agent goes ahead once this returns, so mark it first.
        if copy.is_some() || start.elapsed() >= LIMIT {
            go_ahead(cwd);
        }
        match copy {
            // A copy that says ready but left nothing here may have failed quietly (#604). A new project can be empty
            // on purpose, so warn instead of failing.
            Some(Copy::Ready(folder)) if looks_empty(&folder) => {
                println!(
                    "Cloudroom finished copying, but {} is empty. If the project should have files, do not wait for them: if it is on GitHub, clone it into this folder; otherwise pull what you need from the user's Mac with `room-cli mac pull`.",
                    folder.display()
                );
                return Ok(0);
            }
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
            Some(Copy::NoProject) => {
                println!(
                    "This thread has no project, so Cloudroom copies nothing into it. Files sent with `room-cli vm push` stay where the sender put them, by default the agent home (~). Pull anything else from the user's Mac with `room-cli mac pull`."
                );
                return Ok(0);
            }
            Some(Copy::Missing) => {
                println!(
                    "No project copy is running, and this folder is empty, so the project files are missing. Do not wait for them: if the project is on GitHub, clone it into this folder; otherwise pull what you need from the user's Mac with `room-cli mac pull`."
                );
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
            // Some harnesses hand a long command back to the agent while it runs (#588).
            println!(
                "Waiting for Cloudroom to finish copying the project... Keep waiting until this command returns: files you write in this folder before then can be replaced."
            );
            announced = true;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Resolves once SIGTERM or SIGHUP stops `wait`.
async fn stopped() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut term), Ok(mut hup)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::hangup()),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = term.recv() => {},
        _ = hup.recv() => {},
    }
}

/// Tells the app the agent may now edit the project folder: its status file's, or, before the app wrote one, the
/// project folder `cwd` is in. The app holds the folder's lock while it checks for this and unpacks a move's edits over
/// the folder, so the two never overlap. Nothing removes it, since a second app resuming the same move can write
/// `copying` again after `ready` (#1970).
fn go_ahead(cwd: &Path) {
    let Some(folder) = status_file(cwd)
        .map(|(folder, _)| folder)
        .or_else(|| project_folder(cwd))
    else {
        return;
    };
    let lock = std::fs::File::open(&folder);
    let _held = lock.as_ref().map(std::fs::File::lock);
    let _ = std::fs::write(marker(&folder), "");
}

fn marker(folder: &Path) -> PathBuf {
    let mut marker = folder.as_os_str().to_owned();
    marker.push(GAVE_UP);
    marker.into()
}

/// The folder right under the workspace root that `cwd` is in, which is where the app copies the project.
fn project_folder(cwd: &Path) -> Option<PathBuf> {
    let root = std::fs::canonicalize(ROOT).ok()?;
    cwd.ancestors()
        .find(|folder| folder.parent() == Some(root.as_path()))
        .map(Path::to_path_buf)
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

/// Empty apart from Cloudroom's own `.cloudroom` folder (attachments, notes).
fn looks_empty(folder: &Path) -> bool {
    std::fs::read_dir(folder).is_ok_and(|entries| {
        entries
            .flatten()
            .all(|entry| entry.file_name() == ".cloudroom")
    })
}
