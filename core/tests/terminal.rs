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
