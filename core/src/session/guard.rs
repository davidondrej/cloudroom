//! Background loops: the disk safety guard, the shared-children memory note and the history uploader.
use super::*;
use crate::workspace::storage::FRESH;
use std::collections::HashMap;

/// How long work stays frozen before Cloudroom stops the command filling the disk.
const RESCUE_AFTER: Duration = Duration::from_secs(30);
/// A stop on a full disk its agent hasn't settled by then ends the agent (`end_for_stop`, #606).
const STOP_SETTLES: Duration = Duration::from_secs(5);
/// A command that wrote less than this is not filling the disk, so it is never stopped.
const RESCUE_MIN_BYTES: u64 = 32_000_000;
/// History uploads wait this long for more records, so a busy session sends one file per half minute.
const UPLOAD_AFTER: Duration = Duration::from_secs(30);
/// ...unless this many records wait already.
const UPLOAD_RECORDS: u64 = 1024;
/// How often the parent of shared-sandbox children may hear that the kernel kills processes for memory (#1619).
const MEMORY_NOTE_EVERY: Duration = Duration::from_secs(10 * 60);
/// Folds saved history into gzip segments (#280). Off for one release: Core before it can't open a compacted journal,
/// so a rollback must find none. Follow-up: turn it on once every Core reads segments.
const COMPACT_HISTORY: bool = false;

impl Manager {
    pub async fn check_storage(&self) -> Snapshot {
        self.storage.refresh(&self.config, &self.workspaces).await
    }

    fn has_storage_warning(&self) -> bool {
        self.local
            .lock()
            .unwrap()
            .sessions
            .values()
            .any(|s| s.storage_warned && s.handle.is_some())
    }

    pub fn start_storage_guard(self: &Arc<Self>) {
        if self.config.storage.is_none() {
            return;
        }
        let manager = self.clone();
        tokio::spawn(async move {
            let mut last_cleanup = Instant::now() - Duration::from_secs(60);
            let mut was_blocked = manager.storage.blocks();
            let mut blocked_since: Option<Instant> = None;
            let mut stops: HashMap<String, Instant> = HashMap::new();
            let mut measured = Instant::now();
            while !manager.is_stopping() {
                manager.storage.reserve();
                let snapshot = manager.check_storage().await;
                if measured.elapsed() > FRESH {
                    let gap_ms = elapsed_ms(measured);
                    manager
                        .observability
                        .record(Signal::StorageStale { gap_ms });
                }
                measured = Instant::now();
                let reading = if snapshot.level == Level::Normal {
                    String::new()
                } else {
                    manager
                        .storage
                        .measured(&snapshot, manager.workspaces.root())
                };
                if snapshot.level != Level::Normal {
                    let warnings = {
                        let mut local = manager.local.lock().unwrap();
                        let ids: Vec<_> = local
                            .sessions
                            .values()
                            .filter(|s| {
                                s.handle.is_some() && !s.storage_warned && s.native_id.is_some()
                            })
                            .map(|s| s.session_id.clone())
                            .collect();
                        let mut warnings = Vec::new();
                        for id in ids {
                            let text = if snapshot.reason == "measurement_unavailable" {
                                "Cloudroom: disk space could not be measured. Work is paused until storage can be verified. Your files and history are preserved."
                            } else if snapshot.level == Level::Blocked && manager.storage.stuck() {
                                "Cloudroom: the disk is full, so work is paused until space is freed; Clear caches & builds frees space. Your files and history are preserved."
                            } else if snapshot.level == Level::Blocked {
                                "Cloudroom: the disk is almost full, so work is paused. If space does not recover within 30 seconds, Cloudroom stops the command filling it. Your files and history are preserved."
                            } else {
                                "Cloudroom: disk space is running low. Work and sync continue. Delete files you no longer need; if the disk fills, Cloudroom pauses work and stops the command filling it."
                            };
                            let text = format!("{text}{reading}");
                            // Persist before delivery. A timed-out native notification is not blindly repeated.
                            if local
                                .append(
                                    &id,
                                    "storage_warning",
                                    json!({"text":text,"reason":snapshot.reason}),
                                    None,
                                )
                                .is_ok()
                            {
                                let s = &local.sessions[&id];
                                warnings.push((id, s.handle.clone().unwrap(), text));
                            }
                        }
                        warnings
                    };
                    let mut tasks = tokio::task::JoinSet::new();
                    for (id, handle, text) in warnings {
                        tasks.spawn(async move {
                            (
                                id,
                                tokio::time::timeout(
                                    Duration::from_secs(2),
                                    handle.system_message(&text),
                                )
                                .await
                                .is_ok_and(|r| r.is_ok()),
                            )
                        });
                    }
                    while let Some(Ok((id, delivered))) = tasks.join_next().await {
                        let _ = manager.local.lock().unwrap().append(
                            &id,
                            "storage_warning_delivery",
                            json!({"confirmed":delivered,"meaning":"accepted_by_harness_not_model_consumption"}),
                            None,
                        );
                    }
                }
                if snapshot.level == Level::Blocked {
                    let handles: Vec<_> = (manager.local.lock().unwrap().sessions.values())
                        .filter_map(|s| {
                            let handle = s.handle.clone()?;
                            Some((s.session_id.clone(), handle, s.interrupt_pending()))
                        })
                        .collect();
                    let mut all_paused = manager.storage.pause_writers(true).await.is_ok();
                    stops.retain(|id, _| {
                        handles.iter().any(|(s, _, stopping)| s == id && *stopping)
                    });
                    for (id, handle, stopping) in handles {
                        // A stop always settles (#606): every command its agent runs ends first, so only the agent
                        // wakes, until the stop settles, then it pauses again. One its agent hasn't settled within
                        // STOP_SETTLES ends the agent. Only on a measured full disk: an unmeasured one thaws nothing.
                        if stopping && snapshot.reason == "disk_capacity" {
                            let since = *stops.entry(id.clone()).or_insert_with(|| {
                                let _ = handle.stop_commands();
                                Instant::now()
                            });
                            let _ = handle.pause(false).await;
                            if since.elapsed() >= STOP_SETTLES {
                                manager.end_for_stop(&id, &handle).await;
                            }
                            continue;
                        }
                        if handle.pause(true).await.is_ok() {
                            let mut local = manager.local.lock().unwrap();
                            if !local.sessions[&id].storage_paused {
                                let _ = local.append(
                                        &id,
                                        "storage_pause",
                                        json!({"paused":true,"reason":snapshot.reason,"text":format!("{}{reading}", if snapshot.reason == "measurement_unavailable" {
                                            "Cloudroom: disk space could not be measured. Work is paused until storage can be verified."
                                        } else if manager.storage.stuck() {
                                            // At the lowest line no rescue runs (`Guard::rescue`).
                                            "Cloudroom: work paused because the disk is full. It stays paused until space is freed; Clear caches & builds frees space."
                                        } else {
                                            "Cloudroom: work paused because the disk is almost full. If space does not recover within 30 seconds, Cloudroom stops the command filling it."
                                        })}),
                                        None,
                                    );
                            }
                        } else {
                            all_paused = false;
                        }
                    }
                    if all_paused && last_cleanup.elapsed() >= Duration::from_secs(30) {
                        let _ = manager.storage.clean().await;
                        last_cleanup = Instant::now();
                    }
                    let since = *blocked_since.get_or_insert_with(Instant::now);
                    if all_paused
                        && snapshot.reason == "disk_capacity"
                        && since.elapsed() >= RESCUE_AFTER
                    {
                        manager.rescue(&snapshot).await;
                        blocked_since = None;
                    }
                    was_blocked = true;
                } else if was_blocked
                    || (snapshot.level == Level::Normal && manager.has_storage_warning())
                {
                    stops.clear();
                    let writers_resumed = manager.storage.pause_writers(false).await.is_ok();
                    let handles: Vec<_> = manager
                        .local
                        .lock()
                        .unwrap()
                        .sessions
                        .values()
                        .filter_map(|s| s.handle.clone().map(|h| (s.session_id.clone(), h)))
                        .collect();
                    for (id, handle) in handles {
                        if handle.pause(false).await.is_ok() {
                            let mut local = manager.local.lock().unwrap();
                            let result = if snapshot.level == Level::Normal {
                                local.append(&id, "storage_recovered", json!({"text":"Cloudroom: disk space has recovered. Work can continue."}), None)
                            } else {
                                local.append(&id, "storage_pause", json!({"paused":false,"text":"Cloudroom: work resumed. Disk space is still low."}), None)
                            };
                            if result.is_ok() {
                                manager.advance(&mut local, &id, false);
                            }
                        }
                    }
                    // Resume only workloads this guard actually paused. Process-loss
                    // recovery remains the separate lifecycle owner's responsibility.
                    was_blocked = !writers_resumed;
                    blocked_since = None;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }

    /// Frozen work never frees space, so a pause could last forever. Stops the one command in the sandbox that
    /// wrote the most, and tells every agent to clean up. The lowered threshold (`Guard::rescue`) then lets the
    /// guard loop thaw everything; a writer that keeps filling the disk is stopped on the next rescue. At the
    /// lowest pause line there is no rescue: work stays paused so history can still be saved.
    async fn rescue(&self, snapshot: &Snapshot) {
        if !self.storage.rescue() {
            return;
        }
        // After `Guard::rescue`, so it names the lowered pause line.
        let reading = self.storage.measured(snapshot, self.workspaces.root());
        let handles: Vec<_> = self
            .local
            .lock()
            .unwrap()
            .sessions
            .values()
            .filter_map(|s| s.handle.clone().map(|h| (s.session_id.clone(), h)))
            .collect();
        // Agents share one disk, and files from finished commands stay when a running one stops, so the
        // heaviest writer across all sessions goes, and only if it wrote enough to matter.
        let culprit = handles
            .iter()
            .filter_map(|(id, handle)| Some((id, handle.top_writer().ok().flatten()?)))
            .filter(|(_, writer)| writer.bytes >= RESCUE_MIN_BYTES)
            .max_by_key(|(_, writer)| writer.bytes)
            .map(|(id, writer)| {
                writer.kill();
                (id.clone(), writer.command)
            });
        for (id, handle) in handles {
            let text = match &culprit {
                Some((owner, command)) if *owner == id => {
                    let command: String = command.replace('`', "'").chars().take(160).collect();
                    format!(
                        "Cloudroom: the disk is full, so Cloudroom stopped `{command}`, which was filling it. Free space before continuing: delete files you no longer need, like build output, caches, or node_modules, and check with `df -h`. Do not rerun that command as is.{reading}"
                    )
                }
                _ => format!(
                    "Cloudroom: the disk is full. Work resumes so you can free space: delete files you no longer need, like build output, caches, or node_modules, and check with `df -h`.{reading}"
                ),
            };
            // Recorded now for the user; the agent reads it once the guard loop thaws it.
            if self
                .local
                .lock()
                .unwrap()
                .append(
                    &id,
                    "storage_warning",
                    json!({"text":text,"reason":"rescue"}),
                    None,
                )
                .is_ok()
            {
                tokio::spawn(async move {
                    let _ =
                        tokio::time::timeout(Duration::from_secs(10), handle.system_message(&text))
                            .await;
                });
            }
        }
    }

    /// A stop on a full disk its agent didn't settle within STOP_SETTLES (#606): its turn ends as interrupted, the stop
    /// completes, and the agent ends with everything it runs, then sleeps (`slept`). Its history stays, and its next
    /// message resumes it.
    async fn end_for_stop(self: &Arc<Self>, id: &str, handle: &runtime::Handle) {
        // Frozen first, so the shutdown ends it at once (`Process::request_shutdown`).
        let _ = handle.pause(true).await;
        let mut local = self.local.lock().unwrap();
        let session = &local.sessions[id];
        // A stop that settled meanwhile leaves it paused like the rest.
        if session.releasing
            || !session.interrupt_pending()
            || !(session.handle.as_ref()).is_some_and(|h| h.same_process(handle))
        {
            return;
        }
        let turn = session.current_request.clone();
        let stops: Vec<_> = (session.receipts.values())
            .filter(|r| {
                matches!(r.command.as_str(), "interrupt" | "stop")
                    && matches!(r.state.as_str(), "accepted" | "delivered")
            })
            .map(|r| r.request_id.clone())
            .collect();
        self.release(&mut local, id);
        if let Some(turn) = turn {
            let _ = local.finish_receipt(id, &turn, "interrupted");
        }
        for stop in stops {
            let _ = local.finish_receipt(id, &stop, "completed");
        }
        let _ = local.append(id, "state", json!({"state":SessionState::Idle}), None);
    }

    /// Shared-sandbox children share their parent's memory, and the kernel kills their tools first (exit 137), so they
    /// can retry for an hour while nobody tells the agent that started them (#1619). While any works and the kill
    /// count grows, its parent gets one note as context, at most every 10 minutes (Marko, 2026-11-17).
    pub fn start_memory_guard(self: &Arc<Self>) {
        let manager = self.clone();
        tokio::spawn(async move {
            // The kill count when shared children started working or the last note went out, and when.
            let (mut since, mut noted) = (None, None::<Instant>);
            while !manager.is_stopping() {
                tokio::time::sleep(Duration::from_secs(10)).await;
                let parents: Vec<_> = {
                    let local = manager.local.lock().unwrap();
                    let mut working = BTreeMap::<&str, usize>::new();
                    for child in local.sessions.values().filter(|s| s.busy()) {
                        if let Some(parent) = &child.parent_session {
                            *working.entry(parent).or_default() += 1;
                        }
                    }
                    (working.into_iter())
                        .filter_map(|(id, n)| Some((local.sessions.get(id)?.handle.clone()?, n)))
                        .collect()
                };
                if parents.is_empty() {
                    since = None;
                    continue;
                }
                let Some(kills) = oom_kills() else { continue };
                let (before, at) = *since.get_or_insert((kills, Instant::now()));
                if kills <= before || noted.is_some_and(|at| at.elapsed() < MEMORY_NOTE_EVERY) {
                    continue;
                }
                let (killed, minutes) =
                    (kills - before, at.elapsed().as_secs().div_ceil(60).max(1));
                let plural = if killed == 1 { "" } else { "es" };
                for (handle, children) in parents {
                    let text = format!(
                        "<cloudroom_custom_instructions>\n[Cloudroom] This sandbox ran out of memory: in the last {minutes} min the kernel killed {killed} process{plural} (exit 137) while {children} of your shared-sandbox children worked, so their dev servers, browsers and checks keep dying and retries won't help. Stop some of them (`room-cli thread stop`), or start heavy work in its own sandbox: spawn without --shared-sandbox.\n</cloudroom_custom_instructions>"
                    );
                    let _ =
                        tokio::time::timeout(Duration::from_secs(2), handle.system_message(&text))
                            .await;
                }
                (since, noted) = (Some((kills, Instant::now())), Some(Instant::now()));
            }
        });
    }

    /// Saves history in batches (ADR 0232): when the oldest unsaved record is 30 s old, 1,024 records wait, the
    /// agents go idle, or a drain or stop asks. Failures back off up to a minute; the journal keeps everything.
    /// Going idle saves once: records written while idle (a chatty tool or watcher) wait the 30 s, or a thread
    /// that writes every few seconds makes a file every few seconds (2026-10-23: ~1,000 files an hour). A new
    /// prompt or command re-arms it, even one that finished between two checks.
    pub fn start_uploader(self: &Arc<Self>) {
        if !self.history.saves_externally() {
            return;
        }
        let manager = self.clone();
        tokio::spawn(async move {
            let (mut since, mut failures, mut retry_at, mut faulted, mut settled) =
                (None::<Instant>, 0u32, Instant::now(), false, false);
            let mut commands = 0;
            let (mut compacted, mut compact_at) = (None, Instant::now());
            loop {
                let asked = tokio::select! {
                    _ = manager.uploads.notified() => true,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => false,
                };
                // Apart from uploads: a fully saved journal compacts at startup, and a failed pass retries.
                if COMPACT_HISTORY
                    && Instant::now() >= compact_at
                    && !manager.compact_history(&mut compacted).await
                {
                    compact_at = Instant::now() + Duration::from_secs(60);
                }
                let (pending, idle, seen, report_waits) = {
                    let mut local = manager.local.lock().unwrap();
                    let idle = local.sessions.values().all(|s| !s.busy());
                    let seen: usize = local.sessions.values().map(|s| s.receipts.len()).sum();
                    let saved = local.journal.saved();
                    let pending = if local.loud > saved {
                        local.journal.last() - saved
                    } else {
                        0
                    };
                    (pending, idle, seen, std::mem::take(&mut local.report_waits))
                };
                settled &= idle && seen == commands;
                commands = seen;
                if pending == 0 {
                    since = None;
                    continue;
                }
                let waited = since.get_or_insert_with(Instant::now).elapsed();
                let due = asked
                    || report_waits
                    || pending >= UPLOAD_RECORDS
                    || waited >= UPLOAD_AFTER
                    || (idle && !settled && waited >= Duration::from_secs(2));
                if !due || (!asked && Instant::now() < retry_at) {
                    continue;
                }
                let started = Instant::now();
                // A full disk fails local reads and writes for a while. They back off and retry like a failed upload,
                // so saving resumes once there is space (feedback #669).
                let outcome = match manager.upload_batch() {
                    Err(_) => Err(Some("read_pending")),
                    Ok(batch) => {
                        let result = manager.history.upload(&batch).await;
                        let mut local = manager.local.lock().unwrap();
                        local.database_available = result.is_ok();
                        let ack_failed = result.is_ok()
                            && local
                                .journal
                                .acknowledge(batch.last().unwrap().sequence)
                                .is_err();
                        manager.observability.record(Signal::HistoryUpload {
                            records: batch.len(),
                            pending_records: local.journal.last() - local.journal.saved(),
                            success: result.is_ok(),
                            duration_ms: elapsed_ms(started),
                        });
                        match result {
                            Ok(()) if ack_failed => Err(Some("acknowledge")),
                            Ok(()) => Ok(()),
                            Err(history::ApiError::Conflict) => Err(Some("conflict")),
                            Err(_) => Err(None),
                        }
                    }
                };
                match outcome {
                    Ok(()) => (since, failures, faulted, settled) = (None, 0, false, idle),
                    Err(fault) => {
                        // Once per run of failures, not on every retry.
                        if let Some(operation) = fault.filter(|_| !faulted) {
                            manager
                                .observability
                                .record(Signal::HistoryFault { operation });
                            faulted = true;
                        }
                        failures += 1;
                        // 1, 2, 4 ... 60 s, with up to a second of jitter so a fleet doesn't retry in step.
                        let jitter = u64::from(started.elapsed().subsec_nanos() % 1000);
                        retry_at = Instant::now()
                            + Duration::from_secs(1u64 << failures.min(6))
                                .min(Duration::from_secs(60))
                            + Duration::from_millis(jitter);
                    }
                }
            }
        });
    }

    /// The next batch: the one a restart interrupted, exactly, or up to 4,096 records and 8 MB. Its end is saved before
    /// it is sent, so a retry always resends the same files. Records are read without holding the session lock.
    fn upload_batch(&self) -> io::Result<Vec<Record>> {
        let (directory, saved, last, marked) = {
            let local = self.local.lock().unwrap();
            let journal = &local.journal;
            (
                journal.directory().to_owned(),
                journal.saved(),
                journal.last(),
                journal.uploading(),
            )
        };
        let (mut batch, mut bytes) = (Vec::new(), 0);
        for id in saved + 1..=marked.unwrap_or(last) {
            let raw = outbox::Journal::read_written(&directory, id)?;
            bytes += raw.len();
            batch.push(serde_json::from_slice::<Record>(&raw).map_err(io::Error::other)?);
            if marked.is_none() && (batch.len() >= 4 * UPLOAD_RECORDS as usize || bytes >= 8 << 20)
            {
                break;
            }
        }
        if marked.is_none()
            && let Some(end) = batch.last().map(|r| r.sequence)
        {
            self.local.lock().unwrap().journal.begin_upload(end)?;
        }
        Ok(batch)
    }

    /// One bounded compaction pass when a whole block is saved past `next` (`Journal::compact`). False if it failed.
    async fn compact_history(&self, next: &mut Option<u64>) -> bool {
        let (directory, saved) = {
            let local = self.local.lock().unwrap();
            (local.journal.directory().to_owned(), local.journal.saved())
        };
        if next.is_some_and(|block| (block + 1) * outbox::SEGMENT > saved) {
            return true;
        }
        let mut block = *next;
        let pass = tokio::task::spawn_blocking(move || {
            let result = outbox::Journal::compact(&directory, &mut block, saved);
            (block, result)
        })
        .await;
        let result = pass.map(|(block, result)| {
            *next = block;
            result
        });
        if let Ok(Err(error)) = &result {
            eprintln!("Cloudroom could not compact saved history: {error}");
        }
        matches!(result, Ok(Ok(())))
    }

    /// Waits up to `wait` for every record written so far that needs an upload to be saved, not for ones written
    /// meanwhile, which a chatty thread never stops making. Returns how many are still pending. A `patient` flush lets
    /// the uploader's own upload come first, asking only after 3 s and never past its backoff, and leaves it alone
    /// once an upload fails.
    pub async fn flush_history(&self, wait: Duration, patient: bool) -> u64 {
        let start = Instant::now();
        let ask_after = Duration::from_secs(if patient { 3 } else { 0 });
        let target = self.local.lock().unwrap().loud;
        let mut asked_at = None::<Instant>;
        loop {
            let (saved, last, failing) = {
                let local = self.local.lock().unwrap();
                (
                    local.journal.saved(),
                    local.journal.last(),
                    !local.database_available,
                )
            };
            if saved >= target
                || !self.history.saves_externally()
                || start.elapsed() >= wait
                || (patient && failing)
            {
                return last - saved;
            }
            if start.elapsed() >= ask_after
                && asked_at.is_none_or(|at| at.elapsed() >= Duration::from_secs(2))
            {
                if patient {
                    self.local.lock().unwrap().report_waits = true;
                } else {
                    self.uploads.notify_one();
                }
                asked_at = Some(Instant::now());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
