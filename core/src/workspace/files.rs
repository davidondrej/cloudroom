//! `room-cli files wait`: a new Cloud thread's agent waits for its project copy itself (ADR 0209).
//! The Mac app writes `<project folder>.cloudroom-files` next to the folder, so Git never sees it:
//! `copying`, then `ready` or `failed: REASON`. Whenever `wait` lets the agent go ahead (`ready` too, and when SIGTERM or
//! SIGHUP stops it), it leaves `<project folder>.cloudroom-files-gave-up`, so a move's uncommitted edits that land later
//! go aside instead of over the agent's work (#1970). The app touches `<project folder>.cloudroom-files-alive` as it writes
//! `copying`, then each minute through `POST /v1/workspaces/{id}/alive` while it copies; once that stays silent for 4
//! minutes, its computer is offline or asleep, or the app closed, so `wait` stops (#2168).
use crate::helper::jobs::quote;
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
const ALIVE: &str = ".cloudroom-files-alive";
/// Beats come each minute, so three in a row may go missing. Older apps send none, and are waited for as before.
const SILENT: Duration = Duration::from_secs(240);
/// The account's repos every Cloud sandbox clones, apart from the project (ADR 0171).
const REPOS: &str = "/repos";

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
    Offline,
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
        (Some((folder, file)), _) if offline(&folder, &file) => Some(Copy::Offline),
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
                print!("{}", checkouts(&folder, Path::new(REPOS)));
                return Ok(1);
            }
            Some(Copy::Offline) => {
                println!(
                    "Cloudroom on the user's computer stopped sending this project at least 4 minutes ago: the computer may be offline or asleep, or the app closed. Do not wait for more files; any that arrive later never replace yours. If the project is on GitHub, clone it into a separate sibling folder and work there; otherwise work with the files that are here, pull what you need from the user's Mac with `room-cli mac pull` once it is back online, or ask the user to bring that computer back online with Cloudroom open."
                );
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
                print!("{}", checkouts(cwd, Path::new(REPOS)));
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
                "The project is still copying after 10 minutes. The copy may have stopped (for example, if the sandbox restarted during setup), or it may still finish later. If the project is on GitHub, clone it into a separate sibling folder and work there; otherwise work with the files that are here, or pull what you need from the user's Mac with `room-cli mac pull`."
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

/// After a failed or missing copy, names the Git checkouts in `repos`, since one may be this project's repository (#2256).
/// Cloudroom can't tell which, so the agent checks the origin and branch; nothing is switched or copied for it. The folder
/// may hold a failure note or `.env` files, so the commands clone beside it and only add files missing here.
fn checkouts(folder: &Path, repos: &Path) -> String {
    if folder.join(".git").exists() {
        return String::new();
    }
    let git = |dir: &Path, args: &[&str]| {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|out| out.status.success())?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    };
    let mut found: Vec<String> = std::fs::read_dir(repos)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.join(".git").is_dir())
        .filter_map(|path| {
            let origin = shown_origin(&git(&path, &["remote", "get-url", "origin"])?);
            let branch = git(&path, &["branch", "--show-current"])
                .filter(|branch| !branch.is_empty())
                .unwrap_or_else(|| "no branch".into());
            Some(format!(
                "`{}` (origin {origin}, branch {branch})",
                path.display()
            ))
        })
        .collect();
    if found.is_empty() {
        return String::new();
    }
    found.sort();
    let to = folder.display().to_string();
    let (to, clone) = (quote(&to), quote(&format!("{to}.clone")));
    // Literal pathspecs: a missing `a[1].txt` must never restore an edited `a1.txt` too.
    format!(
        "\nThis sandbox already has these checkouts: {}. Cloudroom does not know whether one is this project. If one's origin is this project's repository, clone that origin beside this folder, move only its `.git` here, and restore only the files missing here, so no file here is replaced:\n    git clone <origin> {clone} && mv {clone}/.git {to}/ && rm -rf {clone} && cd {to} && git ls-files --deleted -z | xargs -0 -r git --literal-pathspecs restore -- && git status\nThen check out the branch the task needs. Don't work in `{}`, which other threads share. If you can't tell, ask the user.\n",
        found.join("; "),
        repos.display()
    )
}

/// An origin without its login: network URLs lose the userinfo after any number of slashes (an SSH user stays, its
/// password goes), as `stripGitUrlCredentials` does. Scp-style `user@host:path` and paths stay. Anything else with an
/// `@` before the path, a remote helper (`::`), or any control character, shows as `origin hidden`.
fn shown_origin(origin: &str) -> String {
    const HIDDEN: &str = "hidden";
    // `https::https://…` hands the rest to a remote helper, whose URL this can't read.
    if origin.chars().any(char::is_control) || origin.contains("::") {
        return HIDDEN.into();
    }
    let Some((scheme, rest)) = origin.split_once(':') else {
        return origin.into();
    };
    let is_scheme = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c));
    let after = rest.trim_start_matches('/');
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let (true, Some(at)) = (is_scheme, after[..end].rfind('@')) else {
        return origin.into();
    };
    let slashes = &rest[..rest.len() - after.len()];
    if slashes.is_empty() {
        return HIDDEN.into();
    }
    let scheme_lower = scheme.to_ascii_lowercase();
    let user = match scheme_lower.as_str() {
        "ssh" | "git+ssh" | "ssh+git" => match after[..at].split(':').next() {
            Some(user) if !user.is_empty() && !user.contains('@') => format!("{user}@"),
            Some(user) if !user.is_empty() => return HIDDEN.into(),
            _ => String::new(),
        },
        "http" | "https" | "ftp" | "ftps" | "git" | "git+http" | "git+https" => String::new(),
        _ => return HIDDEN.into(),
    };
    format!("{scheme}:{slashes}{user}{}", &after[at + 1..])
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
    let _ = std::fs::write(beside(&folder, GAVE_UP), "");
}

/// The app touched this copy's heartbeat (not an earlier copy's, from before its `copying`), then went silent.
fn offline(folder: &Path, status: &Path) -> bool {
    let modified = |path: &Path| path.metadata().and_then(|meta| meta.modified()).ok();
    let (Some(alive), Some(copying)) = (modified(&heartbeat(folder)), modified(status)) else {
        return false;
    };
    alive >= copying && alive.elapsed().is_ok_and(|silent| silent >= SILENT)
}

/// The app's heartbeat for a copy into `folder`.
pub fn heartbeat(folder: &Path) -> PathBuf {
    beside(folder, ALIVE)
}

fn beside(folder: &Path, suffix: &str) -> PathBuf {
    let mut path = folder.as_os_str().to_owned();
    path.push(suffix);
    path.into()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_never_show_a_login() {
        for (origin, shown) in [
            (
                "https://github.com/acme/demo.git",
                "https://github.com/acme/demo.git",
            ),
            (
                "https://user:TOKEN@github.com/acme/demo",
                "https://github.com/acme/demo",
            ),
            (
                "https:///user:TOKEN@github.com/acme/demo",
                "https:///github.com/acme/demo",
            ),
            ("HTTPS:TOKEN@github.com/acme/demo", "hidden"),
            (
                "https::https://user:TOKEN@example.invalid/repo.git",
                "hidden",
            ),
            ("git::ssh://git:TOKEN@example.invalid/repo", "hidden"),
            ("ssh://a@b:TOKEN@example.invalid/repo", "hidden"),
            ("https:/TOKEN@github.com/acme", "https:/github.com/acme"),
            ("https://a@b:TOKEN@github.com/x", "https://github.com/x"),
            (
                "ssh://git:TOKEN@github.com/acme/demo",
                "ssh://git@github.com/acme/demo",
            ),
            (
                "git@github.com:acme/demo.git",
                "git@github.com:acme/demo.git",
            ),
            ("svn+https://u:TOKEN@host/x", "hidden"),
            ("https://TOKEN@host/x\n", "hidden"),
            ("/srv/repos/demo", "/srv/repos/demo"),
        ] {
            assert_eq!(shown_origin(origin), shown, "{origin}");
        }
    }

    #[test]
    fn the_hint_adds_a_checkout_without_replacing_files() {
        let dir = std::env::temp_dir().join(format!("cloudroom-files-{}", std::process::id()));
        let (folder, repos) = (dir.join("O'Brien project"), dir.join("repos"));
        let run = |cwd: &Path, line: &str| {
            let ok = std::process::Command::new("sh")
                .arg("-c")
                .arg(line)
                .current_dir(cwd)
                .status();
            assert!(ok.unwrap().success(), "{line}");
        };
        std::fs::create_dir_all(folder.join(".cloudroom")).unwrap();
        assert_eq!(checkouts(&folder, &repos), "");
        let repo = repos.join("demo");
        std::fs::create_dir_all(&repo).unwrap();
        run(
            &repo,
            "git init -q -b main && echo a > a1.txt && echo b > 'a[1].txt' && git add . && git -c user.name=t -c user.email=t@t commit -qm init && git remote add origin \"$PWD\"",
        );
        std::fs::write(folder.join(FAILURE_NOTE), "failed").unwrap();
        std::fs::write(folder.join("a1.txt"), "mine").unwrap();
        let hint = checkouts(&folder, &repos);
        assert!(hint.contains("branch main"), "{hint}");
        let line = hint
            .lines()
            .find(|line| line.starts_with("    git clone"))
            .unwrap();
        run(
            &dir,
            &line.replace("<origin>", &quote(&repo.display().to_string())),
        );
        let read = |name: &str| std::fs::read_to_string(folder.join(name)).unwrap();
        assert_eq!(
            (
                read(FAILURE_NOTE).as_str(),
                read("a1.txt").as_str(),
                read("a[1].txt").as_str()
            ),
            ("failed", "mine", "b\n")
        );
        assert_eq!(checkouts(&folder, &repos), "");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
