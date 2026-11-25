//! `cloudroom git`: the Git reads behind the app's Git panel and diff view, and its Commit button. One implementation
//! for Local threads (the app runs its bundled copy) and Cloud threads (the app runs it in the sandbox). Prints JSON in
//! the app's own shapes (`WorkspaceStatus` and the diff types in `@cloudroom/domain`).
//!
//! Reads never change the repository: no hooks (also Git 2.54+ config hooks), no textconv or external diff, no optional
//! locks, and no lazy fetches in partial clones, so only objects already here are read. Untracked files are diffed
//! through a throwaway copy of the index, marked intent-to-add, with its own object folder. Untracked files over 1 MiB,
//! or past 8 MiB in all, are listed but never read. Only `commit` writes, with the user's own Git settings and hooks.
//!
//! Plain `std` and `serde_json`, so it also builds for Windows.
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};

const USAGE: &str = "Usage: cloudroom git COMMAND
The Git reads behind the Cloudroom app's Git panel and diff view, as JSON, from the current folder.

  status [--base BRANCH | --default-base] [--untracked-files N] [--untracked-bytes N]
  files TARGET [--max-files N]
  patch TARGET [--max-bytes N]                 Paths on stdin, each ending in a NUL byte
  diff TARGET [--max-bytes N] [--max-list-bytes N] [--max-untracked N]
  show TARGET old|new PATH [--merge-base SHA]  The file's bytes
  branches [--query TEXT] [--limit N] [--selected BRANCH]
  commit --message TEXT [--no-verify]

TARGET is uncommitted, branch:NAME, all:NAME, or commit:SHA.
Exit codes: 2 usage, 3 not a Git repository, 4 nothing to commit, 5 branch or commit not found,
6 file not found, 7 file too large, 8 Git failed.";

const USAGE_ERROR: i32 = 2;
const NOT_A_REPO: i32 = 3;
const NOTHING_TO_COMMIT: i32 = 4;
const MISSING: i32 = 5;
const FILE_NOT_FOUND: i32 = 6;
const TOO_LARGE: i32 = 7;
const FAILED: i32 = 8;

// Defaults match the app's limits, so callers can leave them out.
const UNTRACKED_FILES: usize = 50;
const UNTRACKED_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 500;
const PATCH_BYTES: usize = 512 * 1024;
const DIFF_BYTES: usize = 2 * 1024 * 1024;
const LIST_BYTES: usize = 256 * 1024;
const BRANCHES: usize = 100;
/// Untracked files bigger than this are listed, never read.
const UNTRACKED_FILE_BYTES: u64 = 1024 * 1024;
/// All patches in one reply together.
const PATCH_REPLY_BYTES: usize = 12 * 1024 * 1024;
const SHOW_BYTES: u64 = 10 * 1024 * 1024;
const COMMITS: &str = "500";
/// Base-branch commits searched for a squash merge of this branch.
const SQUASH_SCAN: &str = "1000";

/// Read-only settings for every read, whatever the repository or user configures.
const READ_ONLY: &str = "-c core.hooksPath=/dev/null -c hook.post-index-change.enabled=false -c color.ui=never \
    -c diff.noprefix=false -c diff.mnemonicPrefix=false -c diff.relative=false -c core.splitIndex=false \
    -c core.untrackedCache=false -c core.fsmonitor=false -c diff.autoRefreshIndex=false";
pub(crate) const READ_ENV: &[(&str, &str)] = &[
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_LITERAL_PATHSPECS", "1"),
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_ALLOW_PROTOCOL", "none"),
    ("LC_ALL", "C"),
];
/// Why a file has no diff when a partial clone lacks content: reads never fetch it, the user's own Git commands do.
const NOT_DOWNLOADED: &str = "This partial clone hasn't downloaded the file content this diff needs, and Cloudroom \
    never downloads it. A Git command you run that reads it, like git diff HEAD, does; then retry.";

/// Whether Git failed for content a partial clone never downloaded (Git's message: `READ_ENV` keeps it in English).
fn not_downloaded(message: &str) -> bool {
    message.contains("from promisor remote")
}

struct Failure {
    code: i32,
    message: String,
}

type Result<T> = std::result::Result<T, Failure>;

fn fail<T>(code: i32, message: impl Into<String>) -> Result<T> {
    Err(Failure {
        code,
        message: message.into(),
    })
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Failure {
            code: FAILED,
            message: error.to_string(),
        }
    }
}

/// Why Git didn't start in `dir`: Git is missing, or the folder is gone (a deleted worktree).
fn not_started(error: io::Error, dir: &Path) -> Failure {
    match error.kind() {
        io::ErrorKind::NotFound if !dir.is_dir() => Failure {
            code: NOT_A_REPO,
            message: "This folder no longer exists.".to_owned(),
        },
        io::ErrorKind::NotFound => Failure {
            code: FAILED,
            message: "Git is not installed, or not on this computer's PATH.".to_owned(),
        },
        _ => error.into(),
    }
}

/// Runs `cloudroom git ARGS` and returns the exit code.
pub fn cli(args: &[String]) -> i32 {
    match run(args) {
        Ok(()) => 0,
        Err(failure) => {
            eprintln!("{}", failure.message);
            failure.code
        }
    }
}

fn run(args: &[String]) -> Result<()> {
    let options = Options::parse(args)?;
    let Some(command) = options.words.first().map(String::as_str) else {
        return fail(USAGE_ERROR, USAGE);
    };
    if matches!(command, "--help" | "-h" | "help") {
        println!("{USAGE}");
        return Ok(());
    }
    let repo = Repo::open()?;
    let output = match command {
        "status" => status(
            &repo,
            options.value("--base"),
            options.switches.contains("--default-base"),
            options.number("--untracked-files", UNTRACKED_FILES)?,
            options.number("--untracked-bytes", UNTRACKED_BYTES as usize)? as u64,
        )?,
        "files" => files(
            &repo,
            &options.target()?,
            options.number("--max-files", MAX_FILES)?,
        )?,
        "patch" => {
            let mut stdin = Vec::new();
            io::stdin().read_to_end(&mut stdin)?;
            patch(
                &repo,
                &options.target()?,
                &nul_list(&stdin),
                options.number("--max-bytes", PATCH_BYTES)?,
            )?
        }
        "diff" => diff(
            &repo,
            &options.target()?,
            options.number("--max-bytes", DIFF_BYTES)?,
            options.number("--max-list-bytes", LIST_BYTES)?,
            options.number("--max-untracked", MAX_FILES)?,
        )?,
        "show" => {
            let (Some(side), Some(path)) = (options.words.get(2), options.words.get(3)) else {
                return fail(USAGE_ERROR, USAGE);
            };
            let bytes = show(
                &repo,
                &options.target()?,
                side,
                path,
                options.value("--merge-base"),
            )?;
            io::stdout().write_all(&bytes)?;
            return Ok(());
        }
        "branches" => branches(
            &repo,
            options.value("--query"),
            options.number("--limit", BRANCHES)?,
            options.value("--selected"),
        )?,
        "commit" => commit(
            &repo,
            options.value("--message").unwrap_or(""),
            options.switches.contains("--no-verify"),
        )?,
        other => {
            return fail(
                USAGE_ERROR,
                format!("Unknown git command {other}.\n\n{USAGE}"),
            );
        }
    };
    let mut stdout = io::stdout().lock();
    stdout.write_all(output.to_string().as_bytes())?;
    stdout.write_all(b"\n")?;
    Ok(())
}

#[derive(Default)]
struct Options {
    words: Vec<String>,
    values: HashMap<String, String>,
    switches: HashSet<&'static str>,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self> {
        let mut options = Self::default();
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            if let Some(switch) = ["--no-verify", "--default-base"]
                .into_iter()
                .find(|switch| arg == switch)
            {
                options.switches.insert(switch);
            } else if arg == "--" {
                options.words.extend(args.by_ref().cloned());
            } else if arg.starts_with("--") && !options.words.is_empty() {
                let Some(value) = args.next() else {
                    return fail(USAGE_ERROR, format!("{arg} needs a value."));
                };
                options.values.insert(arg.clone(), value.clone());
            } else {
                options.words.push(arg.clone());
            }
        }
        Ok(options)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    fn number(&self, name: &str, default: usize) -> Result<usize> {
        match self.value(name).map(str::parse) {
            None => Ok(default),
            Some(Ok(number)) if number > 0 => Ok(number),
            Some(_) => fail(USAGE_ERROR, format!("{name} needs a positive number.")),
        }
    }

    fn target(&self) -> Result<Target> {
        Target::parse(self.words.get(1).map_or("", String::as_str))
    }
}

/// What a diff compares.
enum Target {
    Uncommitted,
    Branch(String),
    All(String),
    Commit(String),
}

impl Target {
    /// `branch` and `all` may leave out the name where only the kind matters (`show`).
    fn parse(text: &str) -> Result<Self> {
        let (kind, name) = text.split_once(':').unwrap_or((text, ""));
        if name.starts_with('-') {
            return fail(USAGE_ERROR, format!("Invalid target {text}."));
        }
        match kind {
            "uncommitted" => Ok(Self::Uncommitted),
            "branch" => Ok(Self::Branch(name.to_owned())),
            "all" => Ok(Self::All(name.to_owned())),
            "commit" if !name.is_empty() => Ok(Self::Commit(name.to_owned())),
            _ => fail(
                USAGE_ERROR,
                format!(
                    "Unknown target {text}: use uncommitted, branch:NAME, all:NAME, or commit:SHA."
                ),
            ),
        }
    }

    /// Whether the new side is the files on disk, untracked files included.
    fn working_tree(&self) -> bool {
        matches!(self, Self::Uncommitted | Self::All(_))
    }
}

/// The old side and the new one (`None` for the files on disk), and the merge base for branch targets.
struct Range {
    old: String,
    new: Option<String>,
    merge_base: Option<String>,
}

impl Range {
    fn diff<'a>(&'a self, options: &[&'a str]) -> Vec<&'a str> {
        let mut args = vec!["diff", "--no-ext-diff", "--no-textconv"];
        args.extend(options);
        args.push(&self.old);
        args.extend(self.new.as_deref());
        args
    }
}

/// A finished Git run: stdout up to its limit, and whether there was more.
struct Run {
    stdout: Vec<u8>,
    cut: bool,
    ok: bool,
    stderr: Vec<u8>,
}

/// A throwaway copy of the index and an object folder for it, removed when dropped.
struct Scratch {
    dir: PathBuf,
    objects: PathBuf,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// A checkout. Reads may run on several threads at once.
#[derive(Clone)]
struct Repo {
    top: PathBuf,
    scratch: Option<Arc<Scratch>>,
}

pub(crate) fn git_command() -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new("git");
    // Without this, every Git run flashes a console window on Windows.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    command
}

impl Repo {
    fn open() -> Result<Self> {
        let output = git_command()
            .args(["rev-parse", "--show-toplevel"])
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|error| not_started(error, Path::new(".")))?;
        // Only the line end: a folder's name may start or end with spaces.
        let top = lossy(&output.stdout)
            .trim_end_matches(['\n', '\r'])
            .to_owned();
        if !output.status.success() || top.is_empty() {
            return fail(NOT_A_REPO, "This folder is not a Git repository.");
        }
        Ok(Self {
            top: PathBuf::from(top),
            scratch: None,
        })
    }

    fn git(&self) -> Command {
        let mut command = git_command();
        command
            .args(READ_ONLY.split_whitespace())
            .envs(READ_ENV.iter().copied())
            .current_dir(&self.top);
        if let Some(scratch) = &self.scratch {
            command
                .env("GIT_INDEX_FILE", scratch.dir.join("index"))
                .env("GIT_OBJECT_DIRECTORY", scratch.dir.join("objects"))
                .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &scratch.objects);
        }
        command
    }

    /// Runs Git with `stdin`, keeping at most `limit` bytes of stdout; Git stops once it has more.
    fn exec(&self, args: &[&str], stdin: &[u8], limit: usize) -> Result<Run> {
        let mut child = self
            .git()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| not_started(error, &self.top))?;
        let input = child.stdin.take();
        let mut output = child.stdout.take().expect("piped stdout");
        let mut stderr_pipe = child.stderr.take().expect("piped stderr");
        let mut stdout = Vec::new();
        let (read, stderr) = thread::scope(|scope| {
            scope.spawn(move || input.map(|mut pipe| pipe.write_all(stdin)));
            let errors = scope.spawn(move || {
                let mut bytes = Vec::new();
                let _ = stderr_pipe.read_to_end(&mut bytes);
                bytes
            });
            let read = (&mut output)
                .take((limit as u64).saturating_add(1))
                .read_to_end(&mut stdout);
            if stdout.len() > limit {
                let _ = child.kill();
            }
            drop(output);
            (read, errors.join().unwrap_or_default())
        });
        read?;
        let status = child.wait()?;
        let cut = stdout.len() > limit;
        stdout.truncate(limit);
        Ok(Run {
            stdout,
            cut,
            ok: cut || status.success(),
            stderr,
        })
    }

    /// Stdout, or Git's own error.
    fn out_with(&self, args: &[&str], stdin: &[u8]) -> Result<Vec<u8>> {
        let run = self.exec(args, stdin, usize::MAX)?;
        if run.ok {
            return Ok(run.stdout);
        }
        let detail = text(&run.stderr);
        fail(
            FAILED,
            if detail.is_empty() {
                format!("git {} failed.", args.join(" "))
            } else {
                detail
            },
        )
    }

    fn out(&self, args: &[&str]) -> Result<Vec<u8>> {
        self.out_with(args, b"")
    }

    /// The first line Git prints, when it succeeds and prints one.
    fn line(&self, args: &[&str]) -> Option<String> {
        self.out(args)
            .ok()
            .map(|out| text(&out))
            .filter(|line| !line.is_empty())
    }

    fn verify(&self, revision: &str) -> Option<String> {
        self.line(&["rev-parse", "-q", "--verify", revision])
    }

    /// Up to `limit` NUL-terminated records, and whether Git had more. Stops Git at the limit.
    fn records(&self, args: &[&str], limit: usize) -> Result<(Vec<String>, bool)> {
        let mut child = self
            .git()
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut records = Vec::new();
        for record in BufReader::new(child.stdout.take().expect("piped stdout")).split(0) {
            if records.len() == limit {
                let _ = child.kill();
                let _ = child.wait();
                return Ok((records, true));
            }
            records.push(lossy(&record?));
        }
        if !child.wait()?.success() {
            return fail(FAILED, format!("git {} failed.", args.join(" ")));
        }
        Ok((records, false))
    }

    /// The first patch ID of each patch `args` prints; `None` when either Git run fails.
    fn patch_ids(&self, args: &[&str]) -> Option<Vec<String>> {
        let mut source = self
            .git()
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let ids = self
            .git()
            .args(["patch-id", "--stable"])
            .stdin(source.stdout.take()?)
            .stderr(Stdio::null())
            .output()
            .ok()?;
        (source.wait().ok()?.success() && ids.status.success()).then(|| {
            lossy(&ids.stdout)
                .lines()
                .filter_map(|line| line.split_whitespace().next().map(str::to_owned))
                .collect()
        })
    }

    fn head(&self) -> Option<String> {
        self.verify("HEAD^{commit}")
    }

    fn empty_tree(&self) -> Result<String> {
        Ok(text(&self.out(&[
            "hash-object",
            "-t",
            "tree",
            "--stdin",
        ])?))
    }

    fn head_or_empty(&self) -> Result<String> {
        self.head().map_or_else(|| self.empty_tree(), Ok)
    }

    /// The tip of a base branch. Remote first: the app compares against what's pushed.
    fn branch_tip(&self, branch: &str) -> Option<String> {
        if branch.is_empty() {
            return None;
        }
        let candidates = if branch.starts_with("refs/") {
            vec![branch.to_owned()]
        } else {
            ["refs/remotes/origin/", "refs/heads/", "refs/remotes/"]
                .map(|prefix| format!("{prefix}{branch}"))
                .to_vec()
        };
        candidates
            .into_iter()
            .find_map(|candidate| self.verify(&format!("{candidate}^{{commit}}")))
    }

    /// origin's HEAD, else main or master, else the first local branch.
    fn default_branch(&self) -> Option<String> {
        if let Some(head) = self.line(&["symbolic-ref", "-q", "refs/remotes/origin/HEAD"])
            && let Some(branch) = head.strip_prefix("refs/remotes/origin/")
        {
            return Some(branch.to_owned());
        }
        ["main", "master"]
            .into_iter()
            .find(|name| {
                self.verify(&format!("refs/heads/{name}")).is_some()
                    || self
                        .verify(&format!("refs/remotes/origin/{name}"))
                        .is_some()
            })
            .map(str::to_owned)
            .or_else(|| {
                self.line(&[
                    "for-each-ref",
                    "--count=1",
                    "--format=%(refname:short)",
                    "refs/heads",
                ])
            })
    }

    fn range(&self, target: &Target) -> Result<Range> {
        Ok(match target {
            Target::Uncommitted => Range {
                old: self.head_or_empty()?,
                new: None,
                merge_base: None,
            },
            Target::Branch(branch) | Target::All(branch) => {
                let Some(base) = self.branch_tip(branch) else {
                    return fail(MISSING, format!("Branch {branch} was not found."));
                };
                let head = self.head();
                let merge_base = match &head {
                    Some(head) => match self.line(&["merge-base", &base, head]) {
                        Some(merge_base) => Some(merge_base),
                        None => {
                            return fail(
                                MISSING,
                                format!("This branch shares no history with {branch}."),
                            );
                        }
                    },
                    None => None,
                };
                let old = merge_base.clone().map_or_else(|| self.empty_tree(), Ok)?;
                let new = match target {
                    Target::Branch(_) => Some(head.map_or_else(|| self.empty_tree(), Ok)?),
                    _ => None,
                };
                Range {
                    old,
                    new,
                    merge_base,
                }
            }
            Target::Commit(sha) => {
                let Some(new) = self.verify(&format!("{sha}^{{commit}}")) else {
                    return fail(MISSING, "Commit not found.");
                };
                let old = self
                    .verify(&format!("{new}^"))
                    .map_or_else(|| self.empty_tree(), Ok)?;
                Range {
                    old,
                    new: Some(new),
                    merge_base: None,
                }
            }
        })
    }

    /// Splits `paths` into untracked files to read, each and all together within budget, and the rest.
    fn readable(&self, paths: Vec<String>) -> (Vec<String>, Vec<String>) {
        let mut budget = UNTRACKED_BYTES;
        paths.into_iter().partition(|path| match self.size(path) {
            Some(size) if size <= UNTRACKED_FILE_BYTES && size <= budget => {
                budget -= size;
                true
            }
            _ => false,
        })
    }

    /// The `paths` still on disk.
    fn existing(&self, paths: &[String]) -> Vec<String> {
        paths
            .iter()
            .filter(|path| self.size(path).is_some())
            .cloned()
            .collect()
    }

    /// The size of a file or symlink in the checkout; `None` for anything else.
    fn size(&self, path: &str) -> Option<u64> {
        let metadata = fs::symlink_metadata(self.top.join(path)).ok()?;
        (metadata.is_file() || metadata.is_symlink()).then_some(metadata.len())
    }

    /// This checkout with `paths` marked intent-to-add, so diffs against the files on disk include them. The marks
    /// go in a throwaway copy of the index with its own object folder: the real index and objects never change.
    fn with_untracked(&self, paths: &[String]) -> Result<Self> {
        let mut paths = self.existing(paths);
        if paths.is_empty() {
            return Ok(self.clone());
        }
        let out = lossy(&self.out(&[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "index",
            "--git-path",
            "objects",
        ])?);
        let mut lines = out.lines().map(PathBuf::from);
        let (Some(index), Some(objects)) = (lines.next(), lines.next()) else {
            return fail(FAILED, "git rev-parse --git-path printed no paths.");
        };
        static SCRATCHES: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cloudroom-git-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |time| time.as_nanos()),
            SCRATCHES.fetch_add(1, Ordering::Relaxed)
        ));
        // A new folder only its owner can open: the index copy names every file in the checkout.
        let mut folder = fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut folder, 0o700);
        folder.create(&dir)?;
        let scratch = Scratch { dir, objects };
        fs::create_dir(scratch.dir.join("objects"))?;
        match fs::copy(&index, scratch.dir.join("index")) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let marked = Self {
            top: self.top.clone(),
            scratch: Some(Arc::new(scratch)),
        };
        loop {
            let Err(error) = marked.out_with(
                &[
                    "add",
                    "-N",
                    "--sparse",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
                &nul_join(&paths),
            ) else {
                return Ok(marked);
            };
            // An agent may delete a file at any moment: try again without the ones that went.
            let left = self.existing(&paths);
            if left.len() == paths.len() {
                return Err(error);
            }
            if left.is_empty() {
                return Ok(self.clone());
            }
            paths = left;
        }
    }
}

/// A line of `git status --porcelain=v1 -z`.
struct Entry {
    code: String,
    path: String,
}

fn porcelain(bytes: &[u8]) -> Vec<Entry> {
    let mut tokens = bytes.split(|byte| *byte == 0);
    let mut entries = Vec::new();
    while let Some(token) = tokens.next() {
        if token.len() < 4 {
            continue;
        }
        let code = lossy(&token[..2]);
        if code.contains(['R', 'C']) {
            tokens.next(); // The path it came from.
        }
        entries.push(Entry {
            code,
            path: lossy(&token[3..]),
        });
    }
    entries
}

/// A file of `git diff --name-status -z`.
struct Change {
    letter: char,
    path: String,
    previous: Option<String>,
}

fn name_status(bytes: &[u8]) -> Vec<Change> {
    let mut tokens = bytes.split(|byte| *byte == 0);
    let mut changes = Vec::new();
    while let Some(status) = tokens.next() {
        let Some(&letter) = status.first() else {
            continue;
        };
        let letter = letter as char;
        let previous = matches!(letter, 'R' | 'C')
            .then(|| tokens.next().map(lossy))
            .flatten();
        if let Some(path) = tokens.next() {
            changes.push(Change {
                letter,
                path: lossy(path),
                previous,
            });
        }
    }
    changes
}

/// Lines added and removed by path, from `git diff --numstat -z`; a binary file has no counts.
type Counts = (Option<u64>, Option<u64>);

fn numstat(bytes: &[u8]) -> HashMap<String, Counts> {
    let mut tokens = bytes.split(|byte| *byte == 0);
    let mut counts = HashMap::new();
    while let Some(token) = tokens.next() {
        let line = lossy(token);
        let mut parts = line.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            tokens.next(); // A rename: the old path, then the new one.
            tokens.next().map(lossy).unwrap_or_default()
        } else {
            path.to_owned()
        };
        counts.insert(path, (added.parse().ok(), removed.parse().ok()));
    }
    counts
}

/// The status the app shows for a `git status` code.
fn status_kind(code: &str) -> &'static str {
    if code == "??" {
        return "??";
    }
    [('U', "U"), ('R', "R"), ('C', "C"), ('A', "A"), ('D', "D")]
        .into_iter()
        .find(|(letter, _)| code.contains(*letter))
        .map_or("M", |(_, kind)| kind)
}

fn working_tree_state(committed: bool, tracked: bool, untracked: bool) -> &'static str {
    match (tracked || untracked, committed) {
        (false, false) => "clean",
        (true, true) => "dirty_and_committed_unmerged",
        (false, true) => "committed_unmerged",
        _ if tracked => "dirty_uncommitted",
        _ => "untracked",
    }
}

fn shortstat(files: usize, added: u64, removed: u64) -> String {
    if files == 0 {
        return String::new();
    }
    let plural = |count: u64| if count == 1 { "" } else { "s" };
    let mut text = format!("{files} file{} changed", plural(files as u64));
    if added > 0 {
        text += &format!(", {added} insertion{}(+)", plural(added));
    }
    if removed > 0 {
        text += &format!(", {removed} deletion{}(-)", plural(removed));
    }
    text + "\n"
}

/// Sums the known counts.
fn totals<'a>(counts: impl Iterator<Item = &'a Counts>) -> (u64, u64) {
    counts.fold((0, 0), |(added, removed), (more, less)| {
        (added + more.unwrap_or(0), removed + less.unwrap_or(0))
    })
}

/// `default_base` compares with the default branch when `base` is `None`.
fn status(
    repo: &Repo,
    base: Option<&str>,
    default_base: bool,
    max_files: usize,
    max_bytes: u64,
) -> Result<Value> {
    let head = repo.head();
    let default = repo.default_branch();
    let base = base.or(default.as_deref().filter(|_| default_base));
    thread::scope(|scope| {
        let branch = scope.spawn(|| repo.line(&["symbolic-ref", "-q", "--short", "HEAD"]));
        let merge_base =
            base.map(|base| scope.spawn(|| merge_base_status(repo, base, head.as_deref())));
        let (entries, files, complete) = working_tree(repo, head.as_deref(), max_files, max_bytes)?;
        let merge_base = merge_base.map_or(Ok(Value::Null), join)?;
        let branch = join(branch);
        let (added, removed) = totals(files.iter());
        let tracked = entries.iter().any(|entry| entry.code != "??");
        let untracked = entries.iter().any(|entry| entry.code == "??");
        let checkout = match (&branch, &head) {
            (Some(branch), Some(head)) => {
                json!({ "kind": "branch", "branchName": branch, "headSha": head })
            }
            (Some(branch), None) => json!({ "kind": "unborn", "branchName": branch }),
            (None, Some(head)) => json!({ "kind": "detached", "headSha": head }),
            (None, None) => {
                json!({ "kind": "unknown", "reason": "HEAD is not symbolic and no commit is checked out" })
            }
        };
        Ok(json!({
            "workingTree": {
                "hasUncommittedChanges": !entries.is_empty(),
                "state": working_tree_state(merge_base["hasCommittedUnmergedChanges"] == true, tracked, untracked),
                "insertions": added,
                "deletions": removed,
                "lineStatsComplete": complete,
                "files": entries.iter().zip(&files).map(|(entry, (added, removed))| json!({
                    "path": entry.path,
                    "status": status_kind(&entry.code),
                    "insertions": added,
                    "deletions": removed,
                })).collect::<Vec<_>>(),
            },
            "checkout": checkout,
            "branch": {
                "currentBranch": branch,
                "defaultBranch": default.clone().or(branch).unwrap_or_default(),
            },
            "mergeBase": merge_base,
        }))
    })
}

/// Changed files on disk with their line counts, and whether every file got counts. Counts only the first untracked
/// files that fit both budgets.
fn working_tree(
    repo: &Repo,
    head: Option<&str>,
    max_files: usize,
    max_bytes: u64,
) -> Result<(Vec<Entry>, Vec<Counts>, bool)> {
    // Pairing renames reads the old file, which a blobless clone may lack: then list the files without renames.
    let list = [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
    ];
    let entries = porcelain(&repo.out(&list[..4]).or_else(|_| repo.out(&list))?);
    let mut budget = max_bytes;
    let mut counted = Vec::new();
    for entry in entries.iter().filter(|entry| entry.code == "??") {
        if counted.len() == max_files {
            break;
        }
        match repo.size(&entry.path) {
            Some(size) if size <= UNTRACKED_FILE_BYTES && size <= budget => {
                budget -= size;
                counted.push(entry.path.clone());
            }
            _ => {}
        }
    }
    let tip = match head {
        Some(head) => head.to_owned(),
        None => repo.empty_tree()?,
    };
    // Tracked files with renames, as `git status` pairs them. Untracked files apart, so a deleted file and a new one
    // with its lines don't pair up; if Git can't mark them, they just go without line counts.
    let diff = |repo: &Repo, renames, paths: &[String]| {
        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            renames,
            "--numstat",
            "-z",
            &tip,
        ];
        if !paths.is_empty() {
            args.push("--");
            args.extend(paths.iter().map(String::as_str));
        }
        repo.out(&args)
    };
    let (tracked, untracked) = both_ways(
        || diff(repo, "-M", &[]).or_else(|_| diff(repo, "--no-renames", &[])),
        || {
            if counted.is_empty() {
                return Ok(Vec::new());
            }
            diff(&repo.with_untracked(&counted)?, "--no-renames", &counted)
        },
    );
    // Line counts read the old files too: without them, tracked files still show, with unknown counts.
    let tracked = match tracked {
        Err(failure) if not_downloaded(&failure.message) => None,
        tracked => Some(tracked?),
    };
    let tracked_counted = tracked.is_some();
    let mut counts = tracked.map_or_else(HashMap::new, |out| numstat(&out));
    counts.extend(numstat(&untracked.unwrap_or_default()));
    let mut complete = true;
    let files = entries
        .iter()
        .map(|entry| match counts.get(&entry.path) {
            Some(counts) => *counts,
            None if entry.code == "??" || !tracked_counted => {
                complete = false;
                (None, None)
            }
            None => (Some(0), Some(0)),
        })
        .collect();
    Ok((entries, files, complete))
}

/// How this branch compares with `branch`: commits only here (patches already there don't count) and their files.
fn merge_base_status(repo: &Repo, branch: &str, head: Option<&str>) -> Result<Value> {
    let Some(base) = repo.branch_tip(branch) else {
        return Ok(Value::Null);
    };
    let merge_base = head.and_then(|head| repo.line(&["merge-base", &base, head]));
    let mut section = json!({
        "mergeBaseBranch": branch,
        "baseRef": merge_base,
        "aheadCount": 0,
        "behindCount": 0,
        "hasCommittedUnmergedChanges": false,
        "commits": [],
        "insertions": 0,
        "deletions": 0,
        "lineStatsComplete": true,
        "files": [],
    });
    let Some(merge_base) = merge_base else {
        return Ok(section);
    };
    let both = format!("{base}...HEAD");
    let format = "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x00";
    // The three slow reads (patch IDs on both sides) run at once. Without --cherry-pick support, plain counts.
    let (counts, log, squashed) = thread::scope(|scope| {
        // Only diverged branches can have a squash on the other side.
        let squashed = (merge_base != base && head != Some(merge_base.as_str()))
            .then(|| scope.spawn(|| squashed(repo, &merge_base, &base)));
        let log = scope.spawn(|| {
            let picked = [
                "log",
                "--cherry-pick",
                "--right-only",
                "--reverse",
                "-n",
                COMMITS,
                format,
                &both,
            ];
            repo.out(&picked)
                .or_else(|_| repo.out(&[&picked[..1], &picked[2..]].concat()))
        });
        let counts = repo
            .line(&[
                "rev-list",
                "--cherry-pick",
                "--left-right",
                "--count",
                &both,
            ])
            .map(|counts| (true, counts));
        (counts, join(log), squashed.is_some_and(join))
    });
    let (pick, counts) = match counts {
        Some(counts) => counts,
        None => (
            false,
            text(&repo.out(&["rev-list", "--left-right", "--count", &both])?),
        ),
    };
    let mut numbers = counts
        .split_whitespace()
        .map(|number| number.parse::<u64>().unwrap_or(0));
    let (behind, ahead) = (numbers.next().unwrap_or(0), numbers.next().unwrap_or(0));
    section["behindCount"] = behind.into();
    if ahead == 0 || (pick && behind > 0 && squashed) {
        return Ok(section);
    }
    let commits: Vec<Value> = lossy(&log?)
        .split('\0')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut fields = line.split('\x1f');
            let mut field = || fields.next().unwrap_or_default();
            let (sha, short, subject, author) = (field(), field(), field(), field());
            json!({
                "sha": sha,
                "shortSha": short,
                "subject": subject,
                "authorName": author,
                "authoredAt": field().parse::<u64>().unwrap_or(0) * 1000,
            })
        })
        .collect();
    if commits.is_empty() {
        return Ok(section);
    }
    let diff = |output: &str, renames: &str| {
        let args = [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            renames,
            output,
            "-z",
            &merge_base,
            "HEAD",
        ];
        repo.out(&args)
    };
    // Finding renames reads file contents, which a blobless clone lacks: then list the files without renames.
    // Line counts need the contents too, so they stay unknown.
    let (changes, counts) = both_ways(
        || diff("--name-status", "-M").or_else(|_| diff("--name-status", "--no-renames")),
        || diff("--numstat", "-M"),
    );
    let changes = name_status(&changes?);
    let counts = counts.ok().map(|out| numstat(&out));
    let files: Vec<(Change, Counts)> = changes
        .into_iter()
        .map(|change| {
            let counts = counts
                .as_ref()
                .and_then(|counts| counts.get(&change.path).copied());
            (change, counts.unwrap_or((None, None)))
        })
        .collect();
    let (added, removed) = totals(files.iter().map(|(_, counts)| counts));
    section["aheadCount"] = ahead.into();
    section["hasCommittedUnmergedChanges"] = true.into();
    section["commits"] = commits.into();
    section["insertions"] = added.into();
    section["deletions"] = removed.into();
    section["lineStatsComplete"] = counts.is_some().into();
    section["files"] = files
        .iter()
        .map(|(change, (added, removed))| {
            let status = match change.letter {
                'T' => "M",
                'A' => "A",
                'D' => "D",
                'R' => "R",
                'C' => "C",
                'U' => "U",
                'M' => "M",
                _ => "?",
            };
            json!({ "path": change.path, "status": status, "insertions": added, "deletions": removed })
        })
        .collect::<Vec<_>>()
        .into();
    Ok(section)
}

/// Whether the base branch already holds this branch's whole change as one commit: a squash merge.
fn squashed(repo: &Repo, merge_base: &str, base: &str) -> bool {
    let Some(ours) =
        repo.patch_ids(&["diff", "--no-ext-diff", "--no-textconv", merge_base, "HEAD"])
    else {
        return false;
    };
    let Some(ours) = ours.first() else {
        return true; // No net change.
    };
    let range = format!("{merge_base}..{base}");
    repo.patch_ids(&[
        "log",
        "-p",
        "--no-ext-diff",
        "--no-textconv",
        "-n",
        SQUASH_SCAN,
        "--format=commit %H",
        &range,
    ])
    .is_some_and(|theirs| theirs.contains(ours))
}

/// What changed in `range`, and the diff option it took: renames when Git can find them (a blobless clone may lack
/// the old files), else without.
fn changes(repo: &Repo, range: &Range) -> Result<(Vec<Change>, &'static str)> {
    let list = |renames| repo.out(&range.diff(&[renames, "--name-status", "-z"]));
    match list("-M") {
        Ok(out) => Ok((name_status(&out), "-M")),
        Err(_) => Ok((name_status(&list("--no-renames")?), "--no-renames")),
    }
}

/// Untracked files for a working-tree target, up to `limit`: this checkout with the readable ones marked, the
/// readable ones, the rest, and whether there were more.
fn untracked(repo: &Repo, limit: usize) -> Result<(Repo, HashSet<String>, Vec<String>, bool)> {
    let (paths, more) =
        repo.records(&["ls-files", "--others", "--exclude-standard", "-z"], limit)?;
    let (small, large) = repo.readable(paths);
    Ok((
        repo.with_untracked(&small)?,
        small.into_iter().collect(),
        large,
        more,
    ))
}

fn files(repo: &Repo, target: &Target, max_files: usize) -> Result<Value> {
    let range = repo.range(target)?;
    let (repo, small, large, more) = if target.working_tree() {
        untracked(repo, max_files.saturating_add(1))?
    } else {
        (repo.clone(), HashSet::new(), Vec::new(), false)
    };
    let (changes, counts) = both_ways(
        || changes(&repo, &range),
        || repo.out(&range.diff(&["-M", "--numstat", "-z"])),
    );
    // Without counts (as in a blobless clone), the list still shows.
    let (changes, counts) = (
        changes?.0,
        counts.map_or_else(|_| HashMap::new(), |out| numstat(&out)),
    );
    let mut files: Vec<Value> = changes
        .iter()
        .map(|change| {
            let (added, removed) = counts
                .get(&change.path)
                .copied()
                .unwrap_or((Some(0), Some(0)));
            let binary = added.is_none() && removed.is_none();
            let letter = if "AMDRCT".contains(change.letter) {
                change.letter
            } else {
                'M'
            };
            json!({
                "path": change.path,
                "previousPath": change.previous,
                "statusLetter": letter.to_string(),
                "additions": added.unwrap_or(0),
                "deletions": removed.unwrap_or(0),
                "binary": binary,
                "origin": if small.contains(&change.path) { "untracked" } else { "tracked" },
            })
        })
        .collect();
    files.extend(large.iter().map(|path| {
        json!({ "path": path, "previousPath": null, "statusLetter": "A", "additions": 0, "deletions": 0, "binary": true, "origin": "untracked" })
    }));
    let truncated = more || files.len() > max_files;
    files.truncate(max_files);
    let (added, removed) = files.iter().fold((0, 0), |(added, removed), file| {
        (
            added + file["additions"].as_u64().unwrap_or(0),
            removed + file["deletions"].as_u64().unwrap_or(0),
        )
    });
    Ok(json!({
        "files": files,
        "shortstat": shortstat(files.len(), added, removed),
        "mergeBaseRef": range.merge_base,
        "truncated": truncated,
    }))
}

/// One patch per path, each at most `max_bytes`, within a budget for the whole reply. A renamed file's patch shows
/// the rename.
fn patch(repo: &Repo, target: &Target, paths: &[String], max_bytes: usize) -> Result<Value> {
    let range = repo.range(target)?;
    let mut seen = HashSet::new();
    let paths: Vec<&str> = paths
        .iter()
        .map(String::as_str)
        .filter(|path| seen.insert(*path))
        .collect();
    if paths.is_empty() {
        return Ok(json!([]));
    }
    let (repo, skipped) = if target.working_tree() {
        let mut args = vec!["ls-files", "--others", "--exclude-standard", "-z", "--"];
        args.extend(&paths);
        let (small, large) = repo.readable(nul_list(&repo.out(&args)?));
        (repo.with_untracked(&small)?, large)
    } else {
        (repo.clone(), Vec::new())
    };
    let (changes, renames) = changes(&repo, &range)?;
    let renamed: HashMap<String, String> = changes
        .into_iter()
        .filter_map(|change| Some((change.path, change.previous?)))
        .collect();
    let runs = in_parallel(&paths, |path| {
        let mut args = range.diff(&[renames]);
        args.extend(["--", path]);
        args.extend(renamed.get(*path).map(String::as_str));
        repo.exec(&args, b"", max_bytes)
    });
    let mut left = PATCH_REPLY_BYTES;
    let mut patches = Vec::new();
    for (path, run) in paths.iter().zip(runs) {
        let mut run = run?;
        if !run.ok {
            let detail = text(&run.stderr);
            if !not_downloaded(&detail) {
                return fail(FAILED, detail);
            }
            // The other files' diffs still show.
            patches.push(
                json!({ "path": path, "patch": "", "truncated": false, "error": NOT_DOWNLOADED }),
            );
            continue;
        }
        if run.stdout.len() > left {
            run.stdout.truncate(left);
            run.cut = true;
        }
        left -= run.stdout.len();
        // An untracked file too big to read has no patch, which is not the whole of it.
        let cut = run.cut || skipped.iter().any(|skipped| skipped == path);
        patches.push(json!({ "path": path, "patch": utf8(run.stdout, run.cut), "truncated": cut }));
    }
    Ok(Value::Array(patches))
}

/// The whole diff as text, as the commit message writer reads it.
fn diff(
    repo: &Repo,
    target: &Target,
    max_bytes: usize,
    max_list: usize,
    max_untracked: usize,
) -> Result<Value> {
    let range = repo.range(target)?;
    let (repo, large, more) = if target.working_tree() {
        let (marked, _, large, more) = untracked(repo, max_untracked)?;
        (marked, large, more)
    } else {
        (repo.clone(), Vec::new(), false)
    };
    let (patch, (list, counts)) = both_ways(
        || repo.exec(&range.diff(&["-M"]), b"", max_bytes),
        || {
            both_ways(
                || repo.exec(&range.diff(&["-M", "--name-status"]), b"", max_list),
                || repo.out(&range.diff(&["-M", "--numstat", "-z"])),
            )
        },
    );
    let (patch, list, counts) = (patch?, list?, numstat(&counts?));
    if !patch.ok || !list.ok {
        return fail(
            FAILED,
            text(if patch.ok {
                &list.stderr
            } else {
                &patch.stderr
            }),
        );
    }
    let (added, removed) = totals(counts.values());
    let mut files = utf8(list.stdout, list.cut);
    for path in &large {
        if list.cut || path.len() + 3 > max_list.saturating_sub(files.len()) {
            break;
        }
        files += &format!("A\t{path}\n");
    }
    Ok(json!({
        "diff": utf8(patch.stdout, patch.cut),
        "truncated": more || patch.cut || list.cut || !large.is_empty(),
        "shortstat": shortstat(counts.len() + large.len(), added, removed),
        "files": files,
        "mergeBaseRef": range.merge_base,
    }))
}

/// One side of a file in a diff: from disk for the working tree, else from Git.
fn show(
    repo: &Repo,
    target: &Target,
    side: &str,
    path: &str,
    merge_base: Option<&str>,
) -> Result<Vec<u8>> {
    let path = path.trim_start_matches('/');
    if path.split('/').any(|part| part.is_empty() || part == "..")
        || (cfg!(windows) && path.contains('\\'))
    {
        return fail(USAGE_ERROR, "Invalid path.");
    }
    if merge_base.is_some_and(|base| base.starts_with('-')) {
        return fail(USAGE_ERROR, "Invalid merge base.");
    }
    let new = match side {
        "new" => true,
        "old" => false,
        _ => return fail(USAGE_ERROR, "The side is old or new."),
    };
    let not_found = || fail(FILE_NOT_FOUND, "File not found.");
    let too_large = || fail(TOO_LARGE, "File is too large to show.");
    if new && target.working_tree() {
        let file = repo.top.join(path);
        let Some(metadata) = fs::symlink_metadata(&file)
            .ok()
            .filter(fs::Metadata::is_file)
        else {
            return not_found();
        };
        let inside = fs::canonicalize(&file)
            .ok()
            .zip(fs::canonicalize(&repo.top).ok())
            .is_some_and(|(file, top)| file.starts_with(top));
        if !inside {
            return not_found();
        }
        if metadata.len() > SHOW_BYTES {
            return too_large();
        }
        return match fs::read(file) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => not_found(),
            read => Ok(read?),
        };
    }
    let revision = match target {
        Target::Commit(_) => {
            let range = repo.range(target)?;
            if new {
                range.new.unwrap_or(range.old)
            } else {
                range.old
            }
        }
        Target::Uncommitted => repo.head_or_empty()?,
        _ if new => repo.head_or_empty()?,
        _ => match merge_base {
            Some(merge_base) => merge_base.to_owned(),
            None => {
                return fail(
                    USAGE_ERROR,
                    "The old side of a branch diff needs --merge-base.",
                );
            }
        },
    };
    let object = format!("{revision}:{path}");
    if repo.line(&["cat-file", "-t", &object]).as_deref() != Some("blob") {
        return not_found();
    }
    let size: u64 = repo
        .line(&["cat-file", "-s", &object])
        .and_then(|size| size.parse().ok())
        .unwrap_or(0);
    if size > SHOW_BYTES {
        return too_large();
    }
    repo.out(&["cat-file", "blob", &object])
}

/// Local and remote branches for the base-branch picker, the default one first.
fn branches(
    repo: &Repo,
    query: Option<&str>,
    limit: usize,
    selected: Option<&str>,
) -> Result<Value> {
    let default = repo.default_branch().unwrap_or_default();
    let refs = lossy(&repo.out(&[
        "for-each-ref",
        "--format=%(refname)%09%(symref)",
        "refs/heads",
        "refs/remotes",
    ])?);
    let (mut local, mut remote) = (Vec::new(), Vec::new());
    for line in refs.lines() {
        let (name, symref) = line.split_once('\t').unwrap_or((line, ""));
        if !symref.is_empty() {
            continue;
        }
        if let Some(branch) = name.strip_prefix("refs/heads/") {
            local.push(branch);
        } else if let Some(branch) = name.strip_prefix("refs/remotes/") {
            remote.push(branch);
        }
    }
    let query = query.unwrap_or_default().to_lowercase();
    let pick = |names: &[&str], pinned: &str| -> (Vec<String>, bool) {
        let mut ordered: Vec<&str> = names
            .iter()
            .copied()
            .filter(|name| *name == pinned)
            .collect();
        ordered.extend(names.iter().copied().filter(|name| *name != pinned));
        let matches: Vec<String> = ordered
            .into_iter()
            .filter(|name| name.to_lowercase().contains(&query))
            .map(str::to_owned)
            .collect();
        let more = matches.len() > limit;
        (matches.into_iter().take(limit).collect(), more)
    };
    let (branches, branches_more) = pick(&local, &default);
    let (remotes, remotes_more) = pick(&remote, &format!("origin/{default}"));
    let selected = selected.map(|name| {
        let kind = if local.contains(&name) {
            "local"
        } else if remote.contains(&name) {
            "remote"
        } else {
            "missing"
        };
        json!({ "name": name, "kind": kind })
    });
    Ok(json!({
        "branches": branches,
        "branchesTruncated": branches_more,
        "remoteBranches": remotes,
        "remoteBranchesTruncated": remotes_more,
        "selectedBranch": selected,
    }))
}

/// Commits every change, with the user's own Git settings and hooks (unless `no_verify`).
fn commit(repo: &Repo, message: &str, no_verify: bool) -> Result<Value> {
    if message.trim().is_empty() {
        return fail(USAGE_ERROR, "A commit message is required.");
    }
    let git = |args: &[&str]| -> Result<std::process::Output> {
        git_command()
            .args(args)
            .current_dir(&repo.top)
            .stdin(Stdio::null())
            .output()
            .map_err(|error| not_started(error, &repo.top))
    };
    let checked = |args: &[&str]| -> Result<String> {
        let output = git(args)?;
        if !output.status.success() {
            let detail = text(&output.stderr);
            return fail(
                FAILED,
                if detail.is_empty() {
                    text(&output.stdout)
                } else {
                    detail
                },
            );
        }
        Ok(text(&output.stdout))
    };
    checked(&["add", "-A"])?;
    if git(&["diff", "--cached", "--quiet"])?.status.success() {
        return fail(NOTHING_TO_COMMIT, "No changes to commit");
    }
    let mut args = vec!["commit", "-m", message];
    if no_verify {
        args.push("--no-verify");
    }
    checked(&args)?;
    Ok(json!({
        "commitSha": checked(&["rev-parse", "HEAD"])?,
        "commitSubject": checked(&["log", "-1", "--pretty=%s"])?,
    }))
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn text(bytes: &[u8]) -> String {
    lossy(bytes).trim().to_owned()
}

/// Text that may have been cut mid-character.
fn utf8(mut bytes: Vec<u8>, cut: bool) -> String {
    if cut
        && let Err(error) = std::str::from_utf8(&bytes)
        && error.error_len().is_none()
    {
        bytes.truncate(error.valid_up_to());
    }
    lossy(&bytes)
}

fn nul_list(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|item| !item.is_empty())
        .map(lossy)
        .collect()
}

fn nul_join(items: &[String]) -> Vec<u8> {
    items
        .iter()
        .flat_map(|item| item.bytes().chain([0]))
        .collect()
}

fn join<T>(handle: thread::ScopedJoinHandle<'_, T>) -> T {
    handle
        .join()
        .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

/// Runs two reads at once.
fn both_ways<A: Send, B: Send>(
    first: impl FnOnce() -> A + Send,
    second: impl FnOnce() -> B + Send,
) -> (A, B) {
    thread::scope(|scope| {
        let second = scope.spawn(second);
        (first(), join(second))
    })
}

/// `run` for each item, at most 8 at once; results in order.
fn in_parallel<T: Sync, R: Send>(items: &[T], run: impl Fn(&T) -> R + Sync) -> Vec<R> {
    items
        .chunks(8)
        .flat_map(|chunk| {
            thread::scope(|scope| {
                let handles: Vec<_> = chunk.iter().map(|item| scope.spawn(|| run(item))).collect();
                handles.into_iter().map(join).collect::<Vec<_>>()
            })
        })
        .collect()
}
