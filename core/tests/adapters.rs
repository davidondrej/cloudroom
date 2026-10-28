use cloudroom::{
    config::{Config, HarnessConfig},
    runtime::{self, Event, Kind},
};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Fixture {
    root: PathBuf,
    config: Config,
}
impl Fixture {
    fn new(kind: Kind) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "cloudroom-adapter-{}-{}-{:?}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            kind,
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("agent")).unwrap();
        let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(if kind == Kind::Pi {
            "tests/pi_fixture.py"
        } else {
            "tests/core_fixture.py"
        });
        let config = Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            token: String::new(),
            state_dir: root.join("state"),
            repository: root.clone(),
            api_url: Some("http://127.0.0.1:1".into()),
            store: "test".into(),
            instance: None,
            account_home: root.clone(),
            default_harness: kind,
            harnesses: [(
                kind,
                HarnessConfig {
                    binary,
                    home: root.join("agent"),
                    model: "fixture".into(),
                    provider: (kind == Kind::Pi).then(|| "fixture".into()),
                },
            )]
            .into(),
            storage: None,
            rpc_timeout: Duration::from_secs(30),
            diagnostic_upload: Duration::from_secs(1),
        };
        Self { root, config }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn both_harnesses_obey_request_and_shutdown_contract() {
    for kind in [Kind::Codex, Kind::Pi] {
        let fixture = Fixture::new(kind);
        let (handle, mut events) = runtime::Handle::spawn(&fixture.config, kind, None).unwrap();
        let native = handle.start_session().await.unwrap();
        assert!(!native.is_empty());
        handle.send("first", "hello").await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut started = false;
            while let Some(event) = events.recv().await {
                match event {
                    Event::Started { request, .. } => {
                        assert_eq!(request, "first");
                        assert!(!started);
                        started = true;
                    }
                    Event::Finished {
                        request, status, ..
                    } => {
                        assert!(started);
                        assert_eq!((request.as_str(), status.as_str()), ("first", "completed"));
                        return;
                    }
                    _ => {}
                }
            }
            panic!("missing completion");
        })
        .await
        .unwrap();
        handle
            .system_message("Storage warning: no extra task")
            .await
            .unwrap();
        handle.request_shutdown();
        tokio::time::timeout(Duration::from_secs(6), async {
            while let Some(event) = events.recv().await {
                match event {
                    Event::Started { .. } => panic!("notice started an extra request"),
                    Event::Exited {
                        expected,
                        cleaned_up,
                        ..
                    } => {
                        assert!(expected && cleaned_up);
                        return;
                    }
                    _ => {}
                }
            }
            panic!("missing exit");
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn pi_waits_through_retry_and_preserves_tool_snapshots() {
    let fixture = Fixture::new(Kind::Pi);
    let (handle, mut events) = runtime::Handle::spawn(&fixture.config, Kind::Pi, None).unwrap();
    handle.start_session().await.unwrap();
    handle.send("retry", "retry").await.unwrap();
    let started = std::time::Instant::now();
    let mut starts = 0;
    let mut snapshots = Vec::new();
    let mut updates = Vec::new();
    tokio::time::timeout(Duration::from_secs(4), async {
        while let Some(event) = events.recv().await {
            match event {
                Event::Started { request, .. } => {
                    assert_eq!(request, "retry");
                    starts += 1;
                }
                // Tool-call chunks and per-chunk usage are never recorded.
                Event::Record { data, .. } if data["type"] == "message_update" => {
                    assert!(data["usage"].is_null());
                    updates.push(data["delta"].as_str().unwrap().to_owned());
                }
                Event::Record {
                    kind: "tool_snapshot",
                    data,
                    native,
                } => {
                    assert!(native.is_some());
                    snapshots.push(
                        data["output"]["content"][0]["text"]
                            .as_str()
                            .unwrap()
                            .to_owned(),
                    );
                }
                Event::Finished {
                    request, status, ..
                } => {
                    assert_eq!(request, "retry");
                    assert_eq!(status, "completed");
                    return;
                }
                _ => {}
            }
        }
        panic!("missing completion");
    })
    .await
    .unwrap();
    assert!(started.elapsed() >= Duration::from_millis(250));
    assert_eq!(starts, 1);
    assert_eq!(snapshots, ["one", "one two"]);
    assert_eq!(updates, ["hi"]);
    handle.request_shutdown();
    tokio::time::timeout(Duration::from_secs(6), async {
        while events.recv().await.is_some() {}
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn pi_handles_no_run_dialogs_rejection_and_failure() {
    let fixture = Fixture::new(Kind::Pi);
    let (handle, mut events) = runtime::Handle::spawn(&fixture.config, Kind::Pi, None).unwrap();
    handle.start_session().await.unwrap();
    for (text, status) in [
        ("handled", "completed"),
        ("dialog", "completed"),
        ("failure", "failed"),
    ] {
        handle.send(text, text).await.unwrap();
        let mut cancelled = false;
        tokio::time::timeout(Duration::from_secs(4), async {
            while let Some(event) = events.recv().await {
                match event {
                    Event::Record {
                        kind: "interaction_cancelled",
                        ..
                    } => cancelled = true,
                    Event::Finished {
                        request,
                        status: outcome,
                        ..
                    } => {
                        assert_eq!(request, text);
                        assert_eq!(outcome, status);
                        return;
                    }
                    _ => {}
                }
            }
            panic!("handled input did not settle");
        })
        .await
        .unwrap();
        assert_eq!(cancelled, text == "dialog");
    }
    assert_eq!(
        handle.send("reject", "reject").await.unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
    handle.request_shutdown();
    tokio::time::timeout(Duration::from_secs(6), async {
        while events.recv().await.is_some() {}
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn pi_native_identity_exists_before_first_prompt_and_resume_never_creates_missing_file() {
    let fixture = Fixture::new(Kind::Pi);
    let (handle, mut events) = runtime::Handle::spawn(&fixture.config, Kind::Pi, None).unwrap();
    let native = handle.start_session().await.unwrap();
    handle.request_shutdown();
    let mut path = None;
    let mut cursor = serde_json::Value::Null;
    tokio::time::timeout(Duration::from_secs(6), async {
        while let Some(event) = events.recv().await {
            match event {
                Event::Record {
                    kind: "native_identity",
                    data,
                    ..
                } => path = data["path"].as_str().map(PathBuf::from),
                Event::Record {
                    kind: "native_record",
                    data,
                    native,
                } => {
                    cursor =
                        runtime::checkpoint(Kind::Pi, &cursor, &data, native.as_deref()).unwrap()
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let path = path.unwrap();
    assert!(path.exists());
    let original = fs::read_to_string(&path).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(original.lines().next().unwrap()).unwrap()["id"],
        native
    );
    let saved = runtime::Resume {
        id: native.clone(),
        path: path.clone(),
        cursor,
        model: None,
        provider: None,
        reasoning: None,
    };
    let (handle, mut events) =
        runtime::Handle::spawn(&fixture.config, Kind::Pi, Some(saved.clone())).unwrap();
    assert_eq!(handle.start_session().await.unwrap(), native);
    handle.request_shutdown();
    tokio::time::timeout(Duration::from_secs(6), async {
        while events.recv().await.is_some() {}
    })
    .await
    .unwrap();
    fs::remove_file(&path).unwrap();
    assert!(runtime::Handle::spawn(&fixture.config, Kind::Pi, Some(saved.clone())).is_err());
    assert!(!path.exists());
    fs::write(&path, "not a session\n").unwrap();
    assert!(runtime::Handle::spawn(&fixture.config, Kind::Pi, Some(saved.clone())).is_err());
    fs::write(&path, original.replace(&native, "wrong-native-id")).unwrap();
    assert!(runtime::Handle::spawn(&fixture.config, Kind::Pi, Some(saved)).is_err());
}

#[tokio::test]
async fn both_harnesses_drain_large_native_history_before_exit() {
    use std::io::Write;
    for kind in [Kind::Codex, Kind::Pi] {
        let fixture = Fixture::new(kind);
        let (handle, mut events) = runtime::Handle::spawn(&fixture.config, kind, None).unwrap();
        let (location, path) = tokio::sync::oneshot::channel();
        let collected = tokio::spawn(async move {
            let mut location = Some(location);
            let mut bytes = String::new();
            while let Some(event) = events.recv().await {
                match event {
                    Event::Record {
                        kind: "native_identity",
                        data,
                        ..
                    } => {
                        if let Some(path) = data["path"].as_str()
                            && let Some(sender) = location.take()
                        {
                            let _ = sender.send(PathBuf::from(path));
                        }
                    }
                    Event::Record {
                        kind: "native_record",
                        native: Some(raw),
                        ..
                    } => bytes.push_str(&raw),
                    Event::Exited { expected, .. } => assert!(expected),
                    _ => {}
                }
            }
            bytes
        });
        handle.start_session().await.unwrap();
        let path = path.await.unwrap();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        for n in 0..300 {
            writeln!(file, "{}", serde_json::json!({"type":"custom","id":format!("{n:08x}"),"parentId":null,"data":{"text":"x".repeat(1500)}})).unwrap();
        }
        file.sync_all().unwrap();
        handle.request_shutdown();
        let captured = tokio::time::timeout(Duration::from_secs(6), collected)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(captured, fs::read_to_string(path).unwrap());
    }
}
