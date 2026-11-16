//! RepoSync (docs/scopes/repo-sync.md): commits each synced repo's work and pushes it to the repo's main branch, from
//! whatever branch the agent is on, between the agent's turns. The website writes the synced repos to `CONFIG` and
//! rewrites it on every change; Core reads it on every check, so turning a repo off stops it at once.

use crate::config::Config;
use serde::Deserialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{process::Command, sync::Notify};

const CONFIG: &str = "/etc/cloudroom/repo-sync.json";
/// The thread's own branch, noted in the repo's Git config the first time a check finds it on a `room/...` branch. It
/// survives sleep and wake; the script pushes only from it or the target branch.
const HOME: &str = "cloudroom.repo-sync-home";
const CHECK: Duration = Duration::from_secs(10);
const LIMIT: Duration = Duration::from_secs(120);
/// One sync, run as the agent with the target branch as `$1`. Prints `blocked PATH` per file left out and ends with
/// `result WORD DETAIL`. It never force-pushes, never runs hooks, never pushes commits another GitHub branch has (a
/// teammate's pull request, the branch the thread started from), and never touches Git work the agent has in
/// progress. The marker file names a rebase as its own, so a sync cut short has it aborted by the next one.
const SCRIPT: &str = r#"set -u
branch=$1 target=refs/cloudroom/repo-sync
say() { echo "result $*"; exit 0; }
g() { git -c core.hooksPath=/dev/null "$@"; }
top=$(git rev-parse --show-toplevel 2>/dev/null) && cd "$top" || say failed "this folder is not a Git checkout"
dir=$(git rev-parse --absolute-git-dir)
own="$dir/cloudroom-repo-sync"
rebasing() { [ -e "$dir/rebase-merge" ] || [ -e "$dir/rebase-apply" ]; }
# Its own rebase is aborted; the marker goes only once that worked, so a failed abort is tried again next time.
abort() { g rebase --abort >/dev/null 2>&1; rebasing || rm -f "$own"; }
[ -e "$own" ] && { if rebasing; then abort; else rm -f "$own"; fi; }
for f in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG index.lock; do
  [ -e "$dir/$f" ] && say busy "$f"
done
current=$(git symbolic-ref -q --short HEAD) || say busy detached
[ -z "$(git ls-files -u)" ] || say busy unmerged
# Only the target branch or the thread's own branch (Core notes it on first sight) ever pushes: never a teammate's,
# a fork's pull request, or another thread's branch the agent checked out.
home=$(git config --get cloudroom.repo-sync-home)
[ "$current" = "$branch" ] || [ "$current" = "${home:-}" ] || say refused "$current"
grep -qs 'filter=lfs' .gitattributes && say failed "this repo uses Git LFS, which RepoSync doesn't support yet."
g fetch -q origin "+refs/heads/$branch:$target" 2>/dev/null || say failed "could not fetch $branch from GitHub: the branch is missing, or the GitHub login can't read the repo"
# Commits another GitHub branch already has (a teammate's work merged in) never go; the thread's own branch may hold its own.
mine_on=""; [ "$current" = "${home:-}" ] && mine_on="origin/$current"
mine=$(git rev-list --count HEAD "^$target" --not ${mine_on:+--exclude=$mine_on} --remotes=origin)
if [ "$mine" != "$(git rev-list --count HEAD "^$target")" ]; then
  first=$(git rev-list --reverse HEAD "^$target" | head -n 1)
  other=$(git branch -r --contains "$first" --format='%(refname:short)' | grep -vx "${mine_on:-origin/HEAD}" | head -n 1)
  say foreign "${other:-another branch}"
fi
g add -A >/dev/null 2>&1 || say busy add
# Secrets by name (no content scan), and files GitHub refuses (100 MB; 50 MB leaves room), stay out.
git diff --cached --name-only -z --diff-filter=AMR | while IFS= read -r -d '' f; do
  case "/$f" in
    */.env.example|*/.env.sample|*/.env.template|*/.env.dist) continue ;;
    */.env|*/.env.*|*.env|*/.envrc|*/.dev.vars|*/.secrets|*/id_rsa*|*/id_dsa*|*/id_ed25519*|*/id_ecdsa*|*.key|*.pem|*.p8|\
    *.p12|*.pfx|*.ppk|*.jks|*.keystore|*.kdbx|*/.npmrc|*/.pypirc|*/.netrc|*/.git-credentials|*/.htpasswd|*/.pgpass|\
    */.my.cnf|*/.vault-token|*/auth.json|*/.mcp.json|*/.aws/credentials|*/application_default_credentials.json|\
    */.config/gh/hosts.yml|*/.docker/config.json|*/.kube/config|*.kubeconfig|*.tfstate|*.tfstate.*|*.tfvars|\
    */secrets.json|*/secrets.txt|*/secrets.y*ml|*/secrets.toml|*/credentials.json|*/token.txt|*/tokens.txt|\
    */client_secret*.json|*/service-account*.json|*dump*.sql|*.dump) ;;
    *) [ "$(wc -c < "$f" 2>/dev/null || echo 0)" -le 52428800 ] && continue ;;
  esac
  git reset -q -- "$f" && echo "blocked $f"
done
if ! git diff --cached --quiet; then
  n=$(git diff --cached --name-only | wc -l)
  names=$(git diff --cached --name-only | head -n 3 | paste -sd ' ' -)
  [ "$n" -gt 3 ] && names="$names and $((n - 3)) more"
  out=$(g commit -q --no-verify -m "RepoSync: $names" 2>&1) || say failed "git commit failed: $(printf %s "$out" | tail -n 3 | tr '\n' ' ')"
fi
for try in 1 2; do
  [ "$try" = 1 ] || g fetch -q origin "+refs/heads/$branch:$target" 2>/dev/null || say failed "could not fetch $branch from GitHub"
  [ -n "$(git rev-list -n 1 "$target..HEAD")" ] || say clean
  if ! git merge-base --is-ancestor "$target" HEAD; then
    left=$(git diff --name-only | head -n 3 | paste -sd ' ' -)
    [ -z "$left" ] || say failed "changes to files RepoSync leaves out ($left) block rebasing onto newer work on GitHub. Restore them (git checkout -- FILE), or stop tracking them (git rm --cached FILE, then add them to .gitignore)."
    : > "$own"
    g rebase -q "$target" >/dev/null 2>&1 || { abort; say conflict; }
    rm -f "$own"
  fi
  out=$(g push -q --no-verify origin "HEAD:refs/heads/$branch" 2>&1) && say pushed "$(git rev-parse --short HEAD)"
done
say rejected "$(printf %s "$out" | grep -v '^To ' | tail -n 2 | tr '\n' ' ')"
"#;

#[derive(Clone, Deserialize)]
pub struct Repo {
    repo: String,
    branch: String,
    every: u64,
}
#[derive(Deserialize)]
struct Settings {
    repos: Vec<Repo>,
}

/// One folder to check: its path, a session to tell about problems, and whether an agent there is mid-turn. A shared
/// folder (`/repos`) belongs to no thread: any agent may edit it, so any turn ending nudges it.
pub struct Target {
    pub path: PathBuf,
    pub tell: Option<String>,
    pub busy: bool,
    pub shared: bool,
}

#[derive(Default)]
struct Folder {
    /// `git status` (with HEAD) right after the last sync that finished: nothing changed since means nothing to do.
    done: String,
    ran: Option<Instant>,
    /// The problem the agent was last told about, so a lasting one is told once; a good sync clears it.
    told: Option<String>,
    blocked: Vec<String>,
    /// Whether the thread's own branch is noted in the repo's Git config (`HOME`).
    home: bool,
}

pub struct RepoSync {
    home: PathBuf,
    agent: Option<(u32, u32)>,
    folders: Mutex<HashMap<PathBuf, Folder>>,
    /// Folders whose turn just ended: they sync now instead of at their interval.
    nudged: Mutex<HashSet<PathBuf>>,
    wake: Notify,
    running: AtomicBool,
}

/// Holds RepoSync's running flag for one check. A drain waits while it's set, and dropping it (even in a panic) clears it.
pub struct Running<'a>(&'a RepoSync);
impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::SeqCst);
    }
}

impl RepoSync {
    pub fn new(config: &Config) -> Self {
        Self {
            home: config.account_home.clone(),
            agent: (config.storage.as_ref()).map(|p| (p.agent_uid, p.agent_gid)),
            folders: Mutex::default(),
            nudged: Mutex::default(),
            wake: Notify::new(),
            running: AtomicBool::new(false),
        }
    }

    /// The synced repos, or none without the file (RepoSync off, or a Core outside our sandboxes).
    pub fn repos() -> Vec<Repo> {
        std::fs::read(CONFIG)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
            .map_or_else(Vec::new, |s| s.repos)
    }

    /// A turn ended in `folder`: it syncs at the next check instead of waiting for its interval.
    pub fn nudge(&self, folder: &Path) {
        self.nudged.lock().unwrap().insert(folder.to_owned());
        self.wake.notify_one();
    }

    pub async fn wait(&self) {
        let _ = tokio::time::timeout(CHECK, self.wake.notified()).await;
    }

    /// Taken under the session lock with the draining flag, so a drain waits for a check that has begun (sleep.rs).
    pub fn start(&self) -> Running<'_> {
        self.running.store(true, Ordering::SeqCst);
        Running(self)
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// The system prompt, with a line saying RepoSync pushes this folder's repo when it does. Reads files only (no Git
    /// process), so it holds from a harness's very first start after a wake.
    pub fn prompt(folder: &Path, prompt: Option<String>) -> Option<String> {
        let repos = Self::repos();
        let Some(repo) = (folder.ancestors())
            .find_map(|dir| std::fs::read_to_string(dir.join(".git/config")).ok())
            .and_then(|config| origin_url(&config))
            .and_then(|url| github_repo(&url))
            .and_then(|name| {
                repos
                    .into_iter()
                    .find(|r| r.repo.eq_ignore_ascii_case(&name))
            })
        else {
            return prompt;
        };
        let line = format!(
            "RepoSync is on for this repo: when you finish a turn, Cloudroom commits your changes and pushes them to `{}` on GitHub, from any branch. Don't commit or push yourself. Never put secrets in tracked files.",
            repo.branch
        );
        Some(prompt.map_or(line.clone(), |p| format!("{p}\n\n{line}")))
    }

    /// One check: each idle folder of a synced repo with new work syncs once its turn ended or its interval passed.
    /// Returns the notices to send, at most one per new problem.
    pub async fn check(&self, repos: &[Repo], targets: Vec<Target>) -> Vec<(String, String)> {
        let nudged: HashSet<PathBuf> = std::mem::take(&mut *self.nudged.lock().unwrap())
            .into_iter()
            .filter_map(|p| p.canonicalize().ok())
            .collect();
        let mut notices = Vec::new();
        for Target {
            path,
            tell,
            busy,
            shared,
        } in targets
        {
            let turn_ended = nudged.contains(&path) || (shared && !nudged.is_empty());
            // Never mid-turn: half-written work stays out of main, and the agent's own Git commands never race ours.
            // A turn end seen while another turn runs there waits for the next check instead of being lost.
            if busy {
                if turn_ended {
                    self.nudged.lock().unwrap().insert(path);
                }
                continue;
            }
            let Some(repo) = (self
                .git(&path, &["config", "--get", "remote.origin.url"])
                .await)
                .and_then(|url| github_repo(&url))
                .and_then(|name| repos.iter().find(|r| r.repo.eq_ignore_ascii_case(&name)))
            else {
                continue;
            };
            let Some(status) = self.status(&path).await else {
                continue;
            };
            self.note_home(&path, &status).await;
            let every = Duration::from_secs(repo.every.clamp(30, 3600));
            let due = {
                let mut all = self.folders.lock().unwrap();
                let f = all.entry(path.clone()).or_default();
                status != f.done && (turn_ended || f.ran.is_none_or(|t| t.elapsed() >= every))
            };
            if !due {
                continue;
            }
            let output = self.sync(&path, &repo.branch).await;
            let after = self.status(&path).await.unwrap_or_default();
            let (result, detail) = match &output {
                Ok(out) => out
                    .lines()
                    .rev()
                    .find_map(|l| l.strip_prefix("result "))
                    .map_or(("failed", "the sync stopped without a result"), |r| {
                        r.split_once(' ').unwrap_or((r, ""))
                    }),
                Err(error) => ("failed", error.as_str()),
            };
            let blocked: Vec<String> = (output.as_deref().unwrap_or_default().lines())
                .filter_map(|l| l.strip_prefix("blocked ").map(str::to_owned))
                .collect();
            let (name, branch, detail) = (&repo.repo, &repo.branch, detail.trim());
            let problem = match result {
                "pushed" | "clean" | "busy" => None,
                "conflict" => Some(format!(
                    "[Cloudroom] RepoSync could not push {name} to `{branch}`: your commits conflict with newer work on GitHub. Run `git fetch origin {branch} && git rebase origin/{branch}`, resolve the conflicts, and finish the rebase. RepoSync pushes again on its own."
                )),
                "refused" => Some(format!(
                    "[Cloudroom] RepoSync did not push {name}: it pushes only from `{branch}` or this thread's own branch, and this folder is on `{detail}`. Switch back, or ask the user how to land this work."
                )),
                "foreign" => Some(format!(
                    "[Cloudroom] RepoSync did not push {name} to `{branch}`: this branch has commits from `{detail}` on GitHub, which RepoSync never pushes for someone else. Ask the user how to land them."
                )),
                "rejected" => Some(format!(
                    "[Cloudroom] GitHub refused RepoSync's push of {name} to `{branch}`: {detail} If the branch is protected, ask the user to pick another branch in Settings → Cloud → RepoSync, or to turn RepoSync off for this repo."
                )),
                _ => Some(format!(
                    "[Cloudroom] RepoSync could not sync {name}: {detail}"
                )),
            };
            let mut all = self.folders.lock().unwrap();
            let f = all.entry(path).or_default();
            f.ran = Some(Instant::now());
            if matches!(result, "pushed" | "clean") {
                f.done = after;
            }
            // Files stay left out on every sync, so only newly left-out ones are told. A sync that stopped before the
            // filter (busy, failed to start) says nothing about them.
            let mut news = Vec::new();
            if !matches!(result, "busy") && output.is_ok() {
                let new: Vec<&str> = (blocked.iter())
                    .filter(|b| !f.blocked.contains(b))
                    .map(String::as_str)
                    .collect();
                if !new.is_empty() {
                    news.push(format!("[Cloudroom] RepoSync left these files out of {name}: {}. Their names look like secrets, or they are over 50 MB. Add them to .gitignore if they should stay in this sandbox.", new.join(", ")));
                }
                f.blocked = blocked;
            }
            if problem.is_none() && result != "busy" {
                f.told = None;
            } else if problem.is_some() && problem != f.told {
                f.told.clone_from(&problem);
                news.extend(problem);
            }
            if let Some(session) = &tell {
                notices.extend(news.into_iter().map(|text| (session.clone(), text)));
            }
        }
        notices
    }

    /// Notes the thread's own branch once: the first `room/...` branch a check finds in the folder. Until then, each
    /// check looks again, since a template's checkout switches to its thread's branch after the folder appears.
    async fn note_home(&self, path: &Path, status: &str) {
        if self
            .folders
            .lock()
            .unwrap()
            .get(path)
            .is_some_and(|f| f.home)
        {
            return;
        }
        let head = (status.lines()).find_map(|l| l.strip_prefix("# branch.head "));
        let noted = self.git(path, &["config", "--get", HOME]).await.is_some()
            || match head.filter(|h| h.starts_with("room/")) {
                Some(head) => self.git(path, &["config", HOME, head]).await.is_some(),
                None => false,
            };
        if noted {
            self.folders
                .lock()
                .unwrap()
                .entry(path.to_owned())
                .or_default()
                .home = true;
        }
    }

    async fn status(&self, folder: &Path) -> Option<String> {
        self.git(folder, &["status", "--porcelain=v2", "--branch"])
            .await
    }

    async fn git(&self, folder: &Path, args: &[&str]) -> Option<String> {
        let mut command = self.command(folder, "git")?;
        command.args(args);
        let output = tokio::time::timeout(Duration::from_secs(10), command.output())
            .await
            .ok()?
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    /// Runs `SCRIPT` in a process group of its own; at the time limit the whole group goes, Git included.
    async fn sync(&self, folder: &Path, branch: &str) -> Result<String, String> {
        let mut command = self
            .command(folder, "bash")
            .ok_or("Git could not run as the agent")?;
        command
            .args(["-c", SCRIPT, "repo-sync", branch])
            .stdout(Stdio::piped())
            .process_group(0);
        let child = command
            .spawn()
            .map_err(|e| format!("Git could not start: {e}"))?;
        let group = child.id();
        match tokio::time::timeout(LIMIT, child.wait_with_output()).await {
            Ok(Ok(output)) => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
            Ok(Err(error)) => Err(format!("Git could not run: {error}")),
            Err(_) => {
                if let Some(group) = group.and_then(|g| i32::try_from(g).ok()) {
                    unsafe extern "C" {
                        fn kill(pid: i32, signal: i32) -> i32;
                    }
                    // SAFETY: a plain signal to the process group this sync started.
                    unsafe { kill(-group, 9) };
                }
                Err("the sync took over 2 minutes and was stopped; it tries again later".into())
            }
        }
    }

    /// Git as the agent, with its own Git config and GitHub login, never a credential prompt, and never the index
    /// lock for reads (the agent's own Git commands would fail on it). None when the agent's identity can't be taken:
    /// RepoSync never runs Git as Core.
    fn command(&self, folder: &Path, program: &str) -> Option<Command> {
        let mut command = Command::new(program);
        command
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("HOME", &self.home)
            .env("LANG", "C.UTF-8")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .current_dir(folder)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some((uid, gid)) = self.agent
            && let Err(error) = crate::runtime::linux::as_agent(&mut command, uid, gid, None, true)
        {
            eprintln!("RepoSync cannot run as the agent: {error}");
            return None;
        }
        Some(command)
    }
}

/// `remote.origin.url` from a `.git/config` file.
fn origin_url(config: &str) -> Option<String> {
    let mut origin = false;
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            origin = line.replace(' ', "") == "[remote\"origin\"]";
        } else if origin
            && let Some((key, value)) = line.split_once('=')
            && key.trim() == "url"
        {
            return Some(value.trim().to_owned());
        }
    }
    None
}

/// `owner/name` of a GitHub remote: https, ssh, or `git@github.com:` form.
fn github_repo(url: &str) -> Option<String> {
    let rest = url.trim().split_once("github.com")?.1;
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('/'))?;
    let mut parts = rest
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    (!owner.is_empty() && !name.is_empty()).then(|| format!("{owner}/{name}"))
}
