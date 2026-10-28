use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

/// Append-only durable records. External acknowledgement is separate from local acceptance.
/// A single service owns this directory; incomplete temporary writes are never replayed.
pub struct Journal {
    directory: PathBuf,
    next: u64,
    saved: u64,
    /// The last record of the batch being uploaded. Saved before sending, so a restart resends the exact same batch.
    uploading: Option<u64>,
    writable: bool,
    _lock: File,
}

const SNAPSHOT: &str = "snapshot.json";

fn record_name(id: u64) -> String {
    format!("{id:020}.record")
}

impl Journal {
    pub fn open(directory: &Path) -> io::Result<Self> {
        Self::open_from(directory, 0)
    }

    /// `known` is the last record a replay snapshot covers. Listing every record of a large journal is slow,
    /// so a present `known` record skips the listing and only the records after it are counted.
    pub fn open_from(directory: &Path, known: u64) -> io::Result<Self> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(directory)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(directory.join("lock"))?;
        lock.try_lock()
            .map_err(|_| io::Error::other("state directory already in use"))?;
        let last = if known > 0 && directory.join(record_name(known)).is_file() {
            let mut last = known;
            while directory.join(record_name(last + 1)).is_file() {
                last += 1;
            }
            last
        } else {
            Self::count(directory)?
        };
        let saved = match fs::read_to_string(directory.join("saved")) {
            Ok(value) => value
                .parse()
                .map_err(|_| io::Error::other("invalid saved cursor"))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => 0,
            Err(e) => return Err(e),
        };
        if saved > last {
            return Err(io::Error::other("saved cursor exceeds journal"));
        }
        let uploading = fs::read_to_string(directory.join("uploading"))
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|end| *end > saved && *end <= last);
        Ok(Self {
            directory: directory.into(),
            next: last + 1,
            saved,
            uploading,
            writable: true,
            _lock: lock,
        })
    }

    /// Lists every record and checks they run from 1 without gaps.
    fn count(directory: &Path) -> io::Result<u64> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "record") {
                let id = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .ok_or_else(|| io::Error::other("invalid journal filename"))?;
                if path.file_name().and_then(|s| s.to_str()) != Some(&record_name(id)) {
                    return Err(io::Error::other("noncanonical journal filename"));
                }
                ids.push(id);
            }
        }
        ids.sort_unstable();
        if ids.iter().copied().ne(1..=ids.len() as u64) {
            return Err(io::Error::other("journal has missing or duplicate records"));
        }
        Ok(ids.len() as u64)
    }

    pub fn append(&mut self, record: &[u8]) -> io::Result<u64> {
        let id = self.next;
        self.write_atomic(&record_name(id), record)?;
        self.next += 1;
        Ok(id)
    }

    /// The replay snapshot (`Local::save_snapshot`), if one was saved.
    pub fn read_snapshot(directory: &Path) -> Option<Vec<u8>> {
        fs::read(directory.join(SNAPSHOT)).ok()
    }

    /// Replaces the snapshot whole. It is only a shortcut: a lost or stale one costs a longer replay, never
    /// records, so it skips the journal's write guard.
    pub fn write_snapshot(&self, bytes: &[u8]) -> io::Result<()> {
        let temporary = self.directory.join("snapshot.tmp");
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(temporary, self.directory.join(SNAPSHOT))
    }

    pub fn read(&self, id: u64) -> io::Result<Vec<u8>> {
        if id == 0 || id >= self.next {
            return Err(io::Error::other("record outside journal"));
        }
        fs::read(self.directory.join(record_name(id)))
    }

    /// Reads a record already written, without holding whoever owns the journal: records never change.
    pub fn read_written(directory: &Path, id: u64) -> io::Result<Vec<u8>> {
        fs::read(directory.join(record_name(id)))
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn uploading(&self) -> Option<u64> {
        self.uploading.filter(|end| *end > self.saved)
    }

    pub fn begin_upload(&mut self, end: u64) -> io::Result<()> {
        if end <= self.saved || end >= self.next {
            return Err(io::Error::other("invalid upload batch"));
        }
        self.write_atomic("uploading", end.to_string().as_bytes())?;
        self.uploading = Some(end);
        Ok(())
    }

    pub fn writable(&self) -> bool {
        self.writable
    }

    pub fn last(&self) -> u64 {
        self.next - 1
    }
    pub fn saved(&self) -> u64 {
        self.saved
    }

    /// Called only after the API confirms the complete prefix was saved.
    pub fn acknowledge(&mut self, id: u64) -> io::Result<()> {
        if id < self.saved || id >= self.next {
            return Err(io::Error::other("invalid acknowledgement"));
        }
        self.write_atomic("saved", id.to_string().as_bytes())?;
        self.saved = id;
        Ok(())
    }

    fn write_atomic(&mut self, name: &str, bytes: &[u8]) -> io::Result<()> {
        if !self.writable {
            return Err(io::Error::other(
                "journal requires recovery after a write failure",
            ));
        }
        // A failure before the rename leaves the journal as it was (a full disk fails here), so only that write fails.
        let temporary = self.directory.join("pending.tmp");
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        // A rename followed by a failed directory fsync has an uncertain outcome.
        // Refuse further writes until reopening, rather than overwrite that record.
        self.writable = false;
        fs::rename(temporary, self.directory.join(name))?;
        File::open(&self.directory)?.sync_all()?;
        self.writable = true;
        Ok(())
    }
}
