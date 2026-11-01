use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
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
    /// The last segment read, so a replay or page of old records decompresses each segment once.
    segment: Option<Segment>,
    _lock: File,
}

const SNAPSHOT: &str = "snapshot.json";
/// Saved records are folded into gzip segments (`compact`). One file per record took ~4.6 KiB of disk each: 3.5 GiB
/// on a busy sandbox (#280). A segment is ~16x smaller and still a full local copy. Each covers an aligned run of at
/// most SEGMENT records and SEGMENT_BYTES of them: all a read ever decompresses. A bigger record stays a file.
pub(super) const SEGMENT: u64 = 1024;
const SEGMENT_BYTES: u64 = 8 << 20;

/// A decompressed segment: line `i` is record `first + i` and ends at `ends[i]`.
struct Segment {
    first: u64,
    text: Vec<u8>,
    ends: Vec<usize>,
}

fn record_name(id: u64) -> String {
    format!("{id:020}.record")
}

fn segment_name(first: u64, last: u64) -> String {
    format!("{first:020}-{last:020}.jsonl.gz")
}

/// The segment holding record `id`. Runs are aligned powers of two, so this tries at most 11 names, never a listing.
fn segment_of(directory: &Path, id: u64) -> Option<(u64, u64)> {
    let mut size = SEGMENT;
    loop {
        let first = (id - 1) / size * size + 1;
        if directory
            .join(segment_name(first, first + size - 1))
            .is_file()
        {
            return Some((first, first + size - 1));
        }
        if size == 1 {
            return None;
        }
        size /= 2;
    }
}

/// Decompresses a segment, never more than SEGMENT_BYTES, and checks it holds exactly its records.
fn read_segment(directory: &Path, first: u64, last: u64) -> io::Result<Segment> {
    let mut text = Vec::new();
    GzDecoder::new(File::open(directory.join(segment_name(first, last)))?)
        .take(SEGMENT_BYTES + 1)
        .read_to_end(&mut text)?;
    let count = (last - first + 1) as usize;
    let ends: Vec<usize> = (text.iter().enumerate())
        .filter_map(|(i, b)| (*b == b'\n').then_some(i))
        .take(count + 1)
        .collect();
    if text.len() as u64 > SEGMENT_BYTES || ends.len() != count || text.last() != Some(&b'\n') {
        return Err(io::Error::other("damaged or oversized journal segment"));
    }
    Ok(Segment { first, text, ends })
}

/// Makes renames in the directory durable.
fn sync_directory(directory: &Path) -> io::Result<()> {
    #[cfg(test)]
    if tests::FAILED_SYNCS.replace(tests::FAILED_SYNCS.get().saturating_sub(1)) > 0 {
        return Err(io::Error::other("injected directory sync failure"));
    }
    File::open(directory)?.sync_all()
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
        // A record file at or before the segments' end is one an interrupted `compact` left behind.
        let compacted = Self::compacted(directory);
        let last = if known > compacted && directory.join(record_name(known)).is_file() {
            let mut last = known;
            while directory.join(record_name(last + 1)).is_file() {
                last += 1;
            }
            last
        } else {
            Self::count(directory, compacted)?
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
            segment: None,
            _lock: lock,
        })
    }

    /// Lists every record and checks they run on from the segments without gaps.
    fn count(directory: &Path, compacted: u64) -> io::Result<u64> {
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
                // Files an interrupted `compact` left behind duplicate its segment.
                if id > compacted {
                    ids.push(id);
                }
            }
        }
        ids.sort_unstable();
        if ids
            .iter()
            .copied()
            .ne(compacted + 1..=compacted + ids.len() as u64)
        {
            return Err(io::Error::other("journal has missing or duplicate records"));
        }
        Ok(compacted + ids.len() as u64)
    }

    /// The last record of the segments that run from record 1, with the records too big for one between them.
    pub fn compacted(directory: &Path) -> u64 {
        let mut last = 0;
        loop {
            if let Some((_, end)) = segment_of(directory, last + 1) {
                last = end;
            } else if fs::metadata(directory.join(record_name(last + 1)))
                .is_ok_and(|m| m.len() >= SEGMENT_BYTES)
            {
                last += 1;
            } else {
                return last;
            }
        }
    }

    /// Folds whole blocks of SEGMENT saved records into segments, from block `next` on. Only saved ones: uploads read
    /// records as files (`read_written`). `None` starts at the segments' last block, which deletes files an interrupted
    /// run left there. Without other writers, so it never holds the journal. At most 64 blocks a call (~3 s), so a
    /// large backlog doesn't hold up uploads for long. A failure leaves `next` at the block to retry.
    pub fn compact(directory: &Path, next: &mut Option<u64>, saved: u64) -> io::Result<()> {
        let block =
            next.get_or_insert_with(|| Self::compacted(directory).saturating_sub(1) / SEGMENT);
        for _ in 0..64 {
            if (*block + 1) * SEGMENT > saved {
                break;
            }
            Self::fold(directory, *block * SEGMENT + 1, (*block + 1) * SEGMENT)?;
            *block += 1;
        }
        Ok(())
    }

    /// Writes records `first..=last` as one segment, or as two halves while they are over SEGMENT_BYTES, then deletes
    /// their files. Missing files mean a half was written before a crash: the halves finish the job. A record over
    /// SEGMENT_BYTES on its own stays a file.
    fn fold(directory: &Path, first: u64, last: u64) -> io::Result<()> {
        let name = directory.join(segment_name(first, last));
        if name.is_file() {
            // A retry after a failed directory sync: the segment must read back whole before its files go.
            read_segment(directory, first, last)?;
        } else {
            let mut bytes = 0;
            for id in first..=last {
                match fs::metadata(directory.join(record_name(id))) {
                    Ok(metadata) => bytes += metadata.len() + 1,
                    Err(e) if e.kind() == io::ErrorKind::NotFound && first < last => {
                        bytes = u64::MAX;
                        break;
                    }
                    Err(e) => return Err(e),
                }
            }
            if bytes > SEGMENT_BYTES {
                if first == last {
                    return Ok(());
                }
                let middle = first + (last - first) / 2;
                Self::fold(directory, first, middle)?;
                return Self::fold(directory, middle + 1, last);
            }
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            for id in first..=last {
                let record = fs::read(directory.join(record_name(id)))?;
                if record.contains(&b'\n') {
                    return Err(io::Error::other("record spans lines"));
                }
                encoder.write_all(&record)?;
                encoder.write_all(b"\n")?;
            }
            let temporary = directory.join("segment.tmp");
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&encoder.finish()?)?;
            file.sync_all()?;
            fs::rename(temporary, name)?;
        }
        sync_directory(directory)?;
        for id in first..=last {
            match fs::remove_file(directory.join(record_name(id))) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        Ok(())
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

    pub fn read(&mut self, id: u64) -> io::Result<Vec<u8>> {
        if id == 0 || id >= self.next {
            return Err(io::Error::other("record outside journal"));
        }
        match fs::read(self.directory.join(record_name(id))) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            read => return read,
        }
        let cached = |s: &Segment| (s.first..s.first + s.ends.len() as u64).contains(&id);
        if !self.segment.as_ref().is_some_and(cached) {
            self.segment = None;
            let (first, last) = segment_of(&self.directory, id)
                .ok_or_else(|| io::Error::other("record missing from journal"))?;
            self.segment = Some(read_segment(&self.directory, first, last)?);
        }
        let segment = self.segment.as_ref().unwrap();
        let line = (id - segment.first) as usize;
        let start = line.checked_sub(1).map_or(0, |i| segment.ends[i] + 1);
        Ok(segment.text[start..segment.ends[line]].to_vec())
    }

    /// Reads an unsaved record already written, without holding whoever owns the journal: records never change.
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
        // A rename refused for space changed nothing (a full disk can refuse a new directory block), so only that
        // write fails (#211). Any other failed rename, or a failed directory fsync after one, has an uncertain outcome:
        // refuse further writes until reopening, rather than overwrite that record.
        let renamed = fs::rename(temporary, self.directory.join(name));
        self.writable = renamed.as_ref().is_err_and(no_space);
        renamed?;
        File::open(&self.directory)?.sync_all()?;
        self.writable = true;
        Ok(())
    }
}

/// Errors that guarantee the filesystem refused the change before making it.
fn no_space(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    thread_local! {
        /// How many directory syncs fail before they work again.
        pub(super) static FAILED_SYNCS: Cell<u32> = const { Cell::new(0) };
    }

    #[test]
    fn record_files_are_deleted_only_after_a_directory_sync() {
        let dir = std::env::temp_dir().join(format!("cloudroom-sync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).unwrap();
        for id in 1..=SEGMENT {
            fs::write(dir.join(record_name(id)), id.to_string()).unwrap();
        }
        // The segment is renamed in but its sync fails, and so does the retry's: no record file goes either time.
        FAILED_SYNCS.set(2);
        for _ in 0..2 {
            assert!(Journal::compact(&dir, &mut None, SEGMENT).is_err());
            assert!(dir.join(segment_name(1, SEGMENT)).is_file());
            assert!(dir.join(record_name(1)).is_file());
        }
        Journal::compact(&dir, &mut None, SEGMENT).unwrap();
        assert!(!dir.join(record_name(1)).exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_a_rename_refused_for_space_keeps_the_journal_writable() {
        // ENOSPC and EDQUOT keep it writable; EIO, EISDIR and ENOTEMPTY may follow a completed rename, so they lock it.
        use io::ErrorKind::*;
        for (kind, writable) in [
            (StorageFull, true),
            (QuotaExceeded, true),
            (Other, false),
            (IsADirectory, false),
            (DirectoryNotEmpty, false),
        ] {
            assert_eq!(super::no_space(&kind.into()), writable, "{kind:?}");
        }
    }
}
