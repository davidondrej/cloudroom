pub(crate) mod metrics;
mod system;
#[cfg(test)]
mod tests;

use crate::{
    config::Config,
    runtime::{ExitDetails, Kind},
};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque, hash_map::RandomState},
    fs::{self, OpenOptions},
    hash::BuildHasher,
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, watch};

const CAPACITY: usize = 1024;
const LOCAL_BYTES: u64 = 8 * 1024 * 1024;
const SUMMARY_INTERVAL: Duration = Duration::from_secs(60);
const CPU_INTERVAL: Duration = Duration::from_secs(60);
const SLOW_API_MS: u64 = 1000;
const STDERR_CAPACITY: usize = 32;
const STDERR_BATCH: usize = 8;
const STDERR_FILE_BYTES: u64 = 1024 * 1024;

/// Only diagnostic fields belong here: never prompts, native payloads, paths or credentials.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Signal {
    Api {
        method: &'static str,
        route: String,
        status: u16,
        duration_ms: u64,
    },
    ApiSummary(ApiSummary),
    AgentStart {
        session_id: String,
        success: bool,
        duration_ms: u64,
    },
    AgentExit {
        session_id: Option<String>,
        harness: Kind,
        expected: bool,
        reason: &'static str,
        exit_code: Option<i32>,
        signal: Option<i32>,
        stderr_bytes: u64,
        stderr_complete: bool,
        stderr_truncated: bool,
    },
    HistoryUpload {
        records: usize,
        pending_records: u64,
        success: bool,
        duration_ms: u64,
    },
    HistoryFault {
        operation: &'static str,
    },
    /// The disk guard loop measured late; work saw a stale reading for this long.
    StorageStale {
        gap_ms: u64,
    },
    AuthHealth {
        harness: Kind,
        credentials: crate::runtime::claude_auth::Credentials,
        last_request: crate::runtime::claude_auth::RequestStatus,
        last_request_at_ms: Option<u64>,
        reason: &'static str,
    },
    Resources(system::Resources),
    ComputerUse {
        session_id: String,
        tool: String,
        app: Option<String>,
        outcome: String,
        effect: Option<String>,
        duration_ms: u64,
    },
    Diagnostics {
        dropped: u64,
        local_write_failures: u64,
        upload_failures: u64,
    },
}

#[derive(Serialize)]
pub(crate) struct ApiSummary {
    method: &'static str,
    route: String,
    status: u16,
    requests: u64,
    total_duration_ms: u64,
    max_duration_ms: u64,
    first_timestamp_ms: u64,
    last_timestamp_ms: u64,
}

#[derive(Serialize)]
struct Record {
    run_id: String,
    sequence: u64,
    timestamp_ms: u64,
    #[serde(flatten)]
    signal: Signal,
}

// This separate, non-serializable envelope can never enter the PostgreSQL buffer.
struct LocalStderr {
    metadata: Value,
    bytes: Vec<u8>,
}

#[derive(Clone)]
pub(crate) struct Observability {
    sender: mpsc::Sender<Record>,
    stderr: mpsc::Sender<LocalStderr>,
    run_id: Arc<String>,
    sequence: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    stop: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
    resources: watch::Sender<(Option<u64>, Value)>,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u64::MAX as u128) as u64
}

impl Observability {
    pub fn start(
        config: &Config,
        api: Option<crate::session::history::Api>,
        agents: impl Fn() -> metrics::AgentCounts + Send + 'static,
    ) -> Self {
        let (sender, receiver) = mpsc::channel(CAPACITY);
        let (stderr, captures) = mpsc::channel(STDERR_CAPACITY);
        let (stop, stopping) = watch::channel(false);
        let (done, finished) = watch::channel(false);
        let this = Self {
            sender,
            stderr,
            // Many sandboxes share one store: their label keeps each one's runs apart.
            run_id: Arc::new(format!(
                "{}{:016x}",
                config
                    .instance
                    .as_ref()
                    .map(|label| format!("{label}-"))
                    .unwrap_or_default(),
                RandomState::new().hash_one(SystemTime::now())
            )),
            sequence: Arc::new(AtomicU64::new(0)),
            dropped: Arc::new(AtomicU64::new(0)),
            stop,
            finished,
            resources: watch::channel((None, json!({"cpu":null,"memory":null,"disk":null}))).0,
        };
        let config = config.clone();
        let worker = this.clone();
        tokio::spawn(async move {
            worker
                .run(config, api, receiver, captures, stopping, agents)
                .await;
            done.send_replace(true);
        });
        this
    }

    fn make_record(&self, signal: Signal) -> Record {
        Record {
            run_id: self.run_id.as_ref().clone(),
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
            timestamp_ms: now_ms(),
            signal,
        }
    }

    /// No disk or database waits on the caller's path. Overload is counted, not backpressured.
    pub fn record(&self, signal: Signal) -> String {
        self.submit(self.make_record(signal))
    }

    pub fn agent_exit(
        &self,
        session_id: Option<&str>,
        harness: Kind,
        reason: &'static str,
        expected: bool,
        details: ExitDetails,
    ) -> String {
        let record = self.make_record(Signal::AgentExit {
            session_id: session_id.map(str::to_owned),
            harness,
            reason,
            expected,
            exit_code: details.code,
            signal: details.signal,
            stderr_bytes: details.stderr_bytes,
            stderr_complete: details.stderr_complete,
            stderr_truncated: details.stderr_bytes > details.stderr.len() as u64,
        });
        if !details.stderr.is_empty() {
            let capture = LocalStderr {
                metadata: serde_json::to_value(&record).expect("diagnostic serialization"),
                bytes: details.stderr,
            };
            if self.stderr.try_send(capture).is_err() {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        self.submit(record)
    }

    fn submit(&self, record: Record) -> String {
        let id = format!("{}-{}", record.run_id, record.sequence);
        if self.sender.try_send(record).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
        id
    }

    pub fn resources(&self) -> (Option<u64>, Value) {
        self.resources.borrow().clone()
    }

    pub async fn shutdown(&self) {
        self.stop.send_replace(true);
        let mut finished = self.finished.clone();
        let _ = tokio::time::timeout(Duration::from_secs(5), finished.wait_for(|done| *done)).await;
    }

    async fn run(
        &self,
        config: Config,
        api: Option<crate::session::history::Api>,
        mut receiver: mpsc::Receiver<Record>,
        mut captures: mpsc::Receiver<LocalStderr>,
        mut stop: watch::Receiver<bool>,
        agents: impl Fn() -> metrics::AgentCounts + Send,
    ) {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut pending = VecDeque::new();
        let mut sampler = system::Sampler::default();
        let mut sample_at = Instant::now();
        let (mut cpu_at, mut cpu_since_ms, mut busy) = (Instant::now(), now_ms(), false);
        let mut summaries = BTreeMap::new();
        let mut summary_at = Instant::now() + SUMMARY_INTERVAL;
        let mut upload_at = Instant::now() + config.diagnostic_upload;
        let (mut local_write_failures, mut upload_failures) = (0, 0);
        loop {
            if !*stop.borrow() {
                tokio::select! { _ = tick.tick() => {}, _ = stop.changed() => {} }
            }
            let stopping = *stop.borrow();
            if stopping {
                receiver.close();
                captures.close();
            }
            let mut batch = Vec::new();
            for _ in 0..CAPACITY {
                match receiver.try_recv() {
                    Ok(record) => batch.push(record),
                    Err(_) => break,
                }
            }
            if !stopping && Instant::now() >= sample_at {
                let mut resources = sampler.sample(&config).await;
                let counts = agents();
                // Background jobs keep a sandbox awake, but their CPU with nobody working is still idle burn.
                busy |= counts.working > 0
                    || counts.queued > 0
                    || counts.last_activity.is_some_and(|at| at >= cpu_since_ms);
                if Instant::now() >= cpu_at {
                    resources.cpu_minute = sampler.minute(busy);
                    (cpu_at, cpu_since_ms, busy) = (Instant::now() + CPU_INTERVAL, now_ms(), false);
                }
                resources.agents = Some(counts);
                self.resources
                    .send_replace((Some(now_ms()), resources.dashboard()));
                batch.push(self.make_record(Signal::Resources(resources)));
                batch.push(self.make_record(Signal::Diagnostics {
                    dropped: self.dropped.load(Ordering::Relaxed),
                    local_write_failures,
                    upload_failures,
                }));
                sample_at = Instant::now() + Duration::from_secs(10);
            }
            if !batch.is_empty() {
                let mut bytes = Vec::new();
                for record in &batch {
                    serde_json::to_writer(&mut bytes, record).expect("diagnostic serialization");
                    bytes.push(b'\n');
                }
                let directory = config.state_dir.clone();
                if !matches!(
                    tokio::task::spawn_blocking(move || write_local(
                        &directory,
                        &bytes,
                        LOCAL_BYTES
                    ))
                    .await,
                    Ok(Ok(()))
                ) {
                    local_write_failures += 1;
                    eprintln!("Cloudroom diagnostic file write failed");
                }
                for record in batch {
                    // The Mac helper reports once a minute: a good report stays in the local files only, so it adds
                    // no website rows (db-load-budget).
                    if matches!(&record.signal, Signal::Api { method, route, status, duration_ms }
                        if *method == "POST" && route == "/v1/mac/helper" && (200..400).contains(status) && *duration_ms < SLOW_API_MS)
                    {
                        continue;
                    }
                    // The Mac helper pairs and reports to each awake sandbox every 2 s: like GETs, only counts upload.
                    if let Signal::Api {
                        method,
                        route,
                        status,
                        duration_ms,
                    } = &record.signal
                        && (*method == "GET"
                            || (*method == "POST"
                                && matches!(
                                    route.as_str(),
                                    "/v1/sync" | "/v1/previews/device" | "/v1/previews/report"
                                )))
                        && (200..400).contains(status)
                        && *duration_ms < SLOW_API_MS
                    {
                        let summary = summaries
                            .entry((*method, route.clone(), *status))
                            .or_insert_with(|| ApiSummary {
                                method,
                                route: route.clone(),
                                status: *status,
                                requests: 0,
                                total_duration_ms: 0,
                                max_duration_ms: 0,
                                first_timestamp_ms: record.timestamp_ms,
                                last_timestamp_ms: record.timestamp_ms,
                            });
                        summary.requests += 1;
                        summary.total_duration_ms += duration_ms;
                        summary.max_duration_ms = summary.max_duration_ms.max(*duration_ms);
                        summary.last_timestamp_ms = record.timestamp_ms;
                    } else {
                        pending.push_back(record);
                    }
                }
            }
            if stopping || Instant::now() >= summary_at {
                pending.extend(
                    std::mem::take(&mut summaries)
                        .into_values()
                        .map(|summary| self.make_record(Signal::ApiSummary(summary))),
                );
                summary_at = Instant::now() + SUMMARY_INTERVAL;
            }
            while pending.len() > CAPACITY {
                pending.pop_front();
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            let mut local = Vec::new();
            for _ in 0..STDERR_BATCH {
                match captures.try_recv() {
                    Ok(capture) => local.push(capture),
                    Err(_) => break,
                }
            }
            if !local.is_empty() {
                let directory = config.state_dir.clone();
                if !matches!(
                    tokio::task::spawn_blocking(move || write_stderr(&directory, local)).await,
                    Ok(Ok(()))
                ) {
                    local_write_failures += 1;
                    eprintln!("Cloudroom private harness diagnostic write failed");
                }
            }
            // Finish bounded local batches before spending the shutdown budget on the upload.
            if stopping && !captures.is_empty() {
                continue;
            }
            // Batched, so hundreds of idle cores (e.g. hot spares answering capability checks) cost the website
            // little. The website prunes them after 7 days. Without an API they stay in the local files only.
            if !pending.is_empty() && (stopping || Instant::now() >= upload_at) {
                upload_at = Instant::now() + config.diagnostic_upload;
                let Some(api) = &api else {
                    pending.clear();
                    continue;
                };
                let payload = serde_json::to_value(&pending).expect("diagnostic serialization");
                match tokio::time::timeout(
                    Duration::from_secs(10),
                    api.post("diagnostics", &payload),
                )
                .await
                {
                    Ok(Ok(_)) => pending.clear(),
                    _ => upload_failures += 1,
                }
            }
            if stopping {
                return;
            }
            if *stop.borrow() {
                continue;
            }
        }
    }
}

fn write_stderr(state: &Path, captures: Vec<LocalStderr>) -> io::Result<()> {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    let uid = unsafe { geteuid() };
    let check_directory = |path: &Path, forbidden: u32| -> io::Result<()> {
        let m = fs::symlink_metadata(path)?;
        if !m.is_dir() || m.uid() != uid || m.mode() & forbidden != 0 {
            return Err(io::Error::other("unsafe diagnostic directory"));
        }
        Ok(())
    };
    check_directory(state, 0o022)?;
    let directory = state.join("harness-diagnostics");
    match fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    check_directory(&directory, 0o077)?;
    // The protected directory prevents agent races after these checks. Never repair unsafe files.
    for name in ["stderr.jsonl", "stderr.previous.jsonl"] {
        match fs::symlink_metadata(directory.join(name)) {
            Ok(m)
                if m.is_file()
                    && m.uid() == uid
                    && m.nlink() == 1
                    && m.mode() & 0o777 == 0o600
                    && m.len() <= STDERR_FILE_BYTES => {}
            Ok(_) => return Err(io::Error::other("unsafe diagnostic file")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    for capture in captures {
        let mut record = capture.metadata;
        record["stderr"] = json!(String::from_utf8_lossy(&capture.bytes));
        let mut bytes = serde_json::to_vec(&record)?;
        bytes.push(b'\n');
        write_rotated(&directory, "stderr", &bytes, STDERR_FILE_BYTES)?;
    }
    Ok(())
}

fn write_local(directory: &Path, bytes: &[u8], limit: u64) -> io::Result<()> {
    write_rotated(directory, "diagnostics", bytes, limit)
}

fn write_rotated(directory: &Path, name: &str, bytes: &[u8], limit: u64) -> io::Result<()> {
    if bytes.len() as u64 > limit {
        return Err(io::Error::other("diagnostic batch exceeds file limit"));
    }
    let path = directory.join(format!("{name}.jsonl"));
    if fs::metadata(&path).is_ok_and(|m| m.len() + bytes.len() as u64 > limit) {
        fs::rename(&path, directory.join(format!("{name}.previous.jsonl")))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}
