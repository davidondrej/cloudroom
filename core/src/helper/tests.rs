//! client.py's tests (core/tests/preview_client.py), ported to the Rust helper.

use super::jobs;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Tests that fork job commands run apart from the setup test: a forked child holds the helper's lock file until it
/// starts its shell, which the setup test would read as a running helper. A test-only race; setup runs alone in the app.
static FORKS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn folder(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("cr-helper-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    jobs::realpath(&path)
}

/// The test app behind a preview: HEAD answers 405, GET / "ok", /events three SSE events, POST echoes its body.
async fn app(listener: tokio::net::UnixListener) {
    loop {
        let (mut stream, _) = listener.accept().await.unwrap();
        tokio::spawn(async move {
            let mut data = Vec::new();
            let mut chunk = [0u8; 65536];
            let end = loop {
                let read = stream.read(&mut chunk).await.unwrap();
                data.extend_from_slice(&chunk[..read]);
                if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                    break end;
                }
            };
            let head = String::from_utf8_lossy(&data[..end]).to_lowercase();
            let length: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .map_or(0, |value| value.trim().parse().unwrap());
            let mut body = data[end + 4..].to_vec();
            while body.len() < length {
                let read = stream.read(&mut chunk).await.unwrap();
                body.extend_from_slice(&chunk[..read]);
            }
            let reply: Vec<u8> = if head.starts_with("get /latin1") {
                b"HTTP/1.1 200 OK\r\nContent-Disposition: attachment; filename=\"caf\xe9.txt\"\r\nContent-Length: 2\r\n\r\nok".to_vec()
            } else if head.starts_with("head") {
                b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n".to_vec()
            } else if head.starts_with("get /events") {
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
                for n in 0..3 {
                    stream
                        .write_all(format!("data: {n}\n\n").as_bytes())
                        .await
                        .unwrap();
                    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                }
                Vec::new()
            } else if head.starts_with("post") {
                [
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len())
                        .into_bytes(),
                    body,
                ]
                .concat()
            } else {
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".to_vec()
            };
            let _ = stream.write_all(&reply).await;
        });
    }
}

async fn request(port: u16, raw: String, body: &[u8]) -> (u16, String, Vec<u8>) {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    stream.write_all(raw.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    let end = answer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    let head = String::from_utf8_lossy(&answer[..end]).into_owned();
    (
        head[9..12].parse().unwrap(),
        head,
        answer[end + 4..].to_vec(),
    )
}

#[tokio::test]
async fn browser_path_streaming_upload_readiness_and_privacy() {
    let dir = folder("proxy");
    let socket = dir.join("upstream.sock");
    // Bound before the test starts, so the proxy never races the app.
    tokio::spawn(app(tokio::net::UnixListener::bind(&socket).unwrap()));
    let (info, _tasks) = super::tunnel::test_proxy(socket, "test-generation").await;
    let (port, host) = (info.local_port, info.authority().to_owned());
    assert!(info.healthy().await); // HEAD 405 still proves the transport works.
    let get =
        |path: &str, extra: &str| format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n");
    let (status, head, body) = request(port, get("/", ""), b"").await;
    assert_eq!((status, body.as_slice()), (200, &b"ok"[..]));
    assert!(
        head.contains("Content-Security-Policy: frame-ancestors 'self'")
            && head.contains("X-Cloudroom-Preview: test-generation")
    );
    assert_eq!(
        request(port, get("/events", ""), b"").await.2,
        b"data: 0\n\ndata: 1\n\ndata: 2\n\n"
    );
    // A header that isn't UTF-8, like a Latin-1 download name, passes through unchanged.
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    stream
        .write_all(get("/latin1", "").as_bytes())
        .await
        .unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    assert!(
        answer.starts_with(b"HTTP/1.1 200")
            && answer
                .windows(18)
                .any(|window| window == b"filename=\"caf\xe9.txt")
    );
    let upload = vec![b'x'; 131072];
    let post = format!(
        "POST / HTTP/1.1\r\nHost: {host}\r\nContent-Length: {}\r\n\r\n",
        upload.len()
    );
    assert_eq!(request(port, post, &upload).await.2, upload);
    for extra in [
        "Origin: https://attacker.example\r\n",
        "Upgrade: websocket\r\n",
        "Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: iframe\r\n",
    ] {
        assert_eq!(request(port, get("/", extra), b"").await.0, 403);
    }
    let attacker = "GET / HTTP/1.1\r\nHost: attacker.example\r\n\r\n".to_owned();
    assert_eq!(request(port, attacker, b"").await.0, 403);
    assert_eq!(request(port, get("/", "Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n"), b"").await.0, 200);
    let chunked = format!("POST / HTTP/1.1\r\nHost: {host}\r\nTransfer-Encoding: chunked\r\n\r\n");
    assert_eq!(request(port, chunked, b"").await.0, 411);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn ask_first_popup_shows_agent_text_as_text() {
    // Security sweep: line breaks in a folder name could push the command out of view in the Ask first popup.
    let stdin: String = (0..25).map(|n| format!("echo {n}\r\n")).collect();
    let job = json!({"id": "job", "command": "bash -s\necho two\u{202e}", "cwd": format!("/tmp/a\nb{}", "c".repeat(300)), "write": true, "stdin": super::hex(stdin.as_bytes())});
    let text = jobs::popup_text(&job, Path::new("/unused"));
    let lines: Vec<&str> = text.split('\n').collect();
    let folder = format!("Folder: /tmp/a\\nb{}…", "c".repeat(191));
    let expected = [
        "Warning: 44 more characters of its input are not shown, and will also run.",
        "",
        "Command:",
        "    bash -s",
        "    echo two\\u202e",
        "",
        folder.as_str(),
        "",
        "Input (25 lines):",
        "    echo 0\\r",
    ];
    assert_eq!(lines[2..12], expected);
    assert_eq!(
        lines[12..],
        (1..20)
            .map(|n| format!("    echo {n}\\r"))
            .collect::<Vec<_>>()
    );
    assert!(text.chars().all(|c| c == '\n' || !c.is_control()));
    // Escapes count against the limit, and the hidden count stays in the agent's own characters.
    assert_eq!(
        jobs::visible(&"\0".repeat(300), 600, 10),
        ("\\x00".repeat(150), 150)
    );
}

#[test]
fn ask_first_popup_shows_a_push_as_a_copy() {
    // Security fix (#222): a push says where its one item really lands. Other commands warn about what they can't show.
    let home = folder("copy-popup");
    let mut copy = json!({"id": "copy", "command": "touch ~/.zshrc", "cwd": "/", "stdin": "1f8b", "copy": {"name": "a\nb", "to": "~"}});
    assert_eq!(jobs::as_copy(&mut copy, &home, &[]), None);
    assert_eq!(
        (&copy["cwd"], &copy["write"], &copy["sandbox"]),
        (&Value::Null, &json!(true), &json!(false))
    );
    let real = home.display();
    assert!(
        copy["command"]
            .as_str()
            .unwrap()
            .starts_with(&format!("b={real}; n='a\nb'; to='{real}/a\nb'; s=; "))
    );
    assert_eq!(
        jobs::popup_text(&copy, &home),
        "A cloud agent wants to copy a file or folder to your Mac.\n\nCopy to: ~/a\\nb\n\nOnly this one item is copied. It replaces a file with the same name there, and merges into a folder with the same name."
    );
    let raw = jobs::popup_text(
        &json!({"id": "raw", "command": "cat /tmp/x/* | tar -xzf - -C ~", "write": true, "stdin": "1f8b00"}),
        &home,
    );
    assert_eq!(
        raw.split("\n\n").skip(1).take(2).collect::<Vec<_>>(),
        [
            "Warning: the command uses files in a temp folder. Cloud agents can change those without asking, and they are not shown.",
            "Warning: the command also reads 3 bytes of input that cannot be shown, such as an archive. What it changes can depend on that input."
        ]
    );
    let real = real.to_string();
    let mut temp = json!({"copy": {"name": "x", "to": format!("{real}/")}});
    assert_eq!(jobs::as_copy(&mut temp, &home, &[real.as_str()]), None);
    assert!(temp["write"] == json!(true) && temp["sandbox"] == json!(true));
    let mut bad = json!({"copy": {"name": "x", "to": "~", "staged": "/tmp/cloudroom.a/.."}});
    assert_eq!(
        jobs::as_copy(&mut bad, &home, &[]).as_deref(),
        Some("This copy has a name or place the Mac cannot use, so nothing was copied.")
    );
    std::fs::remove_dir_all(home).unwrap();
}

/// A gzip tar of `entries` built under `stage`, as a sandbox's push would send.
#[cfg(target_os = "macos")]
fn archive(stage: &Path, entries: &[&str]) -> Vec<u8> {
    let output = std::process::Command::new("/usr/bin/tar")
        .args(["-czf", "-", "-C"])
        .arg(stage)
        .args(entries)
        .output()
        .unwrap();
    assert!(output.status.success());
    output.stdout
}

#[tokio::test]
#[cfg(target_os = "macos")]
async fn push_places_only_its_named_item() {
    let _alone = FORKS.lock().await;
    // Security fix (#222): a push into a folder unpacked the sandbox's whole archive there, so it could add ~/.zshrc or
    // rewrite a file through a link. The Mac builds the unpack and places only the named item.
    let root = folder("push");
    let (home, outside, stage) = (root.join("home"), root.join("outside"), root.join("stage"));
    for path in [&home, &outside, &stage.join("notes"), &stage.join("proj")] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(outside.join("victim"), "victim").unwrap();
    std::os::unix::fs::symlink(outside.join("victim"), home.join("v.txt")).unwrap();
    std::fs::write(home.join(".zshrc"), "mine").unwrap();
    std::fs::write(stage.join("notes.txt"), "one").unwrap();
    std::fs::write(stage.join(".zshrc"), "x").unwrap();
    std::fs::write(stage.join("v.txt"), "new").unwrap();
    std::fs::write(stage.join("proj/a"), "new").unwrap();
    std::fs::write(stage.join("proj/b"), "b").unwrap();
    let jobs = jobs::Jobs::new(std::sync::Arc::new(super::net::Shared::new(root.clone())));
    let push = async |data: Vec<u8>, name: &str, to: &str, staged: Option<String>| {
        // The sandbox's own command, folder, and write flag never count.
        let mut job = json!({"id": name, "command": format!("touch {}/ran", root.display()), "cwd": outside, "write": false,
            "stdin": super::hex(&data), "copy": {"name": name, "to": to, "staged": staged}});
        if let Some(refused) = super::jobs::as_copy(&mut job, &home, &[]) {
            return (126, String::new(), refused);
        }
        let result = jobs.run(&job, None, &root, None, None).await;
        let text = |key: &str| {
            String::from_utf8(super::unhex(result[key].as_str().unwrap()).unwrap()).unwrap()
        };
        (
            result["code"].as_i64().unwrap(),
            text("stdout")
                .trim()
                .lines()
                .last()
                .unwrap_or_default()
                .to_owned(),
            text("stderr"),
        )
    };
    // Other files, and a file through a link: none of it lands.
    assert!(
        push(
            archive(&stage, &["notes.txt", ".zshrc"]),
            "notes.txt",
            "~",
            None
        )
        .await
        .2
        .contains("held other files")
    );
    assert_eq!(
        push(archive(&stage, &["v.txt"]), "v.txt", "~", None)
            .await
            .0,
        0
    );
    assert_eq!(
        (
            std::fs::read_to_string(outside.join("victim")).unwrap(),
            home.join("v.txt").is_symlink()
        ),
        ("victim".into(), false)
    );
    assert_eq!(
        std::fs::read_to_string(home.join(".zshrc")).unwrap(),
        "mine"
    );
    assert!(!root.join("ran").exists());
    // Into the home folder, under a new name, and that name again.
    let notes = archive(&stage, &["notes.txt"]);
    assert_eq!(
        push(notes.clone(), "notes.txt", "~", None).await,
        (0, format!("{}/notes.txt", home.display()), String::new())
    );
    assert_eq!(
        push(notes.clone(), "notes.txt", "~/new.txt", None).await.1,
        format!("{}/new.txt", home.display())
    );
    assert!(
        push(notes, "notes.txt", "~/new.txt", None)
            .await
            .2
            .contains("already exists")
    );
    // A folder merges, as cp does, also from a copy staged in pieces, whose staging is removed.
    std::fs::create_dir_all(home.join("proj")).unwrap();
    std::fs::write(home.join("proj/keep"), "keep").unwrap();
    std::fs::write(home.join("proj/a"), "old").unwrap();
    let staged = PathBuf::from(format!("/tmp/cloudroom.{}", std::process::id()));
    std::fs::create_dir_all(&staged).unwrap();
    let data = archive(&stage, &["proj"]);
    std::fs::write(staged.join("00000"), &data[..50]).unwrap();
    std::fs::write(staged.join("00001"), &data[50..]).unwrap();
    assert_eq!(
        push(Vec::new(), "proj", "~/", Some(staged.display().to_string()))
            .await
            .0,
        0
    );
    let merged = |name: &str| std::fs::read_to_string(home.join("proj").join(name)).unwrap();
    assert_eq!(
        [merged("a"), merged("b"), merged("keep")],
        ["new", "b", "keep"]
    );
    assert!(!staged.exists());
    // A name or place the Mac can't use is refused.
    for (name, to) in [("a/b", "~"), ("..", "~"), ("x", "~/missing/.."), ("x", "")] {
        assert_eq!(push(Vec::new(), name, to, None).await.0, 126);
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
#[cfg(target_os = "macos")]
fn read_only_hides_every_cloudroom_folder_with_keys() {
    // Security fix: a Read-only command could read the relay key of the Mac this Mac runs threads for.
    let home = folder("read-only");
    let (data, machines, disk) = (
        home.join("data"),
        home.join(".bb-machines"),
        home.join("disk"),
    );
    std::fs::create_dir_all(machines.join("pro.cloudroom.run")).unwrap();
    std::fs::create_dir_all(disk.join("air")).unwrap();
    std::os::unix::fs::symlink(disk.join("air"), machines.join("air.cloudroom.run")).unwrap();
    let agents = home.join("Library/LaunchAgents");
    std::fs::create_dir_all(&agents).unwrap();
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>EnvironmentVariables</key><dict><key>BB_DATA_DIR</key><string>{}</string></dict></dict></plist>",
        home.join("old-machine").display()
    );
    std::fs::write(agents.join("app.getbb.host-daemon.old.plist"), plist).unwrap();
    std::fs::write(
        agents.join("app.getbb.host-daemon.broken.plist"),
        "<?xml version=\"1.0\"?><plist><dict>",
    )
    .unwrap();
    let args = jobs::read_only(&data, &home, &["helper.read-only", "helper.read-only.job"]);
    let params: Vec<(String, PathBuf)> = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| *arg == "-D")
        .map(|(n, _)| {
            args[n + 1]
                .split_once('=')
                .map(|(key, path)| (key.to_owned(), PathBuf::from(path)))
                .unwrap()
        })
        .collect();
    let group = |prefix: &str| {
        let mut paths: Vec<PathBuf> = params
            .iter()
            .filter(|(key, _)| key.starts_with(prefix))
            .map(|(_, path)| path.clone())
            .collect();
        paths.sort();
        paths
    };
    let sorted = |mut paths: Vec<PathBuf>| {
        paths.sort();
        paths
    };
    assert_eq!(
        group("FOLDER_"),
        sorted(vec![
            data,
            home.join(".gui-cloudroom"),
            home.join(".gui-cloudroom-dev")
        ])
    );
    assert_eq!(
        group("MACHINE_"),
        sorted(vec![
            machines.clone(),
            machines.join("pro.cloudroom.run"),
            disk.join("air"),
            home.join("old-machine")
        ])
    );
    let profile = &args[args.iter().position(|arg| arg == "-p").unwrap() + 1];
    assert!(
        params
            .iter()
            .filter(|(key, _)| key.starts_with("FOLDER_") || key.starts_with("MACHINE_"))
            .all(|(key, _)| profile.contains(&format!("(subpath (param \"{key}\"))")))
    );
    // The tools exception reopens only this app's tools. Machine installs and old key copies come last, so neither the
    // tools nor the temp-folder write exception can reopen them, and they can't be rewritten either.
    let order: Vec<usize> = [
        r#"(deny file-read* (subpath (param "FOLDER_0"))"#,
        jobs::READ_ONLY_TOOLS,
        r#"(deny file-read* file-write* (subpath (param "MACHINE_0"))"#,
    ]
    .iter()
    .map(|rule| profile.find(rule).unwrap())
    .collect();
    assert!(order.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(profile.ends_with(&format!(" {})", jobs::READ_ONLY_OLD_KEYS)));
    // The marks that let the helper end everything the command starts (jobs::end).
    assert!(profile.contains(
        r#"(deny mach-lookup (global-name "helper.read-only") (global-name "helper.read-only.job"))"#
    ));
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
#[cfg(target_os = "macos")]
fn each_account_keeps_its_own_key_and_device() {
    let _alone = FORKS.blocking_lock();
    // #109: after an account switch on one Mac, setup refused forever, so Mac access never started again. Switching back
    // must return the first account's device: its sandboxes that slept through the switch refuse any other.
    let root = folder("setup");
    let (preview, connection) = (root.join("preview"), root.join("cloudroom.json"));
    let sign_in = |account: &str| {
        std::fs::write(
            &connection,
            json!({"account": {"id": account}, "sandboxToken": "token"}).to_string(),
        )
        .unwrap();
        std::fs::set_permissions(
            &connection,
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();
        let setup = super::Setup {
            activate: false,
            allow_private: None,
            level: None,
            launcher: None,
            restart: false,
            own: false,
        };
        super::configure(&preview, &connection, setup).unwrap();
        (
            super::private_json(&preview.join("config.json")).unwrap()["device"].clone(),
            std::fs::read_to_string(preview.join("id_ed25519.pub")).unwrap(),
        )
    };
    let (first, second) = (
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    );
    let (a, b) = (sign_in(first), sign_in(second));
    assert!(a.0 != b.0 && a.1 != b.1);
    assert_eq!(sign_in(first), a);
    assert_eq!(sign_in(second), b);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
#[cfg(target_os = "macos")]
async fn read_only_command_leaves_nothing_running() {
    let _alone = FORKS.lock().await;
    // Security fix: as client.py's test of the same name, with the real macOS sandbox. Nothing a read-only command starts
    // outlives it, its stop, its sandbox's stream, or its helper, even after setsid and a double fork, or as a chain of
    // processes that each fork and end at once. Full commands keep theirs (dev servers), and others run on.
    use std::sync::Arc;
    let (root, beats) = (folder("read-only-ends"), folder("read-only-beats"));
    let jobs = Arc::new(jobs::Jobs::new(Arc::new(super::net::Shared::new(
        root.clone(),
    ))));
    let core = ("http://core".to_owned(), "token".to_owned());
    jobs.wanted.lock().unwrap().insert(core.clone());
    // Each process rewrites its own file every 0.1 s: one in the command's process group, and one that left it with
    // setsid after a fork, then forked again. The chain writes every 50th process and stops by itself after 30 s.
    let each = r#"for ($n = 0;; $n++) { open(F, ">", $ARGV[0]); print F "$$ $n"; close F; select(undef, undef, undef, .1) }"#;
    let chain = r#"for ($n = 0;; $n++) { exit if fork or time - $^T > 30; next if $n % 50; open(F, ">", $ARGV[0]); print F "0 $n"; close F }"#;
    let b = beats.display().to_string();
    let leaves = |name: &str, chained: bool| {
        let mut files = vec![format!("{b}/{name}-group"), format!("{b}/{name}-left")];
        let mut command = format!(
            "perl -e '{each}' {} & perl -MPOSIX -e 'if (fork) {{ exit }} POSIX::setsid(); if (fork) {{ exit }} {each}' {}; ",
            files[0], files[1]
        );
        if chained {
            files.push(format!("{b}/{name}-chain"));
            command += &format!("perl -e '{chain}' {} & ", files[2]);
        }
        let waits: Vec<String> = files
            .iter()
            .map(|file| format!("[ ! -s {file} ]"))
            .collect();
        command + &format!("while {}; do sleep .05; done", waits.join(" || "))
    };
    let running = async |names: &[&str]| {
        let read = |name: &&str| std::fs::read_to_string(beats.join(name)).unwrap();
        let before: Vec<String> = names.iter().map(read).collect();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        names
            .iter()
            .zip(before)
            .map(|(name, text)| read(name) != text)
            .collect::<Vec<_>>()
    };
    let run = async |command: String, sandbox: Option<&(String, String)>| {
        jobs.run(
            &json!({"id": "job", "command": command}),
            sandbox,
            &root,
            None,
            None,
        )
        .await["code"]
            .clone()
    };
    // A read-only command that keeps running: its task, once it runs.
    #[allow(clippy::async_yields_async)]
    let start = async |name: &str| {
        let (jobs, root, core) = (jobs.clone(), root.clone(), core.clone());
        let (id, command) = (name.to_owned(), leaves(name, false) + "; sleep 30");
        let task = tokio::spawn(async move {
            jobs.run(
                &json!({"id": id, "command": command}),
                Some(&core),
                &root,
                None,
                None,
            )
            .await["code"]
                .clone()
        });
        for _ in 0..200 {
            if beats.join(format!("{name}-left")).exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        task
    };
    // Others run on: what an earlier run of this helper left (until the first check), another helper's read-only command
    // (a dev build), and another sandbox.
    let mark = format!("{}.read-only", super::label(&root));
    let marks = [
        vec![mark.clone(), format!("{mark}.0"), format!("{mark}.0.job")],
        vec!["other.read-only".into(), "other.read-only.job".into()],
    ];
    let mut others = Vec::new();
    for (marks, name) in marks.iter().zip(["old", "other"]) {
        let marks: Vec<&str> = marks.iter().map(String::as_str).collect();
        let argv = jobs::read_only(&root, &super::home(), &marks);
        let loop_ = format!("perl -e '{each}' {b}/{name}");
        others.push(
            std::process::Command::new(&argv[0])
                .args(&argv[1..])
                .args(["sh", "-c", &loop_])
                .spawn()
                .unwrap(),
        );
    }
    others.push(
        std::process::Command::new("/usr/bin/sandbox-exec")
            .args([
                "-p",
                "(version 1)(allow default)(deny mach-lookup)",
                "sh",
                "-c",
            ])
            .arg(format!("perl -e '{each}' {b}/denies-all"))
            .spawn()
            .unwrap(),
    );
    // Full keeps what it leaves running; read-only ends it all with the command.
    assert_eq!(run(leaves("full", false), None).await, json!(0));
    assert_eq!(running(&["full-group", "full-left"]).await, [true, true]);
    assert_eq!(run(leaves("read", true), Some(&core)).await, json!(0));
    assert_eq!(
        running(&["read-group", "read-left", "read-chain"]).await,
        [false; 3]
    );
    // A running read-only command survives another one's end and the check that ends what earlier runs left.
    let first = start("first").await;
    assert_eq!(run("true".into(), Some(&core)).await, json!(0));
    jobs.end_unwanted().await;
    assert_eq!(
        running(&["first-group", "first-left", "old"]).await,
        [true, true, false]
    );
    // The agent's stop, its sandbox's stream ending (Off here), and the helper's stop each end it all.
    jobs.cancel("first");
    assert_eq!(first.await.unwrap(), json!(-15));
    let second = start("second").await;
    jobs.wanted.lock().unwrap().clear();
    jobs.end_unwanted().await;
    assert_eq!(second.await.unwrap(), json!(-9));
    jobs.wanted.lock().unwrap().insert(core.clone());
    let third = start("third").await;
    jobs.close().await;
    assert_eq!(third.await.unwrap(), json!(-9));
    let names =
        ["first", "second", "third"].map(|name| [format!("{name}-group"), format!("{name}-left")]);
    let names: Vec<&str> = names.iter().flatten().map(String::as_str).collect();
    assert_eq!(running(&names).await, [false; 6]);
    // After the stop nothing new starts, and the others still run.
    assert_eq!(run("true".into(), None).await, json!(126));
    assert_eq!(running(&["other", "denies-all"]).await, [true, true]);
    for process in &mut others {
        let _ = process.kill();
        let _ = process.wait();
    }
    for beat in std::fs::read_dir(&beats).unwrap().flatten() {
        let text = std::fs::read_to_string(beat.path()).unwrap_or_default();
        let pid = text.split(' ').next().unwrap_or_default();
        if pid.parse::<i32>().is_ok_and(|pid| pid > 0) {
            // Chains write 0 and stop by themselves.
            let _ = std::process::Command::new("kill")
                .args(["-9", pid])
                .status();
        }
    }
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(beats).unwrap();
}

#[tokio::test]
async fn background_process_outlives_its_result() {
    let _alone = FORKS.lock().await;
    // A process the command left running kept writing to its output after the result went back; with the pipe closed,
    // it died. The helper keeps reading, as client.py does.
    let root = folder("background");
    let marker = root.join("marker");
    let jobs = jobs::Jobs::new(std::sync::Arc::new(super::net::Shared::new(root.clone())));
    let command = format!(
        "(sleep 3; echo late; touch {}) 2>/dev/null & echo started",
        marker.display()
    );
    let result = jobs
        .run(
            &json!({"id": "bg", "command": command}),
            None,
            &root,
            None,
            None,
        )
        .await;
    assert_eq!(
        (&result["code"], &result["stdout"]),
        (&json!(0), &json!(super::hex(b"started\n")))
    );
    for _ in 0..50 {
        if marker.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(
        marker.exists(),
        "the background process died writing its output"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn nested_room_cli_reaches_the_app_that_owns_the_helper() {
    let _alone = FORKS.lock().await;
    // #1243, #1290: a stale ROOM_SERVER_URL from the helper's or the login shell's environment, or none, sent the
    // Mac's room-cli to a dead port or another app. The app's own server comes last, after the login setup.
    let root = folder("server");
    let jobs = jobs::Jobs::new(std::sync::Arc::new(super::net::Shared::new(root.clone())));
    let job = json!({"id": "url", "command": "printf %s \"$ROOM_SERVER_URL\""});
    let result = jobs
        .run(&job, None, &root, None, Some("http://127.0.0.1:41000"))
        .await;
    assert_eq!(
        result["stdout"],
        json!(super::hex(b"http://127.0.0.1:41000"))
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn a_fake_core_gets_no_more_kept_than_core_sends() {
    // Security fix: a sandbox's agent has root, so it can answer the helper in place of Core, with jobs and input of any
    // size. The helper keeps no more than a real Core sends.
    let root = folder("limits");
    let config = root.join("config.json");
    let access = |level: &str| {
        std::fs::write(&config, json!({"macAccess": level}).to_string()).unwrap();
        std::fs::set_permissions(&config, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .unwrap();
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, Value)>::new()));
    // The fake Core: one job stream, results it keeps, and a confirmation for the streamed job it never answers.
    tokio::spawn({
        let seen = seen.clone();
        async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let seen = seen.clone();
                tokio::spawn(async move {
                    let (mut data, mut chunk) = (Vec::new(), [0u8; 65536]);
                    let end = loop {
                        let read = stream.read(&mut chunk).await.unwrap();
                        data.extend_from_slice(&chunk[..read]);
                        if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n")
                        {
                            break end;
                        }
                    };
                    let head = String::from_utf8_lossy(&data[..end]).to_lowercase();
                    let length: usize = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .map_or(0, |value| value.trim().parse().unwrap());
                    let mut body = data[end + 4..].to_vec();
                    while body.len() < length {
                        let read = stream.read(&mut chunk).await.unwrap();
                        body.extend_from_slice(&chunk[..read]);
                    }
                    let line = head.lines().next().unwrap_or_default().to_owned();
                    let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    seen.lock().unwrap().push((line.clone(), body));
                    if line.starts_with("get /v1/mac/jobs?") {
                        // The longest job a real Core sends (up to 0.1.75, with its input inside), then a line longer
                        // than any job.
                        let longest = json!({"id": "streamed", "command": "\u{1}".repeat(65536),
                            "cwd": "\u{1}".repeat(4096), "stdin": "00".repeat(jobs::LIMIT)});
                        let events = format!(
                            "event: job\ndata: {longest}\n\ndata: {}\n",
                            "x".repeat(jobs::LINE)
                        );
                        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
                        let _ = stream.write_all(head.as_bytes()).await;
                        let _ = stream.write_all(events.as_bytes()).await;
                    } else if line.starts_with("post /v1/mac/results/streamed") {
                        std::future::pending::<()>().await;
                    } else {
                        let _ = stream
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                            .await;
                    }
                });
            }
        }
    });
    let jobs = std::sync::Arc::new(jobs::Jobs::new(std::sync::Arc::new(
        super::net::Shared::new(root.clone()),
    )));
    let core = super::net::Core {
        url: url.clone(),
        headers: Vec::new(),
        sandbox: false,
        thread: None,
        key: (url.clone(), String::new()),
        config: Value::Null,
        connection: Value::Null,
    };
    // Input over Core's own 16 MiB, or a size no Core sends, is refused without a download. So is any input once Mac
    // access is Off.
    let unusable = "The Mac could not download this command's input from the cloud, so it did not run. Try again.";
    let mut expected = Vec::new();
    for (level, job, refused) in [
        (
            "off",
            json!({"id": "off", "stdin_bytes": 5}),
            "Mac access is off.",
        ),
        (
            "full",
            json!({"id": "big", "stdin_bytes": jobs::LIMIT + 1}),
            unusable,
        ),
        (
            "full",
            json!({"id": "negative", "stdin_bytes": -2}),
            unusable,
        ),
        (
            "full",
            json!({"id": "inline", "stdin": "00".repeat(jobs::LIMIT + 1)}),
            unusable,
        ),
    ] {
        access(level);
        let mut job = job;
        job["command"] = json!("true");
        jobs.clone().execute(core.clone(), "mac".into(), job).await;
        expected.push((json!(126), json!(super::hex(refused.as_bytes()))));
    }
    let done: Vec<(Value, Value)> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, body)| body["state"] == "done")
        .map(|(_, body)| (body["code"].clone(), body["stderr"].clone()))
        .collect();
    assert_eq!(done, expected);
    assert!(
        !seen
            .lock()
            .unwrap()
            .iter()
            .any(|(line, _)| line.contains("/stdin"))
    );
    // The longest real job is taken, and a line longer than any job ends the stream.
    let ended = jobs.stream(&core, "mac", &mut false).await;
    assert!(matches!(ended, Err(super::net::Error::Value(text)) if text == "Mac job is too large"));
    let taken = || {
        seen.lock().unwrap().iter().any(|(line, body)| {
            line.starts_with("post /v1/mac/results/streamed") && body["state"] == "running"
        })
    };
    for _ in 0..100 {
        if taken() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(taken());
    std::fs::remove_dir_all(root).unwrap();
}
