use crate::config::Config;
use crate::workspace::storage::{Disk, disk};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    time::Instant,
};

/// Linux reports process CPU in 100 Hz ticks (USER_HZ) on every architecture we run on.
const MS_PER_TICK: u64 = 10;
/// A minute with no agent working that still used half a CPU is idle burn: a leftover job, or a bug.
const IDLE_BURN_MS: u64 = 30_000;
const TOP_PROGRAMS: usize = 5;

#[derive(Serialize)]
pub(crate) struct Resources {
    cpu_used_percent: Option<f64>,
    memory_total_bytes: Option<u64>,
    memory_used_bytes: Option<u64>,
    /// Processes the kernel has killed for memory since the container started (its cgroup's `oom_kill`).
    #[serde(skip_serializing_if = "Option::is_none")]
    oom_kills: Option<u64>,
    workspace_disk: Option<Disk>,
    state_disk: Option<Disk>,
    pub(super) agents: Option<super::metrics::AgentCounts>,
    /// Once a minute; absent from the other samples.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cpu_minute: Option<CpuMinute>,
}

/// Where this machine's (or container's) CPU went in the last minute. Program names only, never arguments or paths.
#[derive(Serialize)]
pub(crate) struct CpuMinute {
    total_ms: u64,
    /// The top programs, `(exited)` for processes that ended during the minute, and `(other)` for the rest.
    programs: BTreeMap<String, u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    idle_burn: bool,
}

/// One process's CPU ticks: its own, and its finished children's (added when it reaps them).
#[derive(Clone, Default)]
struct Ticks {
    program: String,
    own: u64,
    children: u64,
}
/// Keyed by pid and start time, because pids are reused.
type Processes = HashMap<(u32, u64), Ticks>;

impl Resources {
    pub(super) fn dashboard(&self) -> Value {
        let percent = |used: Option<u64>, total: Option<u64>| {
            used.zip(total)
                .filter(|(used, total)| *total > 0 && used <= total)
                .map(|(used, total)| used as f64 * 100.0 / total as f64)
        };
        json!({"cpu": self.cpu_used_percent,
            "memory": percent(self.memory_used_bytes, self.memory_total_bytes),
            "disk": self.workspace_disk.as_ref().and_then(|d| percent(Some(d.used_bytes), d.used_bytes.checked_add(d.available_bytes))),
            "memoryUsedBytes": self.memory_used_bytes, "memoryTotalBytes": self.memory_total_bytes,
            "diskAvailableBytes": self.workspace_disk.as_ref().map(|d| d.available_bytes),
            "diskTotalBytes": self.workspace_disk.as_ref().map(|d| d.total_bytes)})
    }
}

#[derive(Default)]
pub(super) struct Sampler {
    cpu: Option<(u64, u64)>,
    container_cpu: Option<(u64, Instant)>,
    processes: Option<Processes>,
    /// The container's CPU counter (microseconds) at the last minute's reading.
    minute_usage: Option<u64>,
    /// Without that counter: ticks counted twice in an earlier minute, still to be taken back.
    over_counted: u64,
}

impl Sampler {
    /// Inside a container, `/proc/stat` and `/proc/meminfo` describe the whole host, so the container's own
    /// cgroup counters win when the provider exposes them.
    pub async fn sample(&mut self, config: &Config) -> Resources {
        let current = fs::read_to_string("/proc/stat").ok().and_then(|s| cpu(&s));
        let mut cpu_used_percent =
            current
                .zip(self.cpu)
                .and_then(|((total, idle), (old_total, old_idle))| {
                    let total = total.checked_sub(old_total)?;
                    let idle = idle.checked_sub(old_idle)?;
                    (total > 0 && idle <= total)
                        .then(|| (total - idle) as f64 * 100.0 / total as f64)
                });
        self.cpu = current;
        if let Some((usage, cpus)) = container_usage().zip(cgroup_cpus()) {
            let now = Instant::now();
            cpu_used_percent = self.container_cpu.and_then(|(old, at)| {
                let wall = now.duration_since(at).as_micros() as f64 * cpus;
                (wall > 0.0).then(|| usage.saturating_sub(old) as f64 * 100.0 / wall)
            });
            self.container_cpu = Some((usage, now));
        }
        let memory = fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let mut memory_total_bytes = memory_field(&memory, "MemTotal:");
        let mut memory_used_bytes = memory_total_bytes
            .zip(memory_field(&memory, "MemAvailable:"))
            .and_then(|(total, available)| total.checked_sub(available));
        let limit = cgroup("memory.max").and_then(|s| s.trim().parse::<u64>().ok());
        if let Some((limit, current)) = limit.zip(cgroup("memory.current")) {
            // Like `docker stats`: reclaimable file cache is not in use.
            let inactive = cgroup("memory.stat").and_then(|s| field(&s, "inactive_file"));
            memory_total_bytes = Some(limit);
            memory_used_bytes = current
                .trim()
                .parse::<u64>()
                .ok()
                .map(|used| used.saturating_sub(inactive.unwrap_or(0)));
        }
        Resources {
            cpu_used_percent,
            memory_total_bytes,
            memory_used_bytes,
            oom_kills: cgroup("memory.events").and_then(|s| field(&s, "oom_kill")),
            workspace_disk: disk(&config.repository).ok(),
            state_disk: disk(&config.state_dir).ok(),
            agents: None,
            cpu_minute: None,
        }
    }

    /// CPU per program since the last call, from every process `/proc` shows. Called once a minute; the first
    /// call only takes a baseline. `busy`: an agent did something at some point during the minute.
    pub fn minute(&mut self, busy: bool) -> Option<CpuMinute> {
        let processes = processes();
        // Only a container's own cgroup: a root cgroup (no `cpu.max`) may count processes `/proc` doesn't show.
        let usage = container_usage().filter(|_| cgroup_cpus().is_some());
        self.tally(processes, usage, busy)
    }

    fn tally(&mut self, now: Processes, usage: Option<u64>, busy: bool) -> Option<CpuMinute> {
        let usage_before = std::mem::replace(&mut self.minute_usage, usage);
        let before = self.processes.replace(now)?;
        let (mut used, children) = account(&before, self.processes.as_ref()?);
        used.sort_by_key(|(_, ticks)| std::cmp::Reverse(*ticks));
        let own_ms = used.iter().map(|(_, ticks)| ticks).sum::<u64>() * MS_PER_TICK;
        // `/proc` can't be read all at once: a process reaped between two reads counts in both its own and its
        // parent's numbers. The container's counter is exact, so it sets the total and the rest is `(exited)`.
        let exited_ms = match usage.zip(usage_before) {
            Some((now, before)) => (now.saturating_sub(before) / 1000).saturating_sub(own_ms),
            None => {
                let net = children - i128::from(self.over_counted);
                self.over_counted = u64::try_from(-net).unwrap_or(0);
                u64::try_from(net).unwrap_or(0) * MS_PER_TICK
            }
        };
        let total_ms = own_ms + exited_ms;
        let mut programs = BTreeMap::new();
        for (i, (program, ticks)) in used.into_iter().enumerate() {
            let name = if i < TOP_PROGRAMS {
                program
            } else {
                "(other)".into()
            };
            *programs.entry(name).or_default() += ticks * MS_PER_TICK;
        }
        if exited_ms > 0 {
            programs.insert("(exited)".into(), exited_ms);
        }
        Some(CpuMinute {
            total_ms,
            programs,
            idle_burn: !busy && total_ms >= IDLE_BURN_MS,
        })
    }
}

/// Ticks per program between two readings, and the net ticks of finished children: a process that ended moved
/// its whole count into its reaper's `children`, so only its part since the last reading is new.
fn account(before: &Processes, now: &Processes) -> (Vec<(String, u64)>, i128) {
    let mut used: HashMap<String, u64> = HashMap::new();
    let mut children: i128 = 0;
    for (key, process) in now {
        let old = before.get(key).cloned().unwrap_or_default();
        *used.entry(process.program.clone()).or_default() += process.own.saturating_sub(old.own);
        children += i128::from(process.children.saturating_sub(old.children));
    }
    for (key, process) in before {
        if !now.contains_key(key) {
            children -= i128::from(process.own + process.children);
        }
    }
    let used = used.into_iter().filter(|(_, ticks)| *ticks > 0).collect();
    (used, children)
}

/// Every process `/proc` shows, parents (lower pids) first: a child that ends mid-walk then lands in its parent's
/// count in the next reading, rather than in both of this one.
fn processes() -> Processes {
    let mut found = Processes::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return found;
    };
    let mut pids: Vec<u32> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
        .collect();
    pids.sort_unstable();
    for pid in pids {
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some((head, rest)) = stat.rsplit_once(") ") else {
            continue;
        };
        // proc(5) fields 14-17 are utime, stime, cutime, cstime; 22 is the start time. `rest` starts at field 3.
        let fields: Vec<&str> = rest.split_whitespace().collect();
        let tick = |field: usize| fields.get(field - 3).and_then(|v| v.parse::<i64>().ok());
        let (Some(utime), Some(stime), Some(cutime), Some(cstime), Some(start)) =
            (tick(14), tick(15), tick(16), tick(17), tick(22))
        else {
            continue;
        };
        let comm = head.split_once(" (").map_or("", |(_, comm)| comm);
        let ticks = Ticks {
            program: program(pid, comm),
            own: (utime + stime).max(0) as u64,
            children: (cutime + cstime).max(0) as u64,
        };
        found.insert((pid, start.max(0) as u64), ticks);
    }
    found
}

/// The process name. For Node (`node`, or `node-MainThread` in newer versions), the npm package its script
/// belongs to (`typescript`, `@anthropic-ai/claude-code`), so tools and harnesses don't all read `node`.
fn program(pid: u32, comm: &str) -> String {
    if !matches!(comm, "node" | "node-MainThread") {
        return comm.to_owned();
    }
    let cmdline = fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
    node_package(&String::from_utf8_lossy(&cmdline)).unwrap_or_else(|| "node".into())
}

/// Reads only the script path, never inline code (`-e`, `-p`), and keeps only a valid npm package name.
fn node_package(cmdline: &str) -> Option<String> {
    let mut args = cmdline.split('\0').skip(1);
    let script = loop {
        let arg = args.next()?;
        if !arg.starts_with('-') {
            break arg;
        }
        let short = !arg.starts_with("--");
        if arg.starts_with("--eval")
            || arg.starts_with("--print")
            || (short && arg.contains(['e', 'p']))
        {
            return None;
        }
        // These take the next argument as their value, not as the script.
        if matches!(
            arg,
            "-r" | "--require" | "--import" | "--loader" | "--experimental-loader"
        ) {
            args.next()?;
        }
    };
    let mut parts = script.rsplit_once("node_modules/")?.1.split('/');
    let first = parts.next()?;
    match first.strip_prefix('@') {
        Some(scope) => {
            let package = parts.next()?;
            (npm_name(scope) && npm_name(package)).then(|| format!("{first}/{package}"))
        }
        None => npm_name(first).then(|| first.to_owned()),
    }
}

/// One part of an npm package name, bounded: lowercase letters, digits, `-`, `.` and `_`, up to 64 characters.
fn npm_name(part: &str) -> bool {
    (1..=64).contains(&part.len())
        && !part.starts_with(['.', '_'])
        && part
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-._".contains(&b))
}

/// The container's CPU counter in microseconds, when its cgroup is visible.
fn container_usage() -> Option<u64> {
    cgroup("cpu.stat").and_then(|s| field(&s, "usage_usec"))
}

/// The container's own cgroup v2 counters, when visible.
fn cgroup(file: &str) -> Option<String> {
    fs::read_to_string(format!("/sys/fs/cgroup/{file}")).ok()
}

/// CPUs the container may use: its quota, or else every CPU this process can run on. None outside a container
/// (the root cgroup has no `cpu.max`), where `/proc/stat` is already right.
fn cgroup_cpus() -> Option<f64> {
    let limit = cgroup("cpu.max")?;
    let mut parts = limit.split_whitespace();
    let quota = parts.next()?.parse::<f64>().ok();
    let period = parts.next()?.parse::<f64>().ok()?;
    quota.map(|quota| quota / period).or_else(|| {
        std::thread::available_parallelism()
            .ok()
            .map(|n| n.get() as f64)
    })
}

fn field(text: &str, name: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        line.strip_prefix(name)?
            .strip_prefix(' ')?
            .trim()
            .parse()
            .ok()
    })
}

#[test]
fn disk_percentage_excludes_reserved_blocks() {
    let mut resources = Resources {
        cpu_used_percent: None,
        memory_total_bytes: None,
        memory_used_bytes: None,
        oom_kills: None,
        workspace_disk: Some(Disk {
            total_bytes: 80,
            used_bytes: 77,
            available_bytes: 0,
        }),
        state_disk: None,
        agents: None,
        cpu_minute: None,
    };
    assert_eq!(resources.dashboard()["disk"], 100.0);
    resources.workspace_disk = Some(Disk {
        total_bytes: 80,
        used_bytes: 38,
        available_bytes: 38,
    });
    assert_eq!(resources.dashboard()["disk"], 50.0);
    resources.workspace_disk = None;
    assert!(resources.dashboard()["disk"].is_null());
}

fn cpu(text: &str) -> Option<(u64, u64)> {
    let mut line = text.lines().next()?.split_whitespace();
    if line.next()? != "cpu" {
        return None;
    }
    // Guest time is already included in user/nice; do not count the last two fields twice.
    let counters: Vec<u64> = line
        .take(8)
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    if counters.len() < 8 {
        return None;
    }
    Some((counters.iter().sum(), counters[3] + counters[4]))
}

fn memory_field(text: &str, name: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        if fields.next()? != name {
            return None;
        }
        fields.next()?.parse::<u64>().ok()?.checked_mul(1024)
    })
}

#[cfg(test)]
fn ticks(program: &str, own: u64, children: u64) -> Ticks {
    Ticks {
        program: program.into(),
        own,
        children,
    }
}

#[test]
fn cpu_minute_counts_ended_processes_once() {
    // Before: a harness and a build it started.
    let before = Processes::from([
        ((1, 1), ticks("claude", 100, 0)),
        ((2, 5), ticks("tsc", 300, 0)),
    ]);
    // The build used 50 more ticks and ended, and a 20-tick command came and went; the harness reaped both.
    let now = Processes::from([
        ((1, 1), ticks("claude", 110, 370)),
        ((3, 9), ticks("cargo", 40, 0)),
    ]);
    let (mut used, exited) = account(&before, &now);
    used.sort();
    assert_eq!(used, [("cargo".to_owned(), 40), ("claude".to_owned(), 10)]);
    assert_eq!(exited, 70);
}

#[test]
fn cpu_minute_never_keeps_a_double_count() {
    // A build uses 40 ticks and ends while `/proc` is read: its ticks show as its own and in the harness's children.
    let start = Processes::from([
        ((1, 1), ticks("claude", 100, 0)),
        ((2, 5), ticks("tsc", 0, 0)),
    ]);
    let racing = Processes::from([
        ((1, 1), ticks("claude", 110, 40)),
        ((2, 5), ticks("tsc", 40, 0)),
    ]);
    let after = Processes::from([((1, 1), ticks("claude", 120, 40))]);
    let later = Processes::from([((1, 1), ticks("claude", 120, 100))]);

    // A container's own counter (microseconds) is exact: 50 ticks, then 10.
    let mut sampler = Sampler::default();
    assert!(sampler.tally(start.clone(), Some(0), true).is_none());
    let minute = sampler.tally(racing.clone(), Some(500_000), true).unwrap();
    assert_eq!(
        (minute.total_ms, minute.programs.get("(exited)")),
        (500, None)
    );
    assert_eq!(
        sampler
            .tally(after.clone(), Some(600_000), true)
            .unwrap()
            .total_ms,
        100
    );

    // Without one, the 40 counted twice are taken back from the next finished children (60 ticks), not lost.
    let mut sampler = Sampler::default();
    sampler.tally(start, None, true);
    let totals: Vec<u64> = [racing, after, later]
        .into_iter()
        .map(|now| sampler.tally(now, None, true).unwrap().total_ms)
        .collect();
    assert_eq!(totals, [900, 100, 200]);
    assert_eq!(totals.iter().sum::<u64>(), (50 + 10 + 60) * MS_PER_TICK);
}

#[test]
fn node_processes_show_only_a_valid_package_name() {
    let cases = [
        (
            "node\0/app/node_modules/.pnpm/typescript@5/node_modules/typescript/bin/tsc\0-p\0.",
            Some("typescript"),
        ),
        (
            "node\0--max-old-space-size=4096\0/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            Some("@anthropic-ai/claude-code"),
        ),
        (
            "node\0-e\0require('/x/node_modules/sk-live-secret/a')",
            None,
        ),
        ("node\0-pe\0'/x/node_modules/token'", None),
        ("node\0--eval=require('/x/node_modules/secret')", None),
        (
            "node\0-r\0/x/node_modules/dotenv/config.js\0server.js",
            None,
        ),
        ("node\0/x/node_modules/SECRET_TOKEN=abc/a.js", None),
    ];
    for (cmdline, package) in cases {
        assert_eq!(node_package(cmdline).as_deref(), package, "{cmdline}");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn cpu_minute_sees_real_processes() {
    let mut sampler = Sampler::default();
    assert!(
        sampler.minute(true).is_none(),
        "the first call is a baseline"
    );
    let start = Instant::now();
    while start.elapsed() < std::time::Duration::from_millis(500) {
        std::hint::black_box(start.elapsed());
    }
    let minute = sampler.minute(false).expect("a reading");
    assert!(minute.total_ms >= 200, "{} ms", minute.total_ms);
    assert!(minute.programs.len() <= TOP_PROGRAMS + 2);
    assert!(
        !minute.idle_burn,
        "half a second is under the idle-burn threshold"
    );
}
