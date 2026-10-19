use cloudroom::{config::Config, runtime};
use std::{fs, path::PathBuf, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

fn config(dir: &std::path::Path) -> Config {
    Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        token: String::new(),
        state_dir: dir.join("state"),
        repository: dir.to_owned(),
        api_url: Some("http://127.0.0.1:1".into()),
        store: "fixture".into(),
        instance: None,
        account_home: dir.to_owned(),
        default_harness: runtime::Kind::Codex,
        harnesses: Default::default(),
        storage: None,
        rpc_timeout: Duration::from_secs(30),
        diagnostic_upload: Duration::from_secs(1),
    }
}

async fn send(app: &mut DuplexStream, kind: u8, data: &[u8]) {
    app.write_u8(kind).await.unwrap();
    app.write_u32(data.len() as u32).await.unwrap();
    app.write_all(data).await.unwrap();
}

async fn receive(app: &mut DuplexStream) -> (u8, Vec<u8>) {
    let kind = app.read_u8().await.unwrap();
    let mut data = vec![0; app.read_u32().await.unwrap() as usize];
    app.read_exact(&mut data).await.unwrap();
    (kind, data)
}

/// Output until EXIT, plus the exit code.
async fn until_exit(app: &mut DuplexStream) -> (Vec<u8>, serde_json::Value) {
    let mut output = Vec::new();
    loop {
        match receive(app).await {
            (0, bytes) => output.extend(bytes),
            (1, exit) => return (output, serde_json::from_slice(&exit).unwrap()),
            _ => {}
        }
    }
}

#[tokio::test]
async fn shell_runs_on_a_resizable_terminal_and_replays_after_reconnect() {
    let dir = std::env::temp_dir().join(format!("cloudroom-terminal-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let dir = dir.canonicalize().unwrap();
    let terminals = runtime::terminal::Terminals::default();
    let terminal = terminals
        .open(&config(&dir), "term_test", dir.clone(), 100, 30, None)
        .unwrap();
    let (mut app, core) = tokio::io::duplex(1 << 20);
    tokio::spawn(Arc::clone(&terminal).serve(core, 0));
    tokio::time::timeout(Duration::from_secs(10), async {
        let (kind, hello) = receive(&mut app).await;
        let hello: serde_json::Value = serde_json::from_slice(&hello).unwrap();
        assert_eq!((kind, hello["offset"].as_u64()), (2, Some(0)));
        assert_eq!(PathBuf::from(hello["cwd"].as_str().unwrap()), dir);
        send(&mut app, 1, &[0, 120, 0, 40]).await;
        send(&mut app, 0, b"stty size; pwd; exit 7\n").await;
        let (output, exit) = until_exit(&mut app).await;
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("40 120"), "{text}");
        assert!(text.contains(dir.to_str().unwrap()), "{text}");
        assert_eq!(exit["code"], 7);
        assert_eq!(terminals.summary()["open"], 0);

        // A reconnect gets the output it missed, then the exit.
        let (mut again, core) = tokio::io::duplex(1 << 20);
        tokio::spawn(terminal.serve(core, 5));
        let (kind, hello) = receive(&mut again).await;
        let hello: serde_json::Value = serde_json::from_slice(&hello).unwrap();
        assert_eq!((kind, hello["offset"].as_u64()), (2, Some(5)));
        let (replayed, exit) = until_exit(&mut again).await;
        assert_eq!(replayed, output[5..]);
        assert_eq!(exit["code"], 7);
    })
    .await
    .unwrap();
    terminals.close("term_test");
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn shell_gets_the_agents_claude_and_codex_logins() {
    let dir =
        std::env::temp_dir().join(format!("cloudroom-terminal-logins-{}", std::process::id()));
    fs::create_dir_all(dir.join("state")).unwrap();
    let dir = dir.canonicalize().unwrap();
    fs::write(
        dir.join("state/claude-oauth-token"),
        "sk-ant-oat-test\nmax\n",
    )
    .unwrap();
    let mut config = config(&dir);
    for (kind, home) in [
        (runtime::Kind::Claude, ".claude"),
        (runtime::Kind::Codex, ".codex"),
    ] {
        let profile = cloudroom::config::HarnessConfig {
            binary: "/bin/true".into(),
            home: dir.join(home),
            model: "fixture".into(),
            provider: None,
        };
        config.harnesses.insert(kind, profile);
    }
    let terminals = runtime::terminal::Terminals::default();
    let command = r#"echo "[$CLAUDE_CODE_OAUTH_TOKEN $CLAUDE_CODE_SUBSCRIPTION_TYPE $DISABLE_AUTOUPDATER $CODEX_HOME]""#;
    let terminal = terminals
        .open(&config, "term_logins", dir.clone(), 100, 30, Some(command))
        .unwrap();
    let (mut app, core) = tokio::io::duplex(1 << 20);
    tokio::spawn(Arc::clone(&terminal).serve(core, 0));
    let (output, _) = tokio::time::timeout(Duration::from_secs(10), until_exit(&mut app))
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&output);
    let expected = format!("[sk-ant-oat-test max 1 {}]", dir.join(".codex").display());
    assert!(text.contains(&expected), "{text}");
    terminals.close("term_logins");
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_running_command_counts_until_the_terminal_closes() {
    let dir =
        std::env::temp_dir().join(format!("cloudroom-terminal-running-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let dir = dir.canonicalize().unwrap();
    let terminals = runtime::terminal::Terminals::default();
    let _terminal = terminals
        .open(
            &config(&dir),
            "term_running",
            dir.clone(),
            80,
            24,
            Some("sleep 30"),
        )
        .unwrap();
    assert_eq!(terminals.running(), 1);
    terminals.close("term_running");
    assert_eq!(terminals.running(), 0);
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_exited_terminal_is_reaped_once_its_grace_has_passed() {
    let dir = std::env::temp_dir().join(format!("cloudroom-terminal-reap-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let dir = dir.canonicalize().unwrap();
    let terminals = runtime::terminal::Terminals::default();
    terminals
        .open(
            &config(&dir),
            "term_done",
            dir.clone(),
            80,
            24,
            Some("true"),
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while terminals.running() != 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the command exits");
    terminals.reap_exited(Duration::from_secs(3600));
    assert!(terminals.get("term_done").is_some());
    terminals.reap_exited(Duration::ZERO);
    assert!(terminals.get("term_done").is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn opening_a_terminal_reaps_an_exited_one_past_its_grace() {
    let dir = std::env::temp_dir().join(format!(
        "cloudroom-terminal-open-reap-{}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    let dir = dir.canonicalize().unwrap();
    let terminals =
        runtime::terminal::Terminals::with_timings(Duration::ZERO, Duration::from_secs(600));
    terminals
        .open(
            &config(&dir),
            "term_first",
            dir.clone(),
            80,
            24,
            Some("true"),
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while terminals.running() != 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the command exits");
    assert!(terminals.get("term_first").is_some());
    terminals
        .open(&config(&dir), "term_second", dir.clone(), 80, 24, None)
        .unwrap();
    assert!(terminals.get("term_first").is_none());
    assert!(terminals.get("term_second").is_some());
    terminals.close("term_second");
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_idle_shell_does_not_count_but_a_foreground_job_does() {
    let dir = std::env::temp_dir().join(format!("cloudroom-terminal-idle-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let dir = dir.canonicalize().unwrap();
    let terminals = runtime::terminal::Terminals::default();
    let terminal = terminals
        .open(&config(&dir), "term_idle", dir.clone(), 80, 24, None)
        .unwrap();
    let (mut app, core) = tokio::io::duplex(1 << 20);
    tokio::spawn(terminal.serve(core, 0));
    let (kind, _) = receive(&mut app).await;
    assert_eq!(kind, 2);
    assert_eq!(terminals.running(), 0);
    send(&mut app, 0, b"sleep 30\n").await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while terminals.running() != 1 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("a foreground job counts as running");
    send(&mut app, 0, &[3]).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while terminals.running() != 0 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("an interrupted job stops counting");
    terminals.close("term_idle");
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_quiet_foreground_job_stops_counting_as_running() {
    let dir = std::env::temp_dir().join(format!("cloudroom-terminal-quiet-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let dir = dir.canonicalize().unwrap();
    let terminals = runtime::terminal::Terminals::with_timings(
        Duration::from_secs(600),
        Duration::from_secs(1),
    );
    let terminal = terminals
        .open(&config(&dir), "term_quiet", dir.clone(), 80, 24, None)
        .unwrap();
    let (mut app, core) = tokio::io::duplex(1 << 20);
    tokio::spawn(terminal.serve(core, 0));
    let (kind, _) = receive(&mut app).await;
    assert_eq!(kind, 2);
    send(&mut app, 0, b"sleep 30\n").await;
    tokio::time::timeout(Duration::from_secs(10), async {
        while terminals.running() != 1 {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("a foreground job counts while it is active");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(
        terminals.running(),
        0,
        "a quiet job no longer holds the sandbox"
    );
    terminals.close("term_quiet");
    let _ = fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn reattaching_to_a_live_terminal_applies_the_new_size() {
    let dir = std::env::temp_dir().join(format!("cloudroom-terminal-size-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let dir = dir.canonicalize().unwrap();
    let config = config(&dir);
    let terminals = runtime::terminal::Terminals::default();
    terminals
        .open(&config, "term_size", dir.clone(), 100, 30, None)
        .unwrap();
    let terminal = terminals
        .reattach("term_size", 200, 50)
        .expect("the live terminal is found");
    let (mut app, core) = tokio::io::duplex(1 << 20);
    tokio::spawn(terminal.serve(core, 0));
    tokio::time::timeout(Duration::from_secs(10), async {
        let (kind, _) = receive(&mut app).await;
        assert_eq!(kind, 2);
        send(&mut app, 0, b"stty size; exit 0\n").await;
        let (output, _) = until_exit(&mut app).await;
        assert!(String::from_utf8_lossy(&output).contains("50 200"));
    })
    .await
    .unwrap();
    terminals.close("term_size");
    let _ = fs::remove_dir_all(&dir);
}
