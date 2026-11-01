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

/// Writes records straight to files: appending thousands of them fsyncs each one.
fn records(dir: &Directory, count: u64, record: impl Fn(u64) -> Vec<u8>) {
    fs::create_dir(&dir.0).unwrap();
    for id in 1..=count {
        fs::write(dir.0.join(format!("{id:020}.record")), record(id)).unwrap();
    }
}

#[test]
fn saved_records_fold_into_segments_and_stay_readable() {
    let dir = Directory::new();
    let record = |id: u64| format!("{{\"sequence\":{id}}}").into_bytes();
    let file = |id: u64| dir.0.join(format!("{id:020}.record"));
    records(&dir, 2060, record);
    let mut journal = Journal::open(&dir.0).unwrap();
    journal.acknowledge(2059).unwrap();
    drop(journal);
    // A failed pass keeps its place and the next one retries it.
    fs::remove_file(file(5)).unwrap();
    fs::create_dir(file(5)).unwrap();
    let mut next = None;
    assert!(Journal::compact(&dir.0, &mut next, 2059).is_err());
    assert_eq!(next, Some(0));
    fs::remove_dir(file(5)).unwrap();
    fs::write(file(5), record(5)).unwrap();
    Journal::compact(&dir.0, &mut next, 2059).unwrap();
    // Two whole blocks of saved records; the rest stay files, and uploads read the unsaved ones.
    assert_eq!(next, Some(2));
    let files = fs::read_dir(&dir.0).unwrap().count();
    assert!(files < 20, "{files} files left");
    assert!(file(2060).is_file());
    // A file an interrupted run left behind breaks neither a restart from the snapshot's cursor (here that file)
    // nor a full one, and the next run, which starts at the segments' last block, deletes it.
    fs::write(file(2000), record(2000)).unwrap();
    for known in [2000, 0] {
        let journal = Journal::open_from(&dir.0, known).unwrap();
        assert_eq!((journal.saved(), journal.last()), (2059, 2060));
    }
    let mut journal = Journal::open_from(&dir.0, 2000).unwrap();
    for id in [1, 5, 1024, 1025, 2000, 2048, 2049, 2060] {
        assert_eq!(journal.read(id).unwrap(), record(id));
    }
    assert_eq!(journal.append(&record(2061)).unwrap(), 2061);
    let mut next = None;
    Journal::compact(&dir.0, &mut next, journal.saved()).unwrap();
    assert!(!file(2000).exists());
    assert_eq!(journal.read(2000).unwrap(), record(2000));
}

#[test]
fn large_records_split_segments_so_a_read_decompresses_little() {
    let dir = Directory::new();
    // 20 KiB records: the first 1,024 are 20 MiB, so each segment takes 256 (5 MiB). Record 1000 is over 8 MiB on its
    // own, so it stays a file, and the small block after it still folds into one segment.
    let record = |id: u64| {
        let size = match id {
            1000 => 9 << 20,
            ..=1024 => 20 << 10,
            _ => 10,
        };
        format!("{{\"sequence\":{id},\"text\":\"{}\"}}", "x".repeat(size)).into_bytes()
    };
    records(&dir, 2048, record);
    let mut journal = Journal::open(&dir.0).unwrap();
    journal.acknowledge(2048).unwrap();
    Journal::compact(&dir.0, &mut None, 2048).unwrap();
    let mut segments: Vec<_> = (fs::read_dir(&dir.0).unwrap())
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".jsonl.gz"))
        .collect();
    segments.sort();
    assert!(segments[0].starts_with("00000000000000000001-00000000000000000256"));
    assert!(
        segments
            .last()
            .unwrap()
            .starts_with("00000000000000001025-00000000000000002048")
    );
    let files: Vec<_> = (fs::read_dir(&dir.0).unwrap())
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".record"))
        .collect();
    assert_eq!(files, ["00000000000000001000.record"]);
    for id in [1, 256, 257, 999, 1000, 1001, 1024, 1025, 2048] {
        assert_eq!(journal.read(id).unwrap(), record(id));
    }
    drop(journal);
    assert_eq!(Journal::open(&dir.0).unwrap().last(), 2048);
}

#[test]
fn an_oversized_segment_fails_without_being_decompressed_whole() {
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;
    let dir = Directory::new();
    records(&dir, 1030, |id| id.to_string().into_bytes());
    // A segment whose 1,024 lines decompress to 9 MiB, from 9 KiB each.
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    for _ in 1..=1024 {
        encoder.write_all(&[b'x'; 9 << 10]).unwrap();
        encoder.write_all(b"\n").unwrap();
    }
    let segment = dir
        .0
        .join("00000000000000000001-00000000000000001024.jsonl.gz");
    fs::write(&segment, encoder.finish().unwrap()).unwrap();
    for id in 1..=1024 {
        fs::remove_file(dir.0.join(format!("{id:020}.record"))).unwrap();
    }
    let mut journal = Journal::open(&dir.0).unwrap();
    assert_eq!(journal.last(), 1030);
    let error = journal.read(1).unwrap_err().to_string();
    assert!(error.contains("oversized"), "{error}");
    assert_eq!(journal.read(1025).unwrap(), b"1025");
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
    // A rename that failed for anything but space (here EISDIR) is uncertain: nothing is written until the journal
    // is reopened. A rename refused for space keeps it writable (outbox.rs tests, #211).
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

#[test]
fn a_full_disk_tells_the_user_the_way_in() {
    use cloudroom::session::Error;
    // A locked journal answers every message and Stop with this, so it must name the only command that still works (#211).
    for detail in [
        "session journal is not writable",
        "No space left on device (os error 28)",
    ] {
        let message = Error::Storage(detail.into()).message();
        assert!(message.contains("room-cli vm run --thread"), "{message}");
    }
    assert!(
        !Error::Storage("saved history: invalid".into())
            .message()
            .contains("room-cli")
    );
}
