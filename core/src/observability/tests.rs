use super::*;
use std::os::unix::fs::PermissionsExt;

struct Directory(std::path::PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "cloudroom-diagnostics-{:x}",
            RandomState::new().hash_one(SystemTime::now())
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn local_rotation_preserves_the_previous_file_with_private_permissions() {
    let directory = Directory::new();
    write_local(&directory.0, b"first\n", 12).unwrap();
    write_local(&directory.0, b"second\n", 12).unwrap();
    assert_eq!(
        fs::read(directory.0.join("diagnostics.previous.jsonl")).unwrap(),
        b"first\n"
    );
    assert_eq!(
        fs::read(directory.0.join("diagnostics.jsonl")).unwrap(),
        b"second\n"
    );
    write_local(&directory.0, b"third\n", 12).unwrap();
    assert_eq!(
        fs::read(directory.0.join("diagnostics.previous.jsonl")).unwrap(),
        b"second\n"
    );
    for file in fs::read_dir(&directory.0).unwrap() {
        assert_eq!(
            file.unwrap().metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn api_outage_keeps_local_diagnostics_and_overload_is_visible() {
    let directory = Directory::new();
    let config = Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        token: String::new(),
        state_dir: directory.0.clone(),
        repository: directory.0.clone(),
        api_url: Some("http://127.0.0.1:1".into()),
        store: "test".into(),
        instance: None,
        account_home: directory.0.clone(),
        default_harness: crate::runtime::Kind::Codex,
        harnesses: [(
            crate::runtime::Kind::Codex,
            crate::config::HarnessConfig {
                binary: "/bin/false".into(),
                home: directory.0.clone(),
                model: "fixture".into(),
                provider: None,
            },
        )]
        .into(),
        storage: None,
        rpc_timeout: Duration::from_secs(30),
        diagnostic_upload: Duration::from_secs(1),
    };
    // Nothing listens on port 1: every upload fails, as in an outage.
    let api = crate::session::history::History::new(&config).unwrap().api;
    let diagnostics = Observability::start(&config, api, metrics::AgentCounts::default);
    // No await: the producer must neither block nor allocate an unbounded queue.
    for _ in 0..CAPACITY * 2 {
        diagnostics.record(Signal::HistoryFault { operation: "test" });
    }
    let path = directory.0.join("diagnostics.jsonl");
    let records = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(text) = fs::read_to_string(&path) {
                let records: Result<Vec<serde_json::Value>, _> =
                    text.lines().map(serde_json::from_str).collect();
                if let Ok(records) = records
                    && records.iter().any(|r| r["kind"] == "diagnostics")
                {
                    break records;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|r| r["kind"] == "history_fault")
            .count(),
        CAPACITY
    );
    assert!(
        records.iter().any(
            |r| r["kind"] == "diagnostics" && r["dropped"].as_u64().unwrap() >= CAPACITY as u64
        )
    );
    let marker = b"SYNTHETIC-PRIVATE-CREDENTIAL";
    for _ in 0..STDERR_CAPACITY * 2 {
        diagnostics.agent_exit(
            Some("fixture"),
            Kind::Codex,
            "harness process exited",
            false,
            ExitDetails {
                cause: None,
                code: Some(42),
                signal: None,
                killed: false,
                stderr_bytes: marker.len() as u64,
                stderr_complete: true,
                stderr: marker.to_vec(),
            },
        );
    }
    // The current-thread producer never yielded: exactly one bounded private queue fits.
    assert_eq!(diagnostics.stderr.capacity(), 0);
    assert!(diagnostics.dropped.load(Ordering::Relaxed) >= (CAPACITY + STDERR_CAPACITY) as u64);
    diagnostics.shutdown().await;
    let captures =
        fs::read_to_string(directory.0.join("harness-diagnostics/stderr.jsonl")).unwrap();
    assert_eq!(captures.lines().count(), STDERR_CAPACITY);
    assert!(captures.contains(std::str::from_utf8(marker).unwrap()));
    // These Record values are also the only type accepted by the PostgreSQL pending buffer.
    let public = fs::read_to_string(path).unwrap();
    assert!(!public.contains(std::str::from_utf8(marker).unwrap()));
    assert!(!public.contains("\"stderr\":"));
    for line in captures.lines() {
        let private: Value = serde_json::from_str(line).unwrap();
        assert!(
            public
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .any(|record| record["run_id"] == private["run_id"]
                    && record["sequence"] == private["sequence"]
                    && record["exit_code"] == 42)
        );
    }
}

#[test]
fn private_stderr_rotation_counts_encoded_bytes_and_keeps_two_private_files() {
    let directory = Directory::new();
    for sequence in 0..32 {
        write_stderr(
            &directory.0,
            vec![LocalStderr {
                metadata: json!({"sequence":sequence}),
                bytes: vec![0; 16 * 1024],
            }],
        )
        .unwrap();
    }
    let private = directory.0.join("harness-diagnostics");
    assert_eq!(
        fs::metadata(&private).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let files: Vec<_> = fs::read_dir(&private).unwrap().collect();
    assert_eq!(files.len(), 2);
    for entry in files {
        let path = entry.unwrap().path();
        let metadata = fs::metadata(&path).unwrap();
        assert!(metadata.len() <= STDERR_FILE_BYTES);
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        for line in fs::read_to_string(path).unwrap().lines() {
            let record: Value = serde_json::from_str(line).unwrap();
            assert_eq!(
                record["stderr"].as_str().unwrap().as_bytes(),
                vec![0; 16 * 1024]
            );
        }
    }
    let current = fs::read_to_string(private.join("stderr.jsonl")).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(current.lines().last().unwrap()).unwrap()["sequence"],
        31
    );
}

#[test]
fn private_stderr_rejects_unsafe_existing_paths_without_touching_targets() {
    use std::os::unix::fs::symlink;
    for case in [
        "directory-link",
        "directory-mode",
        "file-link",
        "hardlink",
        "file-mode",
        "fifo",
    ] {
        let directory = Directory::new();
        let private = directory.0.join("harness-diagnostics");
        let target = directory.0.join("target");
        fs::write(&target, b"UNCHANGED").unwrap();
        if case == "directory-link" {
            symlink(&directory.0, &private).unwrap();
        } else {
            fs::DirBuilder::new().mode(0o700).create(&private).unwrap();
            let path = private.join("stderr.jsonl");
            match case {
                "directory-mode" => {
                    fs::set_permissions(&private, fs::Permissions::from_mode(0o755)).unwrap()
                }
                "file-link" => symlink(&target, &path).unwrap(),
                "hardlink" => {
                    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
                    fs::hard_link(&target, &path).unwrap();
                }
                "file-mode" => {
                    fs::write(&path, b"UNCHANGED").unwrap();
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
                }
                "fifo" => assert!(
                    std::process::Command::new("mkfifo")
                        .arg(&path)
                        .status()
                        .unwrap()
                        .success()
                ),
                _ => unreachable!(),
            }
        }
        assert!(
            write_stderr(
                &directory.0,
                vec![LocalStderr {
                    metadata: json!({}),
                    bytes: b"PRIVATE".to_vec(),
                }]
            )
            .is_err(),
            "accepted {case}"
        );
        assert_eq!(fs::read(&target).unwrap(), b"UNCHANGED");
    }
}
