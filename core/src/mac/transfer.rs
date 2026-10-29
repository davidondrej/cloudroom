//! `room-cli mac pull` and `push`. Up to 16 MiB still travels in one Mac job, as before. Bigger copies, up to
//! 2 GiB, go in 8 MiB pieces through the same jobs: staged in a Mac temp folder, then checked with SHA-256.
//! Every piece of a copy runs the same command, with its number in stdin, so the Mac helper's Jev check
//! (ADR 0224) reviews one command per copy, not one per piece.
use super::{LIMIT, finished, hex, literal, quote, request};
use serde_json::json;
use std::{
    fs,
    hash::{BuildHasher, RandomState},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const MIB: u64 = 1024 * 1024;
/// The AWS CLI's multipart default, well inside one job's 16 MiB output.
const PIECE: u64 = 8 * MIB;
const MAX: u64 = 2048 * MIB;
const TRIES: u32 = 3;
/// The pack job's exit code when its archive is too big for one job and waits in a Mac temp folder.
const STAGED: i32 = 75;
/// SHA-256 of stdin on macOS and Linux.
const SHA: &str = "{ sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-64";
/// Read-only Mac access may write in /tmp.
const MKTEMP: &str = "mktemp -d /tmp/cloudroom.XXXXXX";
/// Turns a source `$p` of `.`, `..`, `dir/.`, or `link/` into the real folder it names, and its entry name into
/// `$n`, as `realpath` would.
const RESOLVE: &str = "case $p in */) [ -L \"${p%/}\" ] && p=$p.;; esac; \
     case $(basename -- \"$p\") in .|..) p=$(cd -P -- \"$p\" >/dev/null && pwd -P) || exit 1;; esac; n=$(basename -- \"$p\");";

pub(super) async fn pull(socket: &str, source: &str, target: &str) -> io::Result<i32> {
    // cp rules (#222): an existing folder, or a path ending in `/`, gets the copy inside it. Any other path is
    // the copy's new name: it unpacks in a temp folder next to it, then moves into place, never replacing anything.
    let path = Path::new(target);
    let inside = target.ends_with('/') || path.is_dir();
    let taken = || {
        io::Error::other(format!(
            "VM path {target} already exists; nothing was copied"
        ))
    };
    if !inside && path.symlink_metadata().is_ok() {
        return Err(taken());
    }
    // `head` stops the archive one byte past the limit, so an oversized pull never fills the Mac's disk. A source
    // like `.` or `dir/..` becomes the folder it names, so the archive always holds one named entry; its name
    // comes back on stderr for "to".
    let pack = format!(
        "p={}; {RESOLVE} t=$({MKTEMP}) || exit 1; cd -- \"$(dirname -- \"$p\")\" || {{ rm -rf \"$t\"; exit 1; }}; \
         {{ COPYFILE_DISABLE=1 tar --no-xattrs -czf - -- \"$n\" || touch \"$t/failed\"; }} \
         | head -c {} > \"$t/a.tgz\"; s=$(wc -c < \"$t/a.tgz\" | tr -d ' '); \
         if [ \"$s\" -gt {MAX} ]; then rm -rf \"$t\"; echo 'The packed files are over the 2 GiB limit' >&2; exit 1; fi; \
         if [ -e \"$t/failed\" ]; then rm -rf \"$t\"; exit 1; fi; printf '%s\\n' \"$n\" >&2; \
         if [ \"$s\" -le {LIMIT} ]; then cat \"$t/a.tgz\"; rm -rf \"$t\"; exit 0; fi; \
         printf '%s\\n%s\\n%s' \"$t\" \"$s\" \"$(cat \"$t/a.tgz\" | {SHA})\"; exit {STAGED}",
        quote(source),
        MAX + 1
    );
    let archive = Temp::file("pull")?;
    let name = match run(socket, pack, &[], false).await? {
        (Some(0), stdout, stderr) => {
            fs::write(&archive.0, stdout)?;
            stderr
        }
        (Some(STAGED), stdout, stderr) => {
            let text = String::from_utf8_lossy(&stdout);
            let &[dir, size, sha] = &text.split('\n').collect::<Vec<_>>()[..] else {
                return Err(io::Error::other("invalid Mac archive"));
            };
            let dir = temp_dir(dir)?;
            let fetched = fetch(socket, &dir, size, sha, &archive.0).await;
            let _ = job(socket, format!("rm -rf {dir}"), &[], false).await;
            fetched?;
            stderr
        }
        (_, _, stderr) => return Err(failed(&stderr)),
    };
    let staging = if inside {
        fs::create_dir_all(path)?;
        None
    } else {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent)?;
        Some(Temp::folder(parent.join(format!(".{}", unique("pull"))))?)
    };
    let unpacked = tokio::process::Command::new("tar")
        .arg("-xzf")
        .arg(&archive.0)
        .arg("-C")
        .arg(staging.as_ref().map_or(path, |dir| &dir.0))
        .status()
        .await?;
    if !unpacked.success() {
        return Err(io::Error::other("Could not unpack the copied files"));
    }
    let to = match &staging {
        None => path.join(last_line(&String::from_utf8_lossy(&name))),
        Some(dir) => {
            let entries = fs::read_dir(&dir.0)?.collect::<io::Result<Vec<_>>>()?;
            let [entry] = &entries[..] else {
                return Err(io::Error::other("Could not unpack the copied files"));
            };
            // Placed so nothing is replaced, even a path made during a slow copy: a folder by renaming it onto a
            // new empty folder, a symlink anew, a file as a hard link, or as an exclusive copy where a disk has no
            // hard links (FAT, SMB).
            let (kind, from) = (entry.file_type()?, entry.path());
            let placed = if kind.is_dir() {
                fs::create_dir(path).and_then(|()| {
                    fs::rename(&from, path).inspect_err(|_| drop(fs::remove_dir(path)))
                })
            } else if kind.is_symlink() {
                std::os::unix::fs::symlink(fs::read_link(&from)?, path)
            } else {
                fs::hard_link(&from, path).or_else(|error| match error.kind() {
                    io::ErrorKind::AlreadyExists => Err(error),
                    _ => copy_new(&from, path),
                })
            };
            match placed {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Err(taken()),
                placed => placed?,
            }
            path.to_owned()
        }
    };
    println!("{}", json!({"copied":source,"to":to}));
    Ok(0)
}

/// Copies a staged Mac archive into `path` piece by piece, then checks its SHA-256.
async fn fetch(socket: &str, dir: &str, size: &str, sha: &str, path: &Path) -> io::Result<()> {
    let size: u64 = size
        .parse()
        .map_err(|_| io::Error::other("invalid Mac archive size"))?;
    if size > MAX {
        return Err(io::Error::other(
            "The packed files are over the 2 GiB limit",
        ));
    }
    let mut file = fs::File::create(path)?;
    let pieces = size.div_ceil(PIECE);
    let command = format!(
        "dd if={dir}/a.tgz bs={MIB} count={} skip=$(cat)",
        PIECE / MIB
    );
    for i in 0..pieces {
        let skip = (i * (PIECE / MIB)).to_string();
        let want = PIECE.min(size - i * PIECE);
        let bytes = piece(socket, &command, skip.as_bytes(), Some(want)).await?;
        file.write_all(&bytes)?;
        progress(i, pieces);
    }
    verify(path, sha).await
}

pub(super) async fn push(socket: &str, source: &str, target: &str) -> io::Result<i32> {
    // `.` and `..` name no entry, and `link/` means the folder a link points to, so copy that real folder, as
    // `cp -r . new` and `cp -R link/ new` do.
    let link = source.ends_with('/') && Path::new(source.trim_end_matches('/')).is_symlink();
    let path = match Path::new(source).file_name() {
        Some(_) if !link => PathBuf::from(source),
        _ => fs::canonicalize(source)
            .map_err(|error| io::Error::other(format!("VM path {source}: {error}")))?,
    };
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(io::Error::other("push needs a file or folder path"));
    };
    // tar reads `parent/name`, so `file.txt/` still works.
    if let Err(error) = parent.join(name).symlink_metadata() {
        return Err(io::Error::other(format!("VM path {source}: {error}")));
    }
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let archive = Temp::file("push")?;
    let packed = tokio::process::Command::new("tar")
        .arg("-czf")
        .arg(&archive.0)
        .arg("-C")
        .arg(parent)
        .arg("--")
        .arg(name)
        .status()
        .await?;
    let size = fs::metadata(&archive.0).map_or(u64::MAX, |m| m.len());
    if !packed.success() {
        return Err(io::Error::other("Could not pack the files"));
    }
    if size > MAX {
        return Err(io::Error::other(
            "The packed files are over the 2 GiB limit",
        ));
    }
    // cp rules, as in `pull`. The archive unpacks into "$x": the folder itself, or a temp folder next to the new
    // name that a cancel removes, with any staged pieces. `used` refuses a taken name before the unpack and again
    // right before the move, after `mkdir -p` made any `..` real; POSIX `mv` can't refuse to replace, so a
    // microsecond race remains. `place` prints where the copy landed. Kept short for the Ask-first dialog.
    let unpack = |pieces: &str| {
        format!(
            "d={}; n={}; p=$(dirname -- \"$d\"); mkdir -p -- \"${}\" || exit 1; used() {{ [ -e \"$d\" ] || [ -L \"$d\" ] && \
             printf '%s already exists; nothing was copied\\n' \"$d\" >&2; }}; if [ -d \"$d\" ]; then x=$d; to=${{d%/}}/$n; \
             else used && exit 1; x=$(mktemp -d \"$p/.cloudroom.XXXXXX\"); trap 'rm -rf \"$x\"{pieces}; exit 1' 1 2 15; to=$d; fi; ",
            quote(target),
            literal(&name.to_string_lossy()),
            if target.ends_with('/') { 'd' } else { 'p' },
        )
    };
    let place = "s=$?; [ \"$x\" = \"$d\" ] || { [ $s = 0 ] && ! used && mv -- \"$x/$n\" \"$d\" || s=1; rm -rf \"$x\"; }; \
                 [ $s != 0 ] || printf '%s\\n' \"$to\"; ";
    let out = if size <= LIMIT as u64 {
        let input = fs::read(&archive.0)?;
        job(
            socket,
            format!("{}tar -xzf - -C \"$x\"; {place}exit $s", unpack("")),
            &input,
            true,
        )
        .await?
    } else {
        let dir = temp_dir(&String::from_utf8_lossy(
            &job(socket, MKTEMP.into(), &[], false).await?,
        ))?;
        let clean = || job(socket, format!("rm -rf {dir}"), &[], false);
        if let Err(error) = stage(socket, &dir, &archive.0, size).await {
            let _ = clean().await;
            return Err(error);
        }
        // Only the unpack changes the Mac, so Ask first asks once. It removes the staging itself, and an
        // unknown outcome (`?`) leaves it alone, so cleanup never deletes files an unpack is still reading.
        let unpack = format!(
            "{}cat {dir}/* | tar -xzf - -C \"$x\"; {place}rm -rf {dir}; exit $s",
            unpack(&format!(" {dir}"))
        );
        match run(socket, unpack, &[], true).await? {
            (Some(0), stdout, _) => stdout,
            (_, _, stderr) => {
                let _ = clean().await; // Refused, denied, or stopped before the unpack removed the staging.
                return Err(failed(&stderr));
            }
        }
    };
    let to = String::from_utf8_lossy(&out);
    println!("{}", json!({"copied":source,"to":last_line(&to)}));
    Ok(0)
}

/// Stages `path` in a Mac temp folder piece by piece and checks its SHA-256 there, all read-only.
async fn stage(socket: &str, dir: &str, path: &Path, size: u64) -> io::Result<()> {
    let file = fs::File::open(path)?;
    let pieces = size.div_ceil(PIECE);
    // Each piece lands under a hidden name, then moves into place whole: a late copy of a retried piece
    // can only swap in identical bytes, never half-rewrite one.
    let command = format!(
        "n=$(dd bs=1 count=5 2>/dev/null) && cat > {dir}/.$n.$$ && mv -f {dir}/.$n.$$ {dir}/$n"
    );
    for i in 0..pieces {
        let mut input = format!("{i:05}").into_bytes();
        (&file).take(PIECE).read_to_end(&mut input)?;
        piece(socket, &command, &input, None).await?;
        progress(i, pieces);
    }
    let sha = job(socket, format!("cat {dir}/* | {SHA}"), &[], false).await?;
    verify(path, &String::from_utf8_lossy(&sha)).await
}

/// Runs one Mac command: its exit code, stdout, and stderr.
async fn run(
    socket: &str,
    command: String,
    stdin: &[u8],
    write: bool,
) -> io::Result<(Option<i32>, Vec<u8>, Vec<u8>)> {
    let body = json!({"command":command,"stdin":hex(stdin),"write":write});
    let value = request(socket, "POST", "/jobs", Some(body)).await?;
    if let Some(id) = value["job"].as_str().filter(|_| value["state"] == "done") {
        let _ = request(socket, "DELETE", &format!("/jobs/{id}"), None).await;
    }
    finished(value)
}

/// Runs one Mac command and returns its stdout, or an error with its stderr.
async fn job(socket: &str, command: String, stdin: &[u8], write: bool) -> io::Result<Vec<u8>> {
    match run(socket, command, stdin, write).await? {
        (Some(0), stdout, _) => Ok(stdout),
        (_, _, stderr) => Err(failed(&stderr)),
    }
}

/// A Mac command's error output as an error, without its final newline.
fn failed(stderr: &[u8]) -> io::Error {
    io::Error::other(String::from_utf8_lossy(stderr).trim_end().to_owned())
}

/// One piece, tried up to three times. A piece only reads or overwrites its own bytes, so repeating it is safe.
/// A pulled piece must bring exactly `want` bytes; a pushed piece's output is ignored.
async fn piece(
    socket: &str,
    command: &str,
    stdin: &[u8],
    want: Option<u64>,
) -> io::Result<Vec<u8>> {
    let mut tries = 1;
    loop {
        let error = match (job(socket, command.to_owned(), stdin, false).await, want) {
            (Ok(bytes), Some(want)) if bytes.len() as u64 != want => io::Error::other(format!(
                "a piece arrived with {} of {want} bytes",
                bytes.len()
            )),
            (Ok(bytes), _) => return Ok(bytes),
            (Err(error), _) => error,
        };
        if tries == TRIES {
            return Err(error);
        }
        eprintln!("Retrying a piece: {error}");
        tries += 1;
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn progress(i: u64, pieces: u64) {
    if i % 8 == 7 || i + 1 == pieces {
        eprintln!("Copied {} of {pieces} pieces", i + 1);
    }
}

/// The last line a Mac command printed: a chatty login shell may print before it.
fn last_line(text: &str) -> &str {
    text.trim().lines().last().unwrap_or_default()
}

/// The Mac temp folder from `MKTEMP`, checked before any `rm -rf`, so cleanup never removes anything else.
fn temp_dir(text: &str) -> io::Result<String> {
    let dir = last_line(text);
    match dir.strip_prefix("/tmp/cloudroom.") {
        Some(name) if !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric()) => {
            Ok(dir.to_owned())
        }
        _ => Err(io::Error::other("The Mac temp folder is unavailable")),
    }
}

/// Fails unless the local file's SHA-256 matches the Mac's.
async fn verify(path: &Path, mac: &str) -> io::Result<()> {
    let out = tokio::process::Command::new("sha256sum")
        .arg(path)
        .output()
        .await?;
    let local = String::from_utf8_lossy(&out.stdout);
    if out.status.success() && local.get(..64) == Some(last_line(mac)) {
        return Ok(());
    }
    Err(io::Error::other(
        "The copy was damaged on the way (SHA-256 mismatch); try again",
    ))
}

/// Copies a file to a new path, never replacing one, and keeps its permissions.
fn copy_new(from: &Path, to: &Path) -> io::Result<()> {
    let mut source = fs::File::open(from)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
    let copied = io::copy(&mut source, &mut file)
        .and_then(|_| file.set_permissions(source.metadata()?.permissions()));
    copied.inspect_err(|_| drop(fs::remove_file(to)))
}

/// A random temp name, so neither a parallel copy nor a stale one from a killed run can take or block it.
fn unique(kind: &str) -> String {
    let random = RandomState::new().hash_one(std::process::id());
    format!("cloudroom-{kind}-{random:016x}")
}

/// A local temp archive or folder that this copy created (`true` marks a folder), removed when dropped.
struct Temp(PathBuf, bool);
impl Temp {
    fn file(kind: &str) -> io::Result<Self> {
        let path = std::env::temp_dir().join(format!("{}.tgz", unique(kind)));
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(Self(path, false))
    }
    fn folder(path: PathBuf) -> io::Result<Self> {
        fs::create_dir(&path)?;
        Ok(Self(path, true))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = match self.1 {
            true => fs::remove_dir_all(&self.0),
            false => fs::remove_file(&self.0),
        };
    }
}
