//! Linux workload containment. The installer delegates only this service's cgroup. Containers without
//! cgroups (a policy without `cgroup_root`) mark each workload's processes with an inherited variable instead.
use crate::workspace::storage::Policy;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::{process::Command, sync::watch};

/// Agent helpers live beside Core's sockets: readable by the agent, writable only by Core's account.
const AGENT_DIR: &str = "/run/cloudroom/agent";
/// Sourced by every non-interactive bash a harness starts (BASH_ENV; Claude Code's command shells skip it and source
/// CLAUDE_ENV_FILE instead), so each command an agent runs, and all it starts, is what the kernel kills first when
/// memory runs out, never the agent or Core. A harness launched through a bash wrapper (its parent is Core) keeps 0.
/// It runs after login startup files, so a Mac environment they set (#1034, #1033) can't hide tools or logins: the
/// system tool folders go back on PATH, last, so the user's own folders still win. HOME, XDG_CONFIG_HOME and
/// GH_CONFIG_DIR change only when they name a missing Mac folder. Plain sh, since CLAUDE_ENV_FILE may meet zsh.
const BASH_ENV: &str = r#"{ read -r _cloudroom_parent < /proc/$PPID/comm; } 2>/dev/null
[ "$_cloudroom_parent" = cloudroom ] || { echo 500 > /proc/$$/oom_score_adj; } 2>/dev/null
for _cloudroom_dir in /usr/local/bin /usr/bin /bin; do
  case ":${PATH-}:" in *":$_cloudroom_dir:"*) ;; *) PATH="${PATH:+$PATH:}$_cloudroom_dir" ;; esac
done
case "${HOME-}" in /Users/*|/Volumes/*)
  if [ ! -e "$HOME" ] && _cloudroom_dir=$(getent passwd "$(id -u)" | cut -d: -f6) && [ -d "$_cloudroom_dir" ]; then HOME=$_cloudroom_dir; fi ;;
esac
case "${XDG_CONFIG_HOME-}" in /Users/*|/Volumes/*) [ -e "$XDG_CONFIG_HOME" ] || unset XDG_CONFIG_HOME ;; esac
case "${GH_CONFIG_DIR-}" in /Users/*|/Volumes/*) [ -e "$GH_CONFIG_DIR" ] || unset GH_CONFIG_DIR ;; esac
unset _cloudroom_parent _cloudroom_dir
"#;
/// A container's `os.cpus()` lists every host CPU, and tools such as Next.js start a worker per CPU.
const NODE_CPUS: &str = r#"const os = require('node:os'), cpus = os.cpus, usable = os.availableParallelism?.();
if (usable) { os.cpus = () => cpus().slice(0, usable); require('node:module').syncBuiltinESMExports(); }
"#;
/// Python 3.13 reads PYTHON_CPU_COUNT itself; older versions count every host CPU for worker pools. Then it runs the
/// `sitecustomize` this one hides (the user's or the system's), since Python loads only the first it finds.
const PYTHON_CPUS: &str = r#"import importlib.machinery, importlib.util, os, sys
if sys.version_info < (3, 13) and os.environ.get('PYTHON_CPU_COUNT', '').isdigit():
    _count = int(os.environ['PYTHON_CPU_COUNT'])
    os.cpu_count = lambda: _count
_here = os.path.dirname(os.path.abspath(__file__))
_next = importlib.machinery.PathFinder.find_spec('sitecustomize', [p for p in sys.path if os.path.abspath(p or '.') != _here])
if _next and _next.loader:
    _next.loader.exec_module(importlib.util.module_from_spec(_next))
"#;

/// Settings for every harness so one agent fits a container with no swap: commands die before the agent, and tools
/// see the CPUs the container may use instead of the host's. Written once per Core start; nothing outside Linux.
pub(crate) fn agent_env() -> &'static [(&'static str, String)] {
    static ENV: std::sync::OnceLock<Vec<(&'static str, String)>> = std::sync::OnceLock::new();
    ENV.get_or_init(|| {
        let dir = Path::new(AGENT_DIR);
        let helpers = write_helpers(dir).is_ok();
        let mut env = Vec::new();
        if helpers {
            let hook = dir.join("bash-env.sh").display().to_string();
            env.extend([("BASH_ENV", hook.clone()), ("CLAUDE_ENV_FILE", hook)]);
        }
        if let Some(cpus) = cpu_quota() {
            env.push(("OMP_NUM_THREADS", cpus.to_string())); // nproc, make -j$(nproc), OpenMP and BLAS
            env.push(("PYTHON_CPU_COUNT", cpus.to_string()));
            if helpers {
                let node = dir.join("cpus.cjs");
                env.push(("NODE_OPTIONS", format!("--require {}", node.display())));
                env.push(("PYTHONPATH", dir.display().to_string()));
            }
        }
        env
    })
}

fn write_helpers(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o755))?;
    for (name, text) in [
        ("bash-env.sh", BASH_ENV),
        ("cpus.cjs", NODE_CPUS),
        ("sitecustomize.py", PYTHON_CPUS),
    ] {
        // Replaced whole, so an agent already running never reads half a file.
        let temporary = dir.join(format!(".{name}"));
        fs::write(&temporary, text)?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o644))?;
        fs::rename(temporary, dir.join(name))?;
    }
    Ok(())
}

/// The container's CPU quota, rounded up. None without one, where the CPU count tools see is already right.
fn cpu_quota() -> Option<u64> {
    let max = fs::read_to_string("/sys/fs/cgroup/cpu.max").ok()?;
    let mut parts = max.split_whitespace();
    let quota: u64 = parts.next()?.parse().ok()?;
    let period: u64 = parts.next()?.parse().ok()?;
    (period > 0).then(|| quota.div_ceil(period).max(1))
}

static NEXT: AtomicU64 = AtomicU64::new(0);
const MARKER: &[u8] = b"CLOUDROOM_WORKLOAD=";
/// Set on the virtual screen and everything computer use starts on it (see `desktop`).
pub(crate) const DESKTOP_MARKER: &str = "CLOUDROOM_DESKTOP";
const SIGKILL: i32 = 9;
const SIGCONT: i32 = 18;
const SIGSTOP: i32 = 19;

enum Group {
    /// A delegated cgroup: freeze and kill are atomic, and no descendant escapes.
    Cgroup(PathBuf),
    /// Every process carrying `CLOUDROOM_WORKLOAD=<id>`. Core shares the agent's account here, so it may signal
    /// them. Processes that clear their environment or switch user (sudo) escape; the sandbox is the boundary.
    Marked(String),
}

pub struct Workload {
    group: Group,
    paused: watch::Sender<bool>,
}

/// A process group's disk writes, and the command line of its heaviest member.
pub struct Writer {
    pub bytes: u64,
    pids: Vec<i32>,
    pub command: String,
}
impl Writer {
    pub fn kill(&self) {
        self.pids.iter().for_each(|pid| signal(*pid, SIGKILL));
    }
}

impl Workload {
    pub fn create(policy: &Policy) -> io::Result<Self> {
        let id = format!(
            "agent-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let group = match &policy.cgroup_root {
            Some(root) => {
                let directory = root.join(id);
                fs::create_dir(&directory)?;
                Group::Cgroup(directory)
            }
            None => Group::Marked(id),
        };
        let (paused, _) = watch::channel(false);
        Ok(Self { group, paused })
    }
    pub fn attach(&self, command: &mut Command, policy: &Policy) -> io::Result<()> {
        let (uid, gid) = (policy.agent_uid, policy.agent_gid);
        let directory = match &self.group {
            Group::Cgroup(directory) => Some(directory.as_path()),
            Group::Marked(id) => {
                command.env("CLOUDROOM_WORKLOAD", id);
                None
            }
        };
        as_agent(command, uid, gid, directory, !policy.agent_sudo)
    }
    pub fn paused(&self) -> watch::Receiver<bool> {
        self.paused.subscribe()
    }
    pub async fn freeze(&self, frozen: bool) -> io::Result<()> {
        // Never thaw a group this owner did not request to freeze.
        if !frozen && !*self.paused.borrow() {
            return Ok(());
        }
        if let Group::Cgroup(directory) = &self.group {
            fs::write(
                directory.join("cgroup.freeze"),
                if frozen { "1" } else { "0" },
            )?;
        }
        if frozen {
            self.paused.send_replace(true);
        }
        tokio::time::timeout(Duration::from_secs(2), async {
            while !self.settled(frozen)? {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok::<_, io::Error>(())
        })
        .await
        .map_err(|_| io::Error::other("workload freeze state unconfirmed"))??;
        if !frozen {
            self.paused.send_replace(false);
        }
        Ok(())
    }
    /// Whether every process reached the requested state. Marked groups are signalled again on each check,
    /// so processes forked during a freeze are stopped too.
    fn settled(&self, frozen: bool) -> io::Result<bool> {
        match &self.group {
            Group::Cgroup(directory) => Ok(fs::read_to_string(directory.join("cgroup.events"))?
                .lines()
                .any(|l| l == if frozen { "frozen 1" } else { "frozen 0" })),
            Group::Marked(id) => {
                let pending: Vec<_> = members(Some(id))?
                    .into_iter()
                    .filter(|m| m.stopped != frozen)
                    .collect();
                for m in &pending {
                    signal(m.pid, if frozen { SIGSTOP } else { SIGCONT });
                }
                Ok(pending.is_empty())
            }
        }
    }
    fn pids(&self) -> io::Result<Vec<i32>> {
        Ok(match &self.group {
            Group::Cgroup(directory) => fs::read_to_string(directory.join("cgroup.procs"))?
                .lines()
                .filter_map(|line| line.parse().ok())
                .collect(),
            Group::Marked(id) => members(Some(id))?.into_iter().map(|m| m.pid).collect(),
        })
    }
    /// Idle sleep treats processes beyond the launch count as background jobs. Codex starts its code-mode
    /// host on the first command and keeps it for the session, so it is harness, not a background job. The
    /// virtual screen and its browser are neither: an open page alone never keeps the sandbox awake (ADR 0272).
    pub fn process_count(&self) -> Option<usize> {
        Some(
            self.pids()
                .ok()?
                .iter()
                .filter(|pid| !helper(**pid) && !desktop(**pid))
                .count(),
        )
    }
    /// The process group, other than the harness's own, that wrote the most to disk: a tool command, never the
    /// harness or its helpers. The youngest group wins ties. None when nothing but the harness remains.
    pub fn top_writer(&self, harness: u32) -> io::Result<Option<Writer>> {
        let pids = self.pids()?;
        let own_group = stat(harness as i32).map(|(_, group, _)| group);
        let mut groups: std::collections::HashMap<i32, Vec<(i32, u64, u64)>> = Default::default();
        for pid in pids {
            if let Some((_, group, started)) = stat(pid)
                && pid != harness as i32
                && Some(group) != own_group
                && !helper(pid)
            {
                groups
                    .entry(group)
                    .or_default()
                    .push((pid, written(pid), started));
            }
        }
        let Some(members) = groups.into_values().max_by_key(|m| {
            (
                m.iter().map(|p| p.1).sum::<u64>(),
                m.iter().map(|p| p.2).max(),
            )
        }) else {
            return Ok(None);
        };
        let heaviest = members.iter().max_by_key(|p| (p.1, p.2)).map(|p| p.0);
        let command = heaviest
            .and_then(|pid| fs::read(format!("/proc/{pid}/cmdline")).ok())
            .map(|raw| {
                String::from_utf8_lossy(&raw)
                    .replace('\0', " ")
                    .trim()
                    .to_owned()
            })
            .unwrap_or_default();
        Ok(Some(Writer {
            bytes: members.iter().map(|p| p.1).sum(),
            pids: members.iter().map(|p| p.0).collect(),
            command,
        }))
    }
    pub fn terminate(&self) -> io::Result<()> {
        match &self.group {
            // The directory is created exclusively by this Runtime, never supplied by a client.
            Group::Cgroup(directory) => fs::write(directory.join("cgroup.kill"), "1"),
            Group::Marked(id) => {
                members(Some(id))?
                    .iter()
                    .for_each(|m| signal(m.pid, SIGKILL));
                Ok(())
            }
        }
    }
    pub async fn stop(&self) -> io::Result<()> {
        match &self.group {
            Group::Cgroup(directory) => clear_cgroup(directory).await,
            Group::Marked(id) => clear_marked(Some(id)).await,
        }
    }
    /// At startup: ends every workload an earlier run of this service left behind.
    pub async fn clear(policy: &Policy) -> io::Result<()> {
        match &policy.cgroup_root {
            Some(root) => clear_cgroup(root).await,
            None => clear_marked(None).await,
        }
    }
}
impl Drop for Workload {
    fn drop(&mut self) {
        let _ = self.terminate();
        if let Group::Cgroup(directory) = &self.group {
            let _ = fs::remove_dir(directory); // Busy kernel groups are left intact, never recursively deleted.
        }
    }
}

/// Only Runtime-created groups, or the validated service root at startup.
async fn clear_cgroup(directory: &Path) -> io::Result<()> {
    fs::write(directory.join("cgroup.kill"), "1")?;
    tokio::time::timeout(super::SHUTDOWN_GRACE, async {
        loop {
            let events = fs::read_to_string(directory.join("cgroup.events"))?;
            if events.lines().any(|line| line == "populated 0") {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| io::Error::other("workload exit unconfirmed; refusing replacement"))?
}

/// Kills one marked workload, or every one (`None`), until none of its processes remain.
async fn clear_marked(id: Option<&str>) -> io::Result<()> {
    tokio::time::timeout(super::SHUTDOWN_GRACE, async {
        loop {
            let found = members(id)?;
            if found.is_empty() {
                return Ok(());
            }
            found.iter().for_each(|m| signal(m.pid, SIGKILL));
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| io::Error::other("workload exit unconfirmed; refusing replacement"))?
}

struct Member {
    pid: i32,
    stopped: bool,
}
/// Live processes carrying this workload's marker, or any marker. Other users' processes are unreadable and skipped.
fn members(id: Option<&str>) -> io::Result<Vec<Member>> {
    let own = std::process::id();
    let mut found = Vec::new();
    for entry in fs::read_dir("/proc")?.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(environ) = fs::read(entry.path().join("environ")) else {
            continue;
        };
        let marked = environ.split(|b| *b == 0).any(|var| {
            var.strip_prefix(MARKER)
                .is_some_and(|value| id.is_none_or(|id| value == id.as_bytes()))
        });
        // Exited processes (zombies) have no environment left and hold nothing.
        let state = fs::read_to_string(entry.path().join("stat"))
            .ok()
            .and_then(|stat| stat.rsplit_once(") ")?.1.chars().next());
        if marked
            && pid != own
            && let Some(state) = state.filter(|s| !matches!(s, 'Z' | 'X'))
        {
            found.push(Member {
                pid: pid as i32,
                stopped: matches!(state, 'T' | 't'),
            });
        }
    }
    Ok(found)
}
/// Codex's code-mode host runs in its own group but holds session state, so it counts as harness.
fn helper(pid: i32) -> bool {
    program(pid, b"codex-code-mode-host")
}
fn program(pid: i32, name: &[u8]) -> bool {
    fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|cmdline| {
        let program = cmdline.split(|b| *b == 0).next().unwrap_or_default();
        program.rsplit(|b| *b == b'/').next() == Some(name)
    })
}
/// Computer use marks the virtual screen, its helpers and the apps it launches with `CLOUDROOM_DESKTOP=1`; the
/// shared browser is matched by `browser`, and Chromium's crash reporter is never real work. For idle sleep and burn:
/// the disk guard still sees them. An unreadable environment counts as a background job, as before.
fn desktop(pid: i32) -> bool {
    let marked = fs::read(format!("/proc/{pid}/environ")).is_ok_and(|environ| {
        environ
            .split(|b| *b == 0)
            .any(|var| var.strip_prefix(DESKTOP_MARKER.as_bytes()) == Some(b"=1".as_slice()))
    });
    marked || browser(pid) || program(pid, b"chrome_crashpad_handler")
}
/// The shared browser: browser-harness's daemons (`python -m browser_harness.daemon`) and every process of the
/// Chromium its wrapper starts with `--user-data-dir=$HOME/.config/chromium-agent` (web/browser.sh). Chromium wipes
/// its environment and rewrites its command line as one space-joined title, so only a substring can tell (#610).
/// Only those programs match: another process carrying the same words is never paused.
fn browser(pid: i32) -> bool {
    fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|cmdline| {
        let mut words = cmdline.split(|b| *b == 0 || *b == b' ');
        let program = words.next().unwrap_or_default();
        match program.rsplit(|b| *b == b'/').next().unwrap_or_default() {
            b"chromium" => words.any(|word| {
                word.starts_with(b"--user-data-dir=") && word.ends_with(b"/.config/chromium-agent")
            }),
            name => {
                name.starts_with(b"python")
                    && words
                        .take(2)
                        .eq([b"-m".as_slice(), b"browser_harness.daemon".as_slice()])
            }
        }
    })
}
/// Pauses (SIGSTOP) or resumes (SIGCONT) the shared browser, so an open page burns no Cloud Credits while nothing
/// uses it (#610). Tabs, logins and page state stay; its daemons pause too, so their connection to Chromium survives.
/// Resuming is harmless when nothing is paused. Only the idle sleeper pauses (session `Browser`).
/// Only the agent account's browser: `owner` is its uid, or Core's own when agents share it. Another account's
/// browser on the same server is never touched, even though Core may signal it (`CAP_KILL`).
pub(crate) fn pause_browser(paused: bool, owner: Option<u32>) {
    let owner = owner.unwrap_or_else(|| {
        unsafe extern "C" {
            fn geteuid() -> u32;
        }
        unsafe { geteuid() }
    });
    let Ok(entries) = fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        if let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse().ok())
            && pid != std::process::id() as i32
            && uid(pid) == Some(owner)
            && browser(pid)
        {
            signal(pid, if paused { SIGSTOP } else { SIGCONT });
        }
    }
}
/// Where a process comes from, for idle burn (docs/scopes/credit-burn.md). Only the agent account's processes are
/// jobs or strays.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Origin {
    /// Core, and what runs in the process group of one of its direct children: harnesses and their helpers, sync,
    /// terminal shells.
    Core(i32),
    /// A command a harness or terminal started in a group of its own, or anything in a live workload: builds, tests,
    /// downloads, servers. Never stopped.
    Job,
    /// Nothing tracks it: orphaned, outside every workload, and started after Core, as are all its descendants.
    Stray,
    /// Other accounts, the virtual screen and shared browser, Codex's host, and anything uncertain.
    Other,
}

/// Sorts processes by origin, each once. Make a new one for each reading: pids are reused.
pub(crate) struct Origins {
    agent: u32,
    core: u32,
    started: u64,
    /// Core's own cgroup, which holds every workload. None where workloads are marked instead.
    cgroup: Option<PathBuf>,
    known: std::collections::HashMap<u32, Origin>,
}

impl Origins {
    pub fn new(policy: &Policy) -> Self {
        let core = std::process::id();
        Self {
            agent: policy.agent_uid,
            core,
            started: stat(core as i32).map_or(u64::MAX, |(_, _, start)| start),
            // Unreadable means everything is in it, so nothing is a stray.
            cgroup: (policy.cgroup_root.is_some())
                .then(|| cgroup(core).unwrap_or_else(|| PathBuf::from("/"))),
            known: Default::default(),
        }
    }

    /// The origin of the process that started at `start` (ticks after boot); `Other` once that process is gone.
    pub fn of(&mut self, pid: u32, start: u64) -> Origin {
        match stat(pid as i32) {
            Some((_, _, now)) if now == start => self.find(pid),
            _ => Origin::Other,
        }
    }

    fn find(&mut self, pid: u32) -> Origin {
        if let Some(origin) = self.known.get(&pid) {
            return *origin;
        }
        // A pid reused mid-walk can't loop.
        self.known.insert(pid, Origin::Other);
        let origin = self.sort(pid).unwrap_or(Origin::Other);
        self.known.insert(pid, origin);
        origin
    }

    fn sort(&mut self, pid: u32) -> Option<Origin> {
        let (parent, group, start) = stat(pid as i32)?;
        if pid == self.core {
            return Some(Origin::Core(group));
        }
        let id = pid as i32;
        if pid <= 1 || uid(id)? != self.agent || desktop(id) || helper(id) {
            return Some(Origin::Other);
        }
        if parent == self.core {
            return Some(Origin::Core(group));
        }
        Some(match (self.find(parent), self.workload(pid)) {
            (Origin::Core(own), _) if own == group => Origin::Core(own),
            (Origin::Core(_) | Origin::Job, _) | (_, Some(true)) => Origin::Job,
            // Chromium's helpers overwrite their environment, so they follow their parent.
            (Origin::Stray, _) => Origin::Stray,
            (_, Some(false)) if parent == 1 && start > self.started => Origin::Stray,
            _ => Origin::Other,
        })
    }

    /// Whether a process runs in Core's cgroup or carries a workload marker. None when unreadable.
    fn workload(&self, pid: u32) -> Option<bool> {
        match &self.cgroup {
            Some(own) => Some(cgroup(pid)?.starts_with(own)),
            None => {
                let environ = fs::read(format!("/proc/{pid}/environ")).ok()?;
                Some(
                    environ
                        .split(|b| *b == 0)
                        .any(|var| var.starts_with(MARKER)),
                )
            }
        }
    }
}

/// A process's cgroup v2 path, from `/proc/PID/cgroup`.
fn cgroup(pid: u32) -> Option<PathBuf> {
    let groups = fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    groups
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(PathBuf::from)
}

/// Stops strays: asks each to quit (SIGTERM), then kills what is left 5 s later (SIGKILL). Only the same processes:
/// a pid whose start time changed belongs to another one now.
pub(crate) async fn stop(strays: Vec<(u32, u64)>) {
    let signal = |number| {
        for (pid, start) in &strays {
            if stat(*pid as i32).is_some_and(|(_, _, now)| now == *start) {
                send(*pid as i32, number);
            }
        }
    };
    signal(15);
    tokio::time::sleep(Duration::from_secs(5)).await;
    signal(SIGKILL);
}

/// A process's real uid, from `/proc/PID/status`. Readable even when the process isn't dumpable, unlike the
/// owner of `/proc/PID`, which is then root.
fn uid(pid: i32) -> Option<u32> {
    let status = fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("Uid:")?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    })
}
/// A process's parent, group and start time, from `/proc/PID/stat`.
fn stat(pid: i32) -> Option<(u32, i32, u64)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<&str> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
    Some((
        fields.get(1)?.parse().ok()?,
        fields.get(2)?.parse().ok()?,
        fields.get(19)?.parse().ok()?,
    ))
}
/// Bytes a process sent to disk. Zero when unreadable: another account's counters need ptrace rights.
fn written(pid: i32) -> u64 {
    fs::read_to_string(format!("/proc/{pid}/io"))
        .ok()
        .and_then(|io| {
            io.lines()
                .find_map(|line| line.strip_prefix("write_bytes: ")?.parse().ok())
        })
        .unwrap_or(0)
}
fn signal(pid: i32, number: i32) {
    send(pid, number);
}
/// Asks a process to stop (SIGTERM). False when Core cannot signal it, such as another account's process.
pub(crate) fn terminate(pid: u32) -> bool {
    send(pid as i32, 15)
}
fn send(pid: i32, number: i32) -> bool {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    unsafe { kill(pid, number) == 0 }
}

#[cfg(target_os = "linux")]
pub(crate) fn as_agent(
    command: &mut Command,
    uid: u32,
    gid: u32,
    group: Option<&Path>,
    no_new_privs: bool,
) -> io::Result<()> {
    use std::{io::Write, os::unix::process::CommandExt};
    unsafe extern "C" {
        fn setgroups(size: usize, list: *const u32) -> i32;
        fn setgid(gid: u32) -> i32;
        fn setuid(uid: u32) -> i32;
        fn prctl(option: i32, ...) -> i32;
        fn capset(header: *const [u32; 2], data: *const [u32; 6]) -> i32;
        fn getuid() -> u32;
        fn getgid() -> u32;
    }
    if uid == 0 || gid == 0 {
        return Err(io::Error::other("agent identity must be unprivileged"));
    }
    // In a container without cgroups, Core already runs as the agent and has no right to change identity.
    let switch = unsafe { getuid() != uid || getgid() != gid };
    let mut membership = group
        .map(|g| {
            fs::OpenOptions::new()
                .write(true)
                .open(g.join("cgroup.procs"))
        })
        .transpose()?;
    // Only pre-opened fd writes and Linux syscalls after fork: no allocation or locks.
    // Attach before dropping identity; descendants inherit containment even after setsid().
    unsafe {
        command.as_std_mut().pre_exec(move || {
            if let Some(file) = membership.as_mut() {
                file.write_all(b"0")?;
            }
            if (no_new_privs && prctl(38, 1_u64, 0_u64, 0_u64, 0_u64) != 0) // PR_SET_NO_NEW_PRIVS
            || (switch && (setgroups(0, std::ptr::null()) != 0 || setgid(gid) != 0 || setuid(uid) != 0))
            || prctl(47, 4_u64, 0_u64, 0_u64, 0_u64) != 0 // clear ambient capabilities
            || capset(&[0x20080522, 0], &[0; 6]) != 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(())
}
#[cfg(not(target_os = "linux"))]
pub(crate) fn as_agent(
    _: &mut Command,
    _: u32,
    _: u32,
    _: Option<&Path>,
    _: bool,
) -> io::Result<()> {
    Err(io::Error::other("disk protection requires Linux"))
}

/// Pausing work must not turn an in-flight native RPC into a timeout/replayed task.
pub(super) async fn reply<T>(
    mut result: tokio::sync::oneshot::Receiver<T>,
    mut paused: watch::Receiver<bool>,
    timeout: Duration,
) -> io::Result<T> {
    let mut remaining = timeout;
    loop {
        if *paused.borrow() {
            tokio::select! {
                value = &mut result => return value.map_err(|_| io::Error::other("harness response lost; outcome uncertain")),
                changed = paused.changed() => if changed.is_err() { return Err(io::Error::other("workload owner lost")); },
            }
        } else {
            let start = tokio::time::Instant::now();
            tokio::select! {
                value = &mut result => return value.map_err(|_| io::Error::other("harness response lost; outcome uncertain")),
                _ = tokio::time::sleep(remaining) => return Err(io::Error::new(io::ErrorKind::TimedOut, "harness response timed out; outcome uncertain")),
                changed = paused.changed() => if changed.is_err() { return Err(io::Error::other("workload owner lost")); },
            }
            remaining = remaining.saturating_sub(start.elapsed());
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn login_startup_files_never_hide_the_system_tools_or_home() {
        let home = std::env::temp_dir().join(format!("bash-env-test-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("hook.sh"), BASH_ENV).unwrap();
        let account = std::process::Command::new("sh")
            .args(["-c", "getent passwd \"$(id -u)\" | cut -d: -f6"])
            .output()
            .unwrap();
        let account = String::from_utf8_lossy(&account.stdout).trim().to_owned();
        for (startup, expected) in [
            (
                "PATH=/opt/homebrew/bin:/usr/bin HOME=/Users/a GH_CONFIG_DIR=/Users/a/gh",
                format!("/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin|{account}|-"),
            ),
            (
                "PATH=/a/bin:/usr/local/bin:/usr/bin:/bin GH_CONFIG_DIR=/tmp/no-gh",
                format!(
                    "/a/bin:/usr/local/bin:/usr/bin:/bin|{}|/tmp/no-gh",
                    home.display()
                ),
            ),
            (
                "set -eu; unset HOME PATH",
                "/usr/local/bin:/usr/bin:/bin||-".into(),
            ),
        ] {
            fs::write(home.join(".bash_profile"), format!("{startup}\n")).unwrap();
            let output = std::process::Command::new("/bin/bash")
                .args(["-lc", "printf %s \"${PATH-}|${HOME-}|${GH_CONFIG_DIR--}\""])
                .env_clear()
                .env("HOME", &home)
                .env("BASH_ENV", home.join("hook.sh"))
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&output.stdout), expected);
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn idle_burn_never_calls_a_tracked_job_a_stray() {
        // Marked workloads, as in a container. Both orphans' shells exit; only the job keeps its marker.
        let uid = uid(std::process::id() as i32).unwrap();
        let policy: Policy = serde_json::from_value(serde_json::json!({"agent_uid": uid,
            "agent_gid": uid, "cache_dir": "/tmp", "cgroup_root": null, "agent_sudo": true}))
        .unwrap();
        std::thread::sleep(Duration::from_millis(20)); // Start times count 10 ms ticks.
        let orphan = |marked: bool| {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "sleep 30 > /dev/null 2>&1 & echo $!"]);
            command.env_clear().env("PATH", "/usr/bin:/bin");
            if marked {
                command.env("CLOUDROOM_WORKLOAD", "idle-test");
            }
            let output = command.output().unwrap();
            let pid: u32 = String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse()
                .unwrap();
            (pid, stat(pid as i32).unwrap())
        };
        let (job, (_, _, job_start)) = orphan(true);
        let (stray, (parent, _, stray_start)) = orphan(false);
        let mut harness = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let harness_start = stat(harness.id() as i32).unwrap().2;
        let mut origins = Origins::new(&policy);
        assert_eq!(origins.of(job, job_start), Origin::Job);
        assert!(matches!(
            origins.of(harness.id(), harness_start),
            Origin::Core(_)
        ));
        // A reaper other than init in between (some CI containers) leaves it uncertain.
        let expected = if parent == 1 {
            Origin::Stray
        } else {
            Origin::Other
        };
        assert_eq!(origins.of(stray, stray_start), expected);
        assert_eq!(origins.of(stray, stray_start + 1), Origin::Other);
        for pid in [job, stray] {
            send(pid as i32, SIGKILL);
        }
        let _ = harness.kill();
        let _ = harness.wait();
    }

    #[test]
    fn a_full_disk_stops_the_writing_tool_command_not_the_harness() {
        let id = format!("disk-test-{}", std::process::id());
        // A real disk: writes to a memory disk are not counted as disk writes.
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(&id);
        let spawn = |script: String, detach: bool| {
            use std::os::unix::process::CommandExt;
            let mut command = std::process::Command::new("sh");
            command.args(["-c", &script]).env("CLOUDROOM_WORKLOAD", &id);
            if detach {
                command.process_group(0);
            }
            command.spawn().unwrap()
        };
        let mut harness = spawn("sleep 30".into(), false);
        // The shell itself writes 64 MB, then stays alive. The idle group starts last, so only the
        // write counts can single out the writer.
        let mut writer = spawn(
            format!(
                "i=0; while [ $i -lt 1000 ]; do printf '%065536d' 0; i=$((i+1)); done > {}; sleep 30",
                file.display()
            ),
            true,
        );
        std::thread::sleep(Duration::from_secs(3));
        let mut idle = spawn("sleep 30".into(), true);
        std::thread::sleep(Duration::from_millis(200));
        let workload = Workload {
            group: Group::Marked(id),
            paused: watch::channel(false).0,
        };
        let top = workload.top_writer(harness.id()).unwrap().unwrap();
        assert!(top.command.starts_with("sh -c i=0"), "{}", top.command);
        assert!(top.bytes >= 64_000_000, "{}", top.bytes);
        top.kill();
        assert!(
            writer.wait().unwrap().code().is_none(),
            "the writer was killed"
        );
        assert!(harness.try_wait().unwrap().is_none() && idle.try_wait().unwrap().is_none());
        for mut child in [harness, idle] {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = fs::remove_file(file);
    }
}
