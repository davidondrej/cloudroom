#![cfg(unix)]
use std::{ffi::OsStr, os::unix::ffi::OsStrExt, process::Command};

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
