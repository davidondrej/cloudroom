use cloudroom::session::Journal;
use std::{
    fs,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
    time::{SystemTime, UNIX_EPOCH},
};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let name = format!(
            "cloudroom-journal-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        Self(std::env::temp_dir().join(name))
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn pending_records_and_acknowledgements_survive_restart() {
    let dir = Directory::new();
    let mut journal = Journal::open(&dir.0).unwrap();
    assert_eq!(journal.append(b"first native record\n").unwrap(), 1);
    assert_eq!(
        journal.append("early input: héllo\n".as_bytes()).unwrap(),
        2
    );
    journal.acknowledge(1).unwrap();
    assert!(journal.acknowledge(3).is_err());
    assert!(Journal::open(&dir.0).is_err());
    drop(journal);
    fs::write(dir.0.join("pending.tmp"), b"incomplete write").unwrap();
    let mut journal = Journal::open(&dir.0).unwrap();
    assert_eq!((journal.saved(), journal.last()), (1, 2));
    assert_eq!(journal.read(2).unwrap(), "early input: héllo\n".as_bytes());
    assert_eq!(journal.append(b"third").unwrap(), 3);
    journal.acknowledge(3).unwrap();
    journal.acknowledge(3).unwrap();
    assert!(journal.acknowledge(2).is_err());
    drop(journal);
    assert_eq!(Journal::open(&dir.0).unwrap().saved(), 3);
}

#[test]
fn gaps_and_uncertain_writes_fail_closed() {
    let dir = Directory::new();
    let mut journal = Journal::open(&dir.0).unwrap();
    journal.append(b"preserved").unwrap();
    // A write that fails before its rename (a full disk) changes nothing, so the next write may go ahead.
    fs::create_dir(dir.0.join("pending.tmp")).unwrap();
    assert!(journal.append(b"failed").is_err());
    fs::remove_dir(dir.0.join("pending.tmp")).unwrap();
    assert_eq!(journal.append(b"second").unwrap(), 2);
    // A failed rename has an uncertain outcome: nothing is written until the journal is reopened.
    fs::create_dir(dir.0.join("00000000000000000003.record")).unwrap();
    assert!(journal.append(b"failed").is_err());
    fs::remove_dir(dir.0.join("00000000000000000003.record")).unwrap();
    assert!(journal.append(b"must not retry silently").is_err());
    drop(journal);
    let mut journal = Journal::open(&dir.0).unwrap();
    assert_eq!(journal.read(1).unwrap(), b"preserved");
    assert_eq!(journal.append(b"explicit recovery").unwrap(), 3);
    drop(journal);
    fs::remove_file(dir.0.join("00000000000000000001.record")).unwrap();
    assert!(Journal::open(&dir.0).is_err());
}

#[test]
fn journal_survives_killed_writer() {
    const CHILD_DIRECTORY: &str = "CLOUDROOM_JOURNAL_TEST_CHILD";
    if let Some(directory) = std::env::var_os(CHILD_DIRECTORY) {
        let directory = PathBuf::from(directory);
        let mut journal = Journal::open(&directory).unwrap();
        journal.append(b"saved fixture record").unwrap();
        journal.acknowledge(1).unwrap();
        journal.append(b"pending fixture record").unwrap();
        fs::write(directory.join("pending.tmp"), b"partial next record").unwrap();
        fs::write(directory.join("ready"), b"ready").unwrap();
        loop {
            thread::park();
        }
    }

    // Always reap this test's child, including on an assertion failure.
    struct Writer(Child);
    impl Drop for Writer {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let directory = Directory::new();
    let mut writer = Writer(
        Command::new(std::env::current_exe().unwrap())
            .env_clear()
            .env(CHILD_DIRECTORY, &directory.0)
            .args(["--exact", "journal_survives_killed_writer", "--nocapture"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while !directory.0.join("ready").exists() {
        assert!(
            writer.0.try_wait().unwrap().is_none(),
            "writer exited early"
        );
        assert!(Instant::now() < deadline, "writer did not become ready");
        thread::sleep(Duration::from_millis(10));
    }
    writer.0.kill().unwrap();
    assert!(!writer.0.wait().unwrap().success());
    let mut recovered = Journal::open(&directory.0).unwrap();
    assert_eq!((recovered.saved(), recovered.last()), (1, 2));
    assert_eq!(recovered.read(2).unwrap(), b"pending fixture record");
    assert_eq!(recovered.append(b"after recovery").unwrap(), 3);
    assert_eq!(recovered.read(1).unwrap(), b"saved fixture record");
}
