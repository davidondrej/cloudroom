use cloudroom::{config::Config, runtime};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture() -> (Directory, Config) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = Directory(std::env::temp_dir().join(format!(
        "cloudroom-runtime-{}-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    fs::create_dir_all(dir.0.join(".codex")).unwrap();
    let config = Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        token: String::new(),
        state_dir: dir.0.join("state"),
        repository: dir.0.clone(),
        api_url: Some("http://127.0.0.1:1".into()),
        store: "fixture".into(),
        instance: None,
        account_home: dir.0.clone(),
        default_harness: runtime::Kind::Codex,
        harnesses: [(
            runtime::Kind::Codex,
            cloudroom::config::HarnessConfig {
                binary: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/core_fixture.py"),
                home: dir.0.join(".codex"),
                model: "fixture".into(),
                provider: None,
            },
        )]
        .into(),
        storage: None,
        rpc_timeout: Duration::from_secs(30),
        diagnostic_upload: Duration::from_secs(1),
    };
    (dir, config)
}

async fn capture_stderr(script: &str, shutdown: bool) -> runtime::ExitDetails {
    let (dir, mut config) = fixture();
    let binary = dir.0.join("stderr-harness");
    fs::write(
        &binary,
        format!("#!/usr/bin/env python3\nimport os, sys, time, signal\n{script}\n"),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    config
        .harnesses
        .get_mut(&runtime::Kind::Codex)
        .unwrap()
        .binary = binary;
    let (handle, mut events) = runtime::Handle::spawn(&config, runtime::Kind::Codex, None).unwrap();
    if shutdown {
        handle.request_shutdown();
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(event) = events.recv().await {
            if let runtime::Event::Exited {
                details, expected, ..
            } = event
            {
                assert_eq!(expected, shutdown);
                return details;
            }
        }
        panic!("missing exit details");
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn harness_commits_drop_ai_co_authors_and_keep_human_ones() {
    let script = r#"import subprocess, tempfile
repo = tempfile.mkdtemp()
git = lambda *args: subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout
git("init", "-q")
open(repo + "/file.txt", "w").write("content\n")
git("add", "file.txt")
git("-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "-q", "--no-verify", "-m", "Add file", "-m",
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nCo-authored-by: Cursor <cursoragent@cursor.com>\nCo-authored-by: Ada Lovelace <ada@example.com>")
os.write(2, git("log", "-1", "--format=%B").encode())
os._exit(0)"#;
    let details = capture_stderr(script, false).await;
    assert_eq!(
        String::from_utf8_lossy(details.stderr()).trim(),
        "Add file\n\nCo-authored-by: Ada Lovelace <ada@example.com>"
    );
}

#[tokio::test]
async fn stderr_keeps_bounded_final_bytes_and_separates_concurrent_harnesses() {
    let mut tasks = tokio::task::JoinSet::new();
    for n in 0..4 {
        tasks.spawn(async move {
            let marker = format!("PRIVATE-STDERR-{n}");
            let script = format!(
                "data = b'x' * (1024 * 1024) + b'\\xff\\x00' + {marker:?}.encode()\nwhile data:\n n = os.write(2, data); data = data[n:]\nos._exit(42)"
            );
            let details = capture_stderr(&script, false).await;
            assert_eq!((details.code, details.signal), (Some(42), None));
            assert!(details.stderr_complete);
            assert_eq!(details.stderr_bytes, (1024 * 1024 + 2 + marker.len()) as u64);
            let expected = [vec![b'x'; 16 * 1024 - 2 - marker.len()], vec![0xff, 0], marker.into_bytes()].concat();
            assert_eq!(details.stderr(), expected);
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap();
    }
}

#[tokio::test]
async fn stderr_survives_stdout_eof_signals_and_clean_shutdown() {
    for (script, shutdown, code, signal) in [
        (
            "os.close(1)\ntime.sleep(.05)\nos.write(2, b'FINAL')\nos._exit(42)",
            false,
            Some(42),
            None,
        ),
        (
            "os.write(2, b'FINAL')\nos.kill(os.getpid(), signal.SIGTERM)",
            false,
            None,
            Some(15),
        ),
        (
            "sys.stdin.buffer.read()\nos.write(2, b'FINAL')",
            true,
            Some(0),
            None,
        ),
    ] {
        let details = capture_stderr(script, shutdown).await;
        assert_eq!((details.code, details.signal), (code, signal));
        assert_eq!(details.stderr(), b"FINAL");
        assert!(details.stderr_complete);
    }
}

#[tokio::test]
async fn inherited_stderr_cannot_hold_exit_and_marks_capture_incomplete() {
    let details = capture_stderr(
        "if os.fork() == 0:\n time.sleep(2); os._exit(0)\nos.write(2, b'BEFORE-EXIT')\nos._exit(42)",
        false,
    ).await;
    // Allow the synthetic orphan to finish before this test returns, even on assertion failure.
    tokio::time::sleep(Duration::from_millis(2100)).await;
    assert_eq!(details.code, Some(42));
    assert_eq!(details.stderr(), b"BEFORE-EXIT");
    assert!(!details.stderr_complete);
}

#[test]
fn native_recovery_rejects_links_and_special_files_but_reads_valid_history() {
    use std::os::unix::fs::symlink;
    let (dir, config) = fixture();
    let profile = &config.harnesses[&runtime::Kind::Codex];
    let root = profile.home.join("sessions");
    fs::create_dir(&root).unwrap();
    let outside = dir.0.join("service-secret");
    fs::write(&outside, "SYNTHETIC_PROTECTED_SECRET\n").unwrap();
    let capture = |path: PathBuf| {
        let saved = runtime::Resume {
            id: "fixture".into(),
            path,
            cursor: serde_json::json!({"offset":0}),
            model: None,
            provider: None,
            reasoning: None,
        };
        let mut contents = String::new();
        let result =
            runtime::recover_records(profile, runtime::Kind::Codex, &saved, None, |event| {
                if let runtime::Event::Record {
                    native: Some(raw), ..
                } = event
                {
                    contents.push_str(&raw);
                }
                Ok(())
            });
        (result, contents)
    };
    let valid = root.join("valid.jsonl");
    fs::write(&valid, "{\"safe\":true}\n").unwrap();
    let (result, contents) = capture(valid);
    result.unwrap();
    assert_eq!(contents, "{\"safe\":true}\n");
    let linked = root.join("linked.jsonl");
    symlink(&outside, &linked).unwrap();
    let ancestor = root.join("ancestor");
    symlink(&dir.0, &ancestor).unwrap();
    let fifo = root.join("fifo");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    for path in [
        outside,
        linked,
        ancestor.join("service-secret"),
        fifo,
        root.clone(),
    ] {
        let (result, contents) = capture(path);
        assert!(result.is_err(), "unsafe history was accepted");
        assert!(contents.is_empty(), "unsafe bytes were emitted");
    }
}

#[tokio::test]
async fn workload_cleanup_requires_confirmed_empty_group() {
    let (dir, mut config) = fixture();
    let root = dir.0.join("agents");
    fs::create_dir(&root).unwrap();
    // Controlled kernel-file responses; real cgroup containment is a Linux E2E check.
    fs::write(root.join("cgroup.events"), "populated 1\n").unwrap();
    config.storage = Some(cloudroom::workspace::storage::Policy {
        agent_uid: 1,
        agent_gid: 1,
        cache_dir: dir.0.join("cache"),
        cgroup_root: Some(root.clone()),
        agent_sudo: false,
        warning_bytes: 5,
        pause_bytes: 2,
        resume_bytes: 3,
    });
    let caller = config.clone();
    let cleanup = tokio::spawn(async move { runtime::reconcile(&caller).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fs::read_to_string(root.join("cgroup.kill")).unwrap(), "1");
    assert!(
        !cleanup.is_finished(),
        "kill submission is not proof of exit"
    );
    fs::write(root.join("cgroup.events"), "populated 0\n").unwrap();
    cleanup.await.unwrap().unwrap();
    fs::write(root.join("cgroup.events"), "populated 1\n").unwrap();
    assert!(
        runtime::reconcile(&config).await.is_err(),
        "live group must time out, never permit replacement"
    );
    fs::remove_file(root.join("cgroup.kill")).unwrap();
    fs::create_dir(root.join("cgroup.kill")).unwrap();
    assert!(
        runtime::reconcile(&config).await.is_err(),
        "failed kill must not permit replacement"
    );
}

#[tokio::test]
async fn unresponsive_harness_is_not_reported_as_cleanly_closed() {
    let (_dir, config) = fixture();
    let (handle, mut events) = runtime::Handle::spawn(&config, runtime::Kind::Codex, None).unwrap();
    let exited = tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            if let runtime::Event::Exited {
                expected, reason, ..
            } = event
            {
                return (expected, reason);
            }
        }
        panic!("missing process exit record");
    });
    handle.start_session().await.unwrap();
    handle.send("hang", "hang").await.unwrap();
    handle.request_shutdown();
    let result = tokio::time::timeout(Duration::from_secs(6), exited)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result, (false, "harness shutdown timed out"));
}

#[tokio::test]
async fn turn_notifications_survive_both_rpc_reply_orders() {
    let (_dir, config) = fixture();
    let (handle, mut events) = runtime::Handle::spawn(&config, runtime::Kind::Codex, None).unwrap();
    handle.start_session().await.unwrap();
    for text in ["reply-first", "finish-first", "events-first"] {
        handle.send(text, text).await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            let mut started = None;
            while let Some(event) = events.recv().await {
                match event {
                    runtime::Event::Started { request: id, .. } => {
                        assert!(started.is_none());
                        started = Some(id);
                    }
                    runtime::Event::Finished {
                        request: id,
                        status,
                        ..
                    } => {
                        assert_eq!(started.as_deref(), Some(id.as_str()));
                        assert_eq!(status, "completed");
                        return;
                    }
                    _ => {}
                }
            }
            panic!("missing turn notifications");
        })
        .await
        .unwrap();
    }
    handle.request_shutdown();
    tokio::time::timeout(Duration::from_secs(6), async {
        while events.recv().await.is_some() {}
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn resume_reattaches_and_continues_the_native_rollout() {
    let (_dir, config) = fixture();
    // First run: start, take a turn, capture the native rollout bytes, then stop.
    let (handle, mut events) = runtime::Handle::spawn(&config, runtime::Kind::Codex, None).unwrap();
    let native = handle.start_session().await.unwrap();
    handle.send("hello", "hello").await.unwrap();
    handle.request_shutdown();
    let mut offset = 0u64;
    let mut path = None;
    tokio::time::timeout(Duration::from_secs(6), async {
        while let Some(event) = events.recv().await {
            match event {
                runtime::Event::Record {
                    kind: "native_record",
                    data,
                    native: Some(raw),
                } => {
                    assert_eq!(data["offset"].as_u64(), Some(offset));
                    offset += raw.len() as u64;
                }
                runtime::Event::Record {
                    kind: "native_identity",
                    data,
                    ..
                } => path = data["path"].as_str().map(PathBuf::from),
                runtime::Event::Exited { .. } => break,
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let path = path.expect("native path");
    let first_offset = offset;
    assert!(first_offset > 0);

    // Resume seeded at the captured offset: only new appends, contiguously numbered.
    let (handle, mut events) = runtime::Handle::spawn(
        &config,
        runtime::Kind::Codex,
        Some(runtime::Resume {
            id: native.clone(),
            path,
            cursor: serde_json::json!({"offset":first_offset}),
            model: None,
            provider: None,
            reasoning: None,
        }),
    )
    .unwrap();
    assert_eq!(handle.start_session().await.unwrap(), native);
    handle.send("again", "again").await.unwrap();
    handle.request_shutdown();
    let mut resumed = Vec::new();
    tokio::time::timeout(Duration::from_secs(6), async {
        while let Some(event) = events.recv().await {
            match event {
                runtime::Event::Record {
                    kind: "native_record",
                    data,
                    native: Some(raw),
                } => resumed.push((data["offset"].as_u64().unwrap(), raw)),
                runtime::Event::Exited { .. } => break,
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert!(!resumed.is_empty(), "resume captured no new rollout");
    let mut expect = first_offset;
    for (recorded, raw) in &resumed {
        assert_eq!(
            *recorded, expect,
            "resumed rollout offset is not contiguous"
        );
        expect += raw.len() as u64;
    }
}

#[tokio::test]
async fn dropping_the_last_handle_stops_its_tools() {
    check_shutdown("drop").await;
}

#[tokio::test]
async fn shutdown_cancels_pending_commands_as_uncertain() {
    let (dir, config) = fixture();
    let (handle, mut events) = runtime::Handle::spawn(&config, runtime::Kind::Codex, None).unwrap();
    let drained = tokio::spawn(async move { while events.recv().await.is_some() {} });
    handle.start_session().await.unwrap();
    let caller = handle.clone();
    let pending = tokio::spawn(async move { caller.send("pending", "no-reply").await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !dir.0.join("no-reply").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    handle.request_shutdown();
    let error = tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::Other);
    assert!(error.to_string().contains("uncertain"));
    tokio::time::timeout(Duration::from_secs(3), drained)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn shutdown_stops_tools_and_records_the_final_native_tail() {
    check_shutdown("fixture").await;
}

#[tokio::test]
async fn stdout_eof_does_not_cut_short_tool_cleanup() {
    check_shutdown("slow-exit").await;
}

async fn check_shutdown(model: &str) {
    let (dir, mut config) = fixture();
    config
        .harnesses
        .get_mut(&runtime::Kind::Codex)
        .unwrap()
        .model = model.into();
    let (handle, mut incoming) =
        runtime::Handle::spawn(&config, runtime::Kind::Codex, None).unwrap();
    let records = tokio::spawn(async move {
        let mut native = String::new();
        let mut expected = None;
        let mut identities = Vec::new();
        while let Some(event) = incoming.recv().await {
            match event {
                runtime::Event::Record {
                    kind: "native_identity",
                    data,
                    native,
                } => {
                    assert!(native.is_none());
                    identities.push(data);
                }
                runtime::Event::Record {
                    kind,
                    data,
                    native: Some(raw),
                } => {
                    if kind == "native_record" {
                        native.push_str(&raw);
                    } else {
                        assert!(
                            data.get("value").is_none(),
                            "duplicated native params in storage payload"
                        );
                    }
                }
                runtime::Event::Exited {
                    expected: status, ..
                } => expected = Some(status),
                _ => {}
            }
        }
        (native, expected, identities)
    });
    let native_id = handle.start_session().await.unwrap();
    handle.send("hold", "hold").await.unwrap();
    let ticks = dir.0.join(format!("{native_id}.ticks"));
    tokio::time::timeout(Duration::from_secs(5), async {
        while !ticks.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    if model == "drop" {
        drop(handle);
    } else {
        handle.request_shutdown();
    }
    let (captured, expected, identities) = tokio::time::timeout(Duration::from_secs(6), records)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(expected, Some(true));
    assert!(identities.contains(&serde_json::json!({"id":native_id,"path":config.harnesses[&runtime::Kind::Codex].home.join("sessions").join(format!("{native_id}.jsonl"))})));
    let pid = fs::read_to_string(dir.0.join(format!("{native_id}.pid"))).unwrap();
    assert!(
        !Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .output()
            .unwrap()
            .status
            .success(),
        "tool process survived shutdown"
    );
    let before = fs::read_to_string(&ticks).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        before,
        fs::read_to_string(&ticks).unwrap(),
        "tool kept writing after shutdown completed"
    );
    assert!(
        captured.contains("shutdown"),
        "missing final native rollout record"
    );
    assert_eq!(
        captured,
        fs::read_to_string(
            config.harnesses[&runtime::Kind::Codex]
                .home
                .join("sessions")
                .join(format!("{native_id}.jsonl"))
        )
        .unwrap()
    );
}

#[test]
fn command_guard_blocks_common_dangerous_variants() {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/runtime/command-guard.mjs");
    let script = r#"
const { checkCommand } = await import("file://" + process.argv[1]);
for (const command of [
  "dd of=/dev/xvda",
  "dd of=/dev/mmcblk0",
  "echo x>/dev/xvda",
  "echo x>/dev/mmcblk0",
  "sudo -n rm -rf /",
  "sudo -- rm -rf /",
  "command -- rm -rf /",
  "mke2fs /dev/sda",
]) {
  if (checkCommand(command) === null) throw new Error(`Allowed dangerous command: ${command}`);
}
for (const command of ["command -v mkfs", "command -V mke2fs", "sudo " + "-- ".repeat(26) + "true"]) {
  const started = performance.now();
  if (checkCommand(command) !== null) throw new Error(`Blocked safe command: ${command}`);
  if (performance.now() - started > 1000) throw new Error(`Slow check: ${command}`);
}
"#;
    let output = Command::new("node")
        .args(["--input-type=module", "-e", script])
        .arg(source)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
