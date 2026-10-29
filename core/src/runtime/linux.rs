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
const BASH_ENV: &str = r#"{ read -r _cloudroom_parent < /proc/$PPID/comm; } 2>/dev/null
[ "$_cloudroom_parent" = cloudroom ] || { echo 500 > /proc/$$/oom_score_adj; } 2>/dev/null
unset _cloudroom_parent
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
    /// virtual screen and its browser are neither: an open page alone never keeps the sandbox awake.
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
        let own_group = stat(harness as i32).map(|(group, _)| group);
        let mut groups: std::collections::HashMap<i32, Vec<(i32, u64, u64)>> = Default::default();
        for pid in pids {
            if let Some((group, started)) = stat(pid)
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
    fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|cmdline| {
        let program = cmdline.split(|b| *b == 0).next().unwrap_or_default();
        program.rsplit(|b| *b == b'/').next() == Some(b"codex-code-mode-host".as_slice())
    })
}
/// Computer use marks the virtual screen, its helpers and the apps it launches (Chromium included) with
/// `CLOUDROOM_DESKTOP=1`; browser-harness runs its daemon as `python -m browser_harness.daemon`. For idle sleep
/// only: the disk guard still sees them. An unreadable environment counts as a background job, as before.
fn desktop(pid: i32) -> bool {
    let marked = fs::read(format!("/proc/{pid}/environ")).is_ok_and(|environ| {
        environ
            .split(|b| *b == 0)
            .any(|var| var.strip_prefix(DESKTOP_MARKER.as_bytes()) == Some(b"=1".as_slice()))
    });
    marked
        || fs::read(format!("/proc/{pid}/cmdline")).is_ok_and(|cmdline| {
            let args: Vec<&[u8]> = cmdline.split(|b| *b == 0).skip(1).take(2).collect();
            args == [b"-m".as_slice(), b"browser_harness.daemon".as_slice()]
        })
}
/// A process's group and start time, from `/proc/PID/stat`.
fn stat(pid: i32) -> Option<(i32, u64)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<&str> = stat.rsplit_once(") ")?.1.split_whitespace().collect();
    Some((fields.get(2)?.parse().ok()?, fields.get(19)?.parse().ok()?))
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
