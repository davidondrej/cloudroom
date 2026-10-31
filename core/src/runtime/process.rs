use super::{Adapter, Event, ExitDetails, Progress, SHUTDOWN_GRACE, linux};
use crate::config::Config;
use serde_json::Value;
use std::{
    io,
    os::unix::process::ExitStatusExt,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{mpsc, oneshot, watch},
};

pub(super) const MAX_LINE: usize = 16 * 1024 * 1024;
const STDERR_BYTES: usize = 16 * 1024;

struct StderrCapture {
    task: tokio::task::JoinHandle<()>,
    tail: Arc<Mutex<ExitDetails>>,
}
impl StderrCapture {
    fn start(mut stderr: tokio::process::ChildStderr) -> Self {
        let tail = Arc::new(Mutex::new(ExitDetails {
            stderr: Vec::with_capacity(STDERR_BYTES),
            ..ExitDetails::default()
        }));
        let captured = tail.clone();
        let task = tokio::spawn(async move {
            let mut bytes = [0; 8192];
            loop {
                match stderr.read(&mut bytes).await {
                    Ok(0) => {
                        captured.lock().unwrap().stderr_complete = true;
                        break;
                    }
                    Ok(n) => {
                        let mut tail = captured.lock().unwrap();
                        tail.stderr_bytes = tail.stderr_bytes.saturating_add(n as u64);
                        let discard = (tail.stderr.len() + n).saturating_sub(STDERR_BYTES);
                        tail.stderr.drain(..discard);
                        tail.stderr.extend_from_slice(&bytes[..n]);
                    }
                    Err(_) => break, // Preserve partial bytes; never log the untrusted error text.
                }
            }
        });
        Self { task, tail }
    }

    async fn finish(mut self) -> ExitDetails {
        // A descendant can retain the pipe after the direct child exits.
        if tokio::time::timeout(Duration::from_millis(250), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
            let _ = (&mut self.task).await;
        }
        std::mem::take(&mut *self.tail.lock().unwrap())
    }
}
impl Drop for StderrCapture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Call {
    method: String,
    params: Value,
    request: Option<String>,
    target: Option<String>,
    dispatch_only: bool,
    reply: Option<oneshot::Sender<io::Result<Value>>>,
}

#[derive(Clone)]
pub(super) struct Process {
    calls: mpsc::Sender<Call>,
    pub progress: watch::Receiver<Progress>,
    stop: watch::Sender<bool>,
    pid: u32,
    group: Option<Arc<linux::Workload>>,
}

async fn write(input: &mut tokio::process::ChildStdin, value: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    tokio::time::timeout(SHUTDOWN_GRACE, input.write_all(&bytes))
        .await
        .map_err(|_| io::Error::other("harness stdin timed out"))?
}

impl Process {
    pub fn spawn(
        config: &Config,
        mut command: Command,
        mut adapter: Box<dyn Adapter>,
    ) -> io::Result<(Self, mpsc::Receiver<Event>)> {
        let group = config
            .storage
            .as_ref()
            .map(|policy| {
                let group = Arc::new(linux::Workload::create(policy)?);
                group.attach(&mut command, policy)?;
                command.env("npm_config_cache", policy.cache_dir.join("npm"));
                Ok::<_, io::Error>(group)
            })
            .transpose()?;
        let mut child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("harness has no pid"))?;
        let mut input = child.stdin.take();
        let mut output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| io::Error::other("missing stdout"))?,
        );
        let stderr = StderrCapture::start(
            child
                .stderr
                .take()
                .ok_or_else(|| io::Error::other("missing stderr"))?,
        );
        let (calls, mut receiver) = mpsc::channel::<Call>(16);
        let (events, incoming) = mpsc::channel(128);
        let (progress, observed) = watch::channel(Progress::default());
        let (stop, mut stopping) = watch::channel(false);
        let owned = group.clone();
        tokio::spawn(async move {
            let (_running, unprotected) = watch::channel(false);
            let mut paused = owned.as_ref().map(|g| g.paused()).unwrap_or(unprotected);
            let mut pending = std::collections::HashMap::new();
            let mut next = 0u64;
            let mut state = Progress::default();
            let mut line = Vec::new();
            let mut tick = tokio::time::interval(Duration::from_millis(250));
            let mut deadline = None;
            let mut output_closed = false;
            let mut close_pending = false;
            let mut cause = None;
            // History capture is a backup: a failure is logged once and retried later, never fatal.
            let mut capture_error = None;
            let reason = loop {
                let mut bounded = (&mut output).take((MAX_LINE + 1 - line.len()) as u64);
                tokio::select! {
                    _ = stopping.changed(), if deadline.is_none() => {
                        receiver.close();
                        deadline = Some(tokio::time::Instant::now() + SHUTDOWN_GRACE);
                        let frames = adapter.close();
                        close_pending = !frames.is_empty();
                        if let Some(stdin) = input.as_mut() {
                            let mut failed = false;
                            for frame in frames { if write(stdin, &frame).await.is_err() { failed = true; break; } }
                            if failed { break "harness stdin closed"; }
                        }
                        if !close_pending { input.take(); }
                    }
                    _ = async { tokio::time::sleep_until(deadline.unwrap()).await }, if deadline.is_some() => break "harness shutdown timed out",
                    _ = child.wait() => break if deadline.is_some() { "service stopped owned harness" } else { "harness process exited" },
                    _ = paused.changed() => {},
                    Some(call) = receiver.recv(), if deadline.is_none() && !*paused.borrow() => {
                        if call.target.as_ref().is_some_and(|target| state.request.as_ref() != Some(target) || state.finished) {
                            let _ = call.reply.map(|r|r.send(Err(io::Error::new(io::ErrorKind::InvalidInput,"target is no longer active"))));
                            continue;
                        }
                        if let Err(error) = adapter.validate(&call.method, &call.params) {
                            let _ = call.reply.map(|reply| reply.send(Err(error)));
                            continue;
                        }
                        if let Some(request) = &call.request {
                            if state.request.is_some() && !state.finished && !state.auto { let _ = call.reply.map(|r| r.send(Err(io::Error::new(io::ErrorKind::InvalidInput, "harness is busy")))); continue; }
                            state = Progress { native: state.native.clone(), model: state.model.clone(), request: Some(request.clone()), ..Progress::default() };
                            progress.send_replace(state.clone());
                        }
                        next += 1;
                        let frame = adapter.encode(next, &call.method, call.params, call.request.as_deref());
                        if write(input.as_mut().unwrap(), &frame).await.is_err() { break "harness stdin closed"; }
                        if let Some(reply) = call.reply {
                            if call.dispatch_only { let _ = reply.send(Ok(Value::Null)); }
                            else { pending.insert(next, reply); }
                        }
                    }
                    result = bounded.read_until(b'\n', &mut line), if !output_closed => {
                        if matches!(result, Ok(0)) && deadline.is_some() { output_closed = true; continue; }
                        if !matches!(result, Ok(n) if n > 0) { break "harness stdout closed"; }
                        if line.len() > MAX_LINE || !line.ends_with(b"\n") { break "invalid or oversized harness frame"; }
                        let raw = match String::from_utf8(std::mem::take(&mut line)) { Ok(s) => s, Err(_) => break "invalid harness UTF-8" };
                        let value: Value = match serde_json::from_str(&raw) { Ok(v) => v, Err(_) => break "malformed harness JSON" };
                        let records = match adapter.receive(&value, raw, &mut state) { Ok(r) => r, Err(e) => { cause = Some(e.to_string()); break "invalid native state" } };
                        progress.send_replace(state.clone());
                        let mut disconnected = false;
                        for record in records { if events.send(record).await.is_err() { disconnected = true; break; } }
                        if disconnected { break "recording owner disconnected"; }
                        if let Some(stdin) = input.as_mut() {
                            let mut failed = false;
                            for frame in adapter.respond(&value) { if write(stdin, &frame).await.is_err() { failed = true; break; } }
                            if failed { break "harness stdin closed"; }
                        }
                        if close_pending && adapter.closed(&value) { close_pending = false; input.take(); }
                        if let Some((id, result)) = adapter.response(&value) && let Some(reply) = pending.remove(&id) { let _ = reply.send(result); }
                    }
                    _ = tick.tick() => {
                        let records = match adapter.capture() {
                            Ok(r) => { capture_error = None; r }
                            Err(e) => {
                                let error = e.to_string();
                                if capture_error.as_ref() != Some(&error) { eprintln!("Native history capture failed: {error}"); }
                                capture_error = Some(error);
                                continue;
                            }
                        };
                        let mut disconnected = false;
                        for record in records { if events.send(record).await.is_err() { disconnected = true; break; } }
                        if disconnected { break "recording owner disconnected"; }
                    }
                }
            };
            drop(input);
            let exited = tokio::time::timeout(Duration::from_millis(250), child.wait()).await;
            let mut status = exited.ok().and_then(Result::ok);
            let graceful = status.is_some_and(|status| adapter.clean_exit(status.code()));
            let killed = status.is_none();
            if killed {
                let _ = child.kill().await;
                status = child.wait().await.ok();
            }
            let cleaned_up = match owned {
                Some(ref g) => g.stop().await.is_ok(),
                None => true,
            };
            let mut details = stderr.finish().await;
            details.code = status.and_then(|status| status.code());
            details.signal = status.and_then(|status| status.signal());
            details.killed = killed;
            let mut reason = reason;
            loop {
                match adapter.capture() {
                    Ok(records) => {
                        let empty = records.is_empty();
                        for record in records {
                            if events.send(record).await.is_err() {
                                break;
                            }
                        }
                        if empty {
                            if !adapter.capture_pending() {
                                break;
                            }
                            tick.tick().await;
                        }
                    }
                    Err(error) => {
                        eprintln!("Native history capture failed at exit: {error}");
                        break;
                    }
                }
            }
            details.cause = cause;
            if !cleaned_up {
                reason = "workload exit unconfirmed; refusing replacement";
            }
            drop(pending);
            let expected = reason == "service stopped owned harness" && graceful && !close_pending;
            let _ = events
                .send(Event::Exited {
                    reason,
                    expected,
                    cleaned_up,
                    details,
                })
                .await;
        });
        Ok((
            Self {
                calls,
                progress: observed,
                stop,
                pid,
                group,
            },
            incoming,
        ))
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }
    /// Processes in this harness's workload, including background jobs. None without containment.
    pub fn process_count(&self) -> Option<usize> {
        self.group.as_ref()?.process_count()
    }
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        request: Option<&str>,
    ) -> io::Result<Value> {
        self.call_inner(
            method,
            params,
            request,
            None,
            Duration::from_secs(30),
            false,
        )
        .await
    }
    pub async fn call_timeout(
        &self,
        method: &str,
        params: Value,
        request: Option<&str>,
        timeout: Duration,
    ) -> io::Result<Value> {
        self.call_inner(method, params, request, None, timeout, false)
            .await
    }
    pub async fn control(&self, method: &str, params: Value, target: &str) -> io::Result<Value> {
        self.call_inner(
            method,
            params,
            None,
            Some(target),
            Duration::from_secs(30),
            false,
        )
        .await
    }
    pub async fn dispatch(
        &self,
        method: &str,
        params: Value,
        request: Option<&str>,
        target: Option<&str>,
    ) -> io::Result<()> {
        self.call_inner(
            method,
            params,
            request,
            target,
            Duration::from_secs(30),
            true,
        )
        .await?;
        Ok(())
    }
    async fn call_inner(
        &self,
        method: &str,
        params: Value,
        request: Option<&str>,
        target: Option<&str>,
        timeout: Duration,
        dispatch_only: bool,
    ) -> io::Result<Value> {
        if *self.stop.borrow() {
            return Err(io::Error::other("harness is closing"));
        }
        let (reply, receive) = oneshot::channel();
        tokio::time::timeout(
            SHUTDOWN_GRACE,
            self.calls.send(Call {
                method: method.into(),
                params,
                request: request.map(str::to_owned),
                target: target.map(str::to_owned),
                dispatch_only,
                reply: Some(reply),
            }),
        )
        .await
        .map_err(|_| io::Error::other("harness command queue timed out"))?
        .map_err(|_| io::Error::other("harness unavailable"))?;
        if let Some(group) = &self.group {
            linux::reply(receive, group.paused(), timeout).await?
        } else {
            tokio::time::timeout(timeout, receive)
                .await
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        "harness response timed out; outcome uncertain",
                    )
                })?
                .map_err(|_| io::Error::other("harness response lost; outcome uncertain"))?
        }
    }
    pub async fn notify(&self, method: &str) -> io::Result<()> {
        self.calls
            .send(Call {
                method: method.into(),
                params: Value::Null,
                request: None,
                target: None,
                dispatch_only: false,
                reply: None,
            })
            .await
            .map_err(|_| io::Error::other("harness unavailable"))
    }
    pub async fn pause(&self, paused: bool) -> io::Result<()> {
        self.group
            .as_ref()
            .ok_or_else(|| io::Error::other("workload containment unavailable"))?
            .freeze(paused)
            .await
    }
    pub fn top_writer(&self) -> io::Result<Option<linux::Writer>> {
        self.group
            .as_ref()
            .ok_or_else(|| io::Error::other("workload containment unavailable"))?
            .top_writer(self.pid)
    }
    pub fn request_shutdown(&self) {
        if let Some(group) = &self.group
            && *group.paused().borrow()
        {
            let _ = group.terminate();
        }
        self.stop.send_replace(true);
    }
}
