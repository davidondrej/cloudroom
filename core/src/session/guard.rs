//! Background loops: the disk safety guard and the history uploader.
use super::*;
use crate::workspace::storage::FRESH;

/// How long work stays frozen before Cloudroom stops the command filling the disk.
const RESCUE_AFTER: Duration = Duration::from_secs(30);
/// A command that wrote less than this is not filling the disk, so it is never stopped.
const RESCUE_MIN_BYTES: u64 = 32_000_000;
/// History uploads wait this long for more records, so a busy session sends one file per half minute.
const UPLOAD_AFTER: Duration = Duration::from_secs(30);
/// ...unless this many records wait already.
const UPLOAD_RECORDS: u64 = 1024;

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
            let mut measured = Instant::now();
            while !manager.is_stopping() {
                let snapshot = manager.check_storage().await;
                if measured.elapsed() > FRESH {
                    let gap_ms = elapsed_ms(measured);
                    manager
                        .observability
                        .record(Signal::StorageStale { gap_ms });
                }
                measured = Instant::now();
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
                            } else if snapshot.level == Level::Blocked {
                                "Cloudroom: the disk is almost full, so work is paused. If space does not recover within 30 seconds, Cloudroom stops the command filling it. Your files and history are preserved."
                            } else {
                                "Cloudroom: disk space is running low. Work and sync continue. Delete files you no longer need; if the disk fills, Cloudroom pauses work and stops the command filling it."
                            };
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
                                    handle.system_message(text),
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
                    let handles: Vec<_> = manager
                        .local
                        .lock()
                        .unwrap()
                        .sessions
                        .values()
                        .filter_map(|s| s.handle.clone().map(|h| (s.session_id.clone(), h)))
                        .collect();
                    let mut all_paused = manager.storage.pause_writers(true).await.is_ok();
                    for (id, handle) in handles {
                        if handle.pause(true).await.is_ok() {
                            let mut local = manager.local.lock().unwrap();
                            if !local.sessions[&id].storage_paused {
                                let _ = local.append(
                                        &id,
                                        "storage_pause",
                                        json!({"paused":true,"reason":snapshot.reason,"text":if snapshot.reason == "measurement_unavailable" {
                                            "Cloudroom: disk space could not be measured. Work is paused until storage can be verified."
                                        } else {
                                            "Cloudroom: work paused because the disk is almost full. If space does not recover within 30 seconds, Cloudroom stops the command filling it."
                                        }}),
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
                        manager.rescue().await;
                        blocked_since = None;
                    }
                    was_blocked = true;
                } else if was_blocked
                    || (snapshot.level == Level::Normal && manager.has_storage_warning())
                {
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
    async fn rescue(&self) {
        if !self.storage.rescue() {
            return;
        }
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
                        "Cloudroom: the disk is full, so Cloudroom stopped `{command}`, which was filling it. Free space before continuing: delete files you no longer need, like build output, caches, or node_modules, and check with `df -h`. Do not rerun that command as is."
                    )
                }
                _ => "Cloudroom: the disk is full. Work resumes so you can free space: delete files you no longer need, like build output, caches, or node_modules, and check with `df -h`.".into(),
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
            loop {
                let asked = tokio::select! {
                    _ = manager.uploads.notified() => true,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => false,
                };
                let (pending, idle, seen) = {
                    let local = manager.local.lock().unwrap();
                    let idle = local.sessions.values().all(|s| !s.busy());
                    let seen: usize = local.sessions.values().map(|s| s.receipts.len()).sum();
                    (local.journal.last() - local.journal.saved(), idle, seen)
                };
                settled &= idle && seen == commands;
                commands = seen;
                if pending == 0 {
                    since = None;
                    continue;
                }
                let waited = since.get_or_insert_with(Instant::now).elapsed();
                let due = asked
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

    /// Uploads now and waits up to `wait` for every record to be saved. Returns how many are still pending.
    pub async fn flush_history(&self, wait: Duration) -> u64 {
        let deadline = Instant::now() + wait;
        let mut asked_at = None::<Instant>;
        loop {
            let pending = {
                let local = self.local.lock().unwrap();
                local.journal.last() - local.journal.saved()
            };
            if pending == 0 || !self.history.saves_externally() || Instant::now() >= deadline {
                return pending;
            }
            if asked_at.is_none_or(|at| at.elapsed() >= Duration::from_secs(2)) {
                self.uploads.notify_one();
                asked_at = Some(Instant::now());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
