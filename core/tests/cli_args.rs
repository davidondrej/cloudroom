#![cfg(unix)]
use std::{
    ffi::OsStr,
    io::{ErrorKind, Read, Write},
    os::unix::{ffi::OsStrExt, net::UnixListener},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

// #705: an argument that isn't UTF-8 panicked (exit 101) before any command ran.
#[test]
fn non_utf8_argument_is_a_clear_error() {
    let output = Command::new(env!("CARGO_BIN_EXE_cloudroom"))
        // A dead socket, so a regression could never run anything on the paired Mac.
        .args(["mac", "--socket", "/dev/null", "run", "echo"])
        .arg(OsStr::from_bytes(b"caf\xe9"))
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(2), "{stderr}");
    assert!(stderr.contains("Argument 6 isn't valid UTF-8"), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
}

// #1274: `kill` ended a pull at once, leaving its VM archive and its Mac temp folder with the whole archive.
#[test]
fn a_killed_pull_stops_its_mac_job_and_removes_its_temp_files() {
    let folder = std::env::temp_dir().join(format!("cloudroom-test-1274-{}", std::process::id()));
    std::fs::create_dir(&folder).unwrap();
    let socket = folder.join("mac.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let mut pull = Command::new(env!("CARGO_BIN_EXE_cloudroom"))
        .args(["mac", "--socket", socket.to_str().unwrap(), "pull", "~/big"])
        .arg(folder.join("to/"))
        .env("TMPDIR", &folder)
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let (mut pack, _) = listener.accept().unwrap();
    pack.set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    let mut buffer = [0; 65536];
    let _ = pack.read(&mut buffer).unwrap();
    let killed = Command::new("kill")
        .args(["-TERM", &pull.id().to_string()])
        .status();
    assert!(killed.unwrap().success());
    // The waiting request closes, which makes Core stop the Mac job.
    while pack.read(&mut buffer).unwrap() > 0 {}
    listener.set_nonblocking(true).unwrap();
    let started = Instant::now();
    let mut clean = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                assert!(
                    pull.try_wait().unwrap().is_none(),
                    "room-cli ended without cleaning up"
                );
                assert!(started.elapsed() < Duration::from_secs(30));
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => panic!("{error}"),
        }
    };
    clean.set_nonblocking(false).unwrap();
    let mut request = Vec::new();
    while !request.ends_with(b"}") {
        let n = clean.read(&mut buffer).unwrap();
        assert!(n > 0);
        request.extend_from_slice(&buffer[..n]);
    }
    let done = r#"{"state":"done","code":0,"stdout":"","stderr":""}"#;
    let reply = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{done}",
        done.len()
    );
    clean.write_all(reply.as_bytes()).unwrap();
    drop(clean);
    let code = pull.wait().unwrap().code();
    let left: Vec<_> = std::fs::read_dir(&folder)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    std::fs::remove_dir_all(&folder).unwrap();
    assert_eq!(code, Some(143));
    let request = String::from_utf8(request).unwrap();
    assert!(
        request.contains(r#""command":"rm -rf /tmp/cloudroom-copy-"#),
        "{request}"
    );
    assert_eq!(left, ["mac.sock"]);
}
