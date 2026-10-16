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

static NEXT: AtomicU64 = AtomicU64::new(0);
const MARKER: &[u8] = b"CLOUDROOM_WORKLOAD=";
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
    /// host on the first command and keeps it for the session, so it is harness, not a background job.
    pub fn process_count(&self) -> Option<usize> {
        Some(
            self.pids()
                .ok()?
                .iter()
                .filter(|pid| !helper(**pid))
                .count(),
        )
    }
    /// Kills the process group, other than the harness's own, that wrote the most to disk: a tool command,
    /// never the harness or its helpers. The youngest group wins when write counts are
    /// unreadable. Returns the heaviest writer's command line, or None when nothing but the harness remains.
    pub fn kill_top_writer(&self, harness: u32) -> io::Result<Option<String>> {
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
        members.iter().for_each(|p| signal(p.0, SIGKILL));
        Ok(Some(command))
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
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    unsafe { kill(pid, number) };
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
        let stopped = workload.kill_top_writer(harness.id()).unwrap().unwrap();
        assert!(stopped.starts_with("sh -c i=0"), "{stopped}");
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
