//! `cloudroom fs`: the file reads and writes behind the app's file tree, file viewer, and editor. The host daemon runs
//! the app's bundled copy for Local threads; a sandbox's copy can answer the same commands for Cloud threads.
//!
//! Each command reads one JSON request on stdin and prints one JSON reply on stdout, in the shapes of the `host.*`
//! commands in `@cloudroom/host-daemon-contract`. A refusal prints `{"error":{"code","message","expected"}}` and exits
//! with 1. Cloud downloads keep their 3 MB pieces (`download` in the server's teleport-local.ts), under the VM
//! command's output limit.
//!
//! Saves lock the file's folder, then check the expected hash, then rename a finished copy over the file, so two saves
//! from the same hash give one success and one conflict. Plain `std` and `serde_json`, so it also builds for Windows.
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::{Output, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const USAGE: &str = "Usage: cloudroom fs COMMAND
The file reads and writes behind the Cloudroom app's file tree, viewer, and editor.

  read | read-relative | metadata | write | list | mkdir | move | remove | exists
      One JSON request on stdin, one JSON reply on stdout

Exit codes: 1 refused (JSON on stdout), 2 usage.";

/// Saves, and reads of anything but images.
const FILE_BYTES: u64 = 25 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(5);
const BLOB_TIMEOUT: Duration = Duration::from_secs(30);
/// Subfolders a listing skips when it can't read them.
const SKIPPED: [io::ErrorKind; 3] = [
    io::ErrorKind::PermissionDenied,
    io::ErrorKind::NotFound,
    io::ErrorKind::NotADirectory,
];

struct Refusal {
    code: String,
    message: String,
    expected: bool,
}

type Result<T> = std::result::Result<T, Refusal>;

fn refuse<T>(code: &str, message: impl Into<String>) -> Result<T> {
    Err(Refusal {
        code: code.to_owned(),
        message: message.into(),
        expected: false,
    })
}

/// A missing file is an expected answer, not a failure.
fn missing(path: &str) -> Refusal {
    Refusal {
        code: "ENOENT".to_owned(),
        message: format!("Path does not exist: {path}"),
        expected: true,
    }
}

impl From<io::Error> for Refusal {
    fn from(error: io::Error) -> Self {
        Refusal {
            code: errno(&error).to_owned(),
            message: error.to_string(),
            expected: false,
        }
    }
}

/// Node's names for the errors callers tell apart.
fn errno(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::PermissionDenied if error.raw_os_error() == Some(1) => "EPERM",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::NotADirectory => "ENOTDIR",
        io::ErrorKind::IsADirectory => "EISDIR",
        io::ErrorKind::DirectoryNotEmpty => "ENOTEMPTY",
        io::ErrorKind::CrossesDevices => "EXDEV",
        _ => "EIO",
    }
}

/// Reads that the OS refuses. macOS privacy checks fail with EPERM and can stop a long-running app mid-session
/// (#1127), so those get their own message.
fn denied_or(error: io::Error) -> Refusal {
    if error.kind() != io::ErrorKind::PermissionDenied {
        return error.into();
    }
    let message = if cfg!(target_os = "macos") && error.raw_os_error() == Some(1) {
        "macOS blocked Cloudroom from reading this folder. Quit and reopen Cloudroom; if it keeps happening, check Cloudroom's access in System Settings > Privacy & Security.".to_owned()
    } else {
        error.to_string()
    };
    Refusal {
        code: "permission_denied".to_owned(),
        message,
        expected: false,
    }
}

/// Runs `cloudroom fs ARGS` and returns the exit code.
pub fn cli(args: &[String]) -> i32 {
    let reply = match args {
        [command] if command == "--help" => {
            println!("{USAGE}");
            return 0;
        }
        [command] => {
            let mut input = String::new();
            let request = io::stdin()
                .read_to_string(&mut input)
                .ok()
                .and_then(|_| serde_json::from_str::<Value>(&input).ok());
            let Some(request) = request.filter(Value::is_object) else {
                eprintln!("cloudroom fs {command}: send one JSON object on stdin.");
                return 2;
            };
            match command.as_str() {
                "read" => read(&request),
                "read-relative" => read_relative(&request),
                "metadata" => metadata(&request),
                "write" => write(&request),
                "list" => list(&request),
                "mkdir" => mkdir(&request),
                "move" => move_path(&request),
                "remove" => remove(&request),
                "exists" => exists(&request),
                _ => {
                    eprintln!("{USAGE}");
                    return 2;
                }
            }
        }
        _ => {
            eprintln!("{USAGE}");
            return 2;
        }
    };
    let (output, code) = match reply {
        Ok(value) => (value, 0),
        Err(refusal) => (
            json!({"error": {"code": refusal.code, "message": refusal.message, "expected": refusal.expected}}),
            1,
        ),
    };
    let mut stdout = io::stdout().lock();
    let written = serde_json::to_writer(&mut stdout, &output).is_ok() && stdout.flush().is_ok();
    if written { code } else { 1 }
}

// ---- Requests

fn text<'a>(request: &'a Value, field: &str) -> Result<&'a str> {
    match request.get(field).and_then(Value::as_str) {
        Some(value) if !value.is_empty() => Ok(value),
        _ => refuse("invalid_request", format!("{field} is required")),
    }
}

fn optional<'a>(request: &'a Value, field: &str) -> Option<&'a str> {
    request.get(field).and_then(Value::as_str)
}

fn flag(request: &Value, field: &str) -> bool {
    request.get(field).and_then(Value::as_bool).unwrap_or(false)
}

fn absolute<'a>(request: &'a Value, field: &str, label: &str) -> Result<&'a str> {
    let value = text(request, field)?;
    if Path::new(value).is_absolute() {
        Ok(value)
    } else {
        refuse("invalid_path", format!("{label} must be absolute"))
    }
}

fn root(request: &Value) -> Result<Option<&str>> {
    match optional(request, "rootPath") {
        Some(root) if !Path::new(root).is_absolute() => {
            refuse("invalid_path", "rootPath must be absolute")
        }
        root => Ok(root),
    }
}

// ---- Paths

/// A real folder that is not itself a link, with every link in its path resolved.
fn real_dir(path: &Path, description: &str) -> Result<PathBuf> {
    let info = fs::symlink_metadata(path)?;
    if info.file_type().is_symlink() {
        return refuse(
            "invalid_path",
            format!("{description} \"{}\" must not be a symlink", path.display()),
        );
    }
    if !info.is_dir() {
        return refuse(
            "invalid_path",
            format!("{description} \"{}\" is not a directory", path.display()),
        );
    }
    Ok(fs::canonicalize(path)?)
}

fn within(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}

/// `path.resolve` for an absolute path: `.` and `..` resolved by name, without touching the disk.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// A path that must stay inside `root` after links: the real path, or why not.
fn readable(path: &Path, shown: &str, root: Option<&str>) -> Result<PathBuf> {
    let Some(root) = root else {
        return Ok(path.to_path_buf());
    };
    let root =
        real_dir(Path::new(root), "Root path").map_err(|refusal| match refusal.code.as_str() {
            "ENOENT" => missing(shown),
            _ => refusal,
        })?;
    let real = fs::canonicalize(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => missing(shown),
        _ => denied_or(error),
    })?;
    if !within(&root, &real) {
        return refuse(
            "invalid_path",
            format!("Path \"{shown}\" escapes read root"),
        );
    }
    Ok(real)
}

fn stat_file(path: &Path, shown: &str) -> Result<Metadata> {
    let info = fs::metadata(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => missing(shown),
        _ => denied_or(error),
    })?;
    if info.is_dir() {
        return refuse("invalid_path", "Path is a directory, not a file");
    }
    Ok(info)
}

fn modified_ms(info: &Metadata) -> Value {
    info.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(Value::Null, |time| {
            json!(time.as_secs() as f64 * 1e3 + f64::from(time.subsec_nanos()) / 1e6)
        })
}

// ---- Reads

/// The reply for a file's bytes: text when it is UTF-8 (and not an image), base64 otherwise, or `notModified`
/// when the caller already has these bytes.
fn file_reply(
    contents: &[u8],
    shown: &str,
    size: u64,
    image: bool,
    mtime: Value,
    if_none_match: Option<&Value>,
) -> Value {
    let sha256 = sha256_hex(contents);
    let text = if image {
        None
    } else {
        std::str::from_utf8(contents).ok()
    };
    let mut reply = Map::new();
    reply.insert(
        "contentEncoding".into(),
        json!(if text.is_some() { "utf8" } else { "base64" }),
    );
    if !mtime.is_null() {
        reply.insert("modifiedAtMs".into(), mtime);
    }
    reply.insert("path".into(), json!(shown));
    reply.insert("sizeBytes".into(), json!(size));
    let unchanged = if_none_match.is_some_and(|condition| {
        condition.get("kind").and_then(Value::as_str) == Some("any")
            || condition
                .get("values")
                .and_then(Value::as_array)
                .is_some_and(|values| {
                    values
                        .iter()
                        .any(|value| value.as_str() == Some(sha256.as_str()))
                })
    });
    reply.insert("sha256".into(), json!(sha256));
    if unchanged {
        reply.insert("notModified".into(), json!(true));
    } else {
        reply.insert(
            "content".into(),
            json!(text.map_or_else(|| base64(contents), str::to_owned)),
        );
    }
    Value::Object(reply)
}

fn too_large(what: &str, size: u64, limit: u64) -> Refusal {
    Refusal {
        code: "file_too_large".to_owned(),
        message: format!(
            "{what} size {size} bytes exceeds the {} MB limit",
            limit / (1024 * 1024)
        ),
        expected: false,
    }
}

/// `host.read_file`. The app passes `image` and `limit`, since it owns the file types.
fn read(request: &Value) -> Result<Value> {
    let shown = absolute(request, "path", "Path")?;
    let root = root(request)?;
    let image = flag(request, "image");
    let limit = request
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(FILE_BYTES);
    let condition = request.get("ifNoneMatch");
    if let Some(reference) = optional(request, "ref") {
        let Some(root) = root else {
            return refuse("invalid_path", "rootPath is required when ref is set");
        };
        return read_ref(
            Path::new(root),
            Path::new(shown),
            shown,
            reference,
            image,
            limit,
            condition,
        );
    }
    let path = readable(Path::new(shown), shown, root)?;
    let info = stat_file(&path, shown)?;
    #[cfg(unix)]
    if std::os::unix::fs::FileTypeExt::is_fifo(&info.file_type()) {
        // Reading a FIFO blocks until a writer appears.
        return refuse("invalid_path", "Path is a FIFO, not a file");
    }
    if info.len() > limit {
        return Err(too_large("File", info.len(), limit));
    }
    let contents = fs::read(&path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => missing(shown),
        _ => denied_or(error),
    })?;
    Ok(file_reply(
        &contents,
        shown,
        info.len(),
        image,
        modified_ms(&info),
        condition,
    ))
}

/// A file as committed at `reference`. A path missing there reads as an empty file.
fn read_ref(
    root: &Path,
    path: &Path,
    shown: &str,
    reference: &str,
    image: bool,
    limit: u64,
    condition: Option<&Value>,
) -> Result<Value> {
    let safe = !reference.starts_with('-')
        && !reference.contains("..")
        && reference
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./~^@-".contains(c));
    if !safe {
        return refuse("invalid_ref", format!("Invalid git ref: {reference}"));
    }
    let lexical_path = lexical(path);
    let relative = match lexical_path.strip_prefix(lexical(root)) {
        Ok(relative) if !relative.as_os_str().is_empty() => relative,
        _ => {
            return refuse(
                "invalid_path",
                format!("Path \"{shown}\" escapes read root"),
            );
        }
    };
    let parts: Vec<_> = relative.iter().map(|part| part.to_string_lossy()).collect();
    let object = format!("{reference}:{}", parts.join("/"));
    let check = git(
        root,
        &["cat-file", "--batch-check"],
        Some(&object),
        GIT_TIMEOUT,
    )?;
    if !check.status.success() {
        return refuse(
            "git_command_failed",
            String::from_utf8_lossy(&check.stderr).trim().to_owned(),
        );
    }
    let line = String::from_utf8_lossy(&check.stdout).trim_end().to_owned();
    // A path missing at that ref, or a ref that names nothing: `<object> missing`. The object may hold spaces.
    if line.ends_with(" missing") || line.ends_with(" ambiguous") {
        return Ok(file_reply(&[], shown, 0, image, Value::Null, condition));
    }
    let fields: Vec<&str> = line.split(' ').collect();
    match fields.as_slice() {
        [_, "blob", size] => {
            let size: u64 = size.parse().unwrap_or(u64::MAX);
            if size > limit {
                return Err(too_large("Blob", size, limit));
            }
            let blob = git(root, &["cat-file", "blob", &object], None, BLOB_TIMEOUT)?;
            Ok(file_reply(
                &blob.stdout,
                shown,
                size,
                image,
                Value::Null,
                condition,
            ))
        }
        [_, kind, _] => refuse(
            "git_command_failed",
            format!("git cat-file -t {object} returned {kind}, expected blob"),
        ),
        _ => refuse(
            "git_command_failed",
            format!("git cat-file could not read {object}"),
        ),
    }
}

/// `host.read_file_relative`: a path under `rootPath`, written with `/`, that may not climb out.
fn read_relative(request: &Value) -> Result<Value> {
    let root = absolute(request, "rootPath", "rootPath")?;
    let relative = text(request, "path")?;
    let segments: Vec<&str> = relative.split('/').collect();
    if relative.contains(['\0', '\\'])
        || relative.starts_with('/')
        || segments
            .iter()
            .any(|s| s.is_empty() || *s == "." || *s == "..")
    {
        return refuse("invalid_path", "Path must be relative");
    }
    if optional(request, "dotfiles") != Some("allow") && segments.iter().any(|s| s.starts_with('.'))
    {
        return Err(missing(relative));
    }
    let path = segments
        .iter()
        .fold(PathBuf::from(root), |path, segment| path.join(segment));
    let path = readable(&path, relative, Some(root))?;
    let info = stat_file(&path, relative)?;
    let contents = fs::read(&path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => missing(relative),
        _ => denied_or(error),
    })?;
    Ok(file_reply(
        &contents,
        relative,
        info.len(),
        flag(request, "image"),
        modified_ms(&info),
        None,
    ))
}

/// `host.file_metadata`.
fn metadata(request: &Value) -> Result<Value> {
    let shown = absolute(request, "path", "Path")?;
    let path = readable(Path::new(shown), shown, root(request)?)?;
    let info = stat_file(&path, shown)?;
    Ok(json!({"path": shown, "modifiedAtMs": modified_ms(&info), "sizeBytes": info.len()}))
}

// ---- Writes

struct Target {
    path: PathBuf,
    /// The deepest folder that exists: saves lock it.
    folder: PathBuf,
    parent_missing: bool,
    /// The first missing part exists as a link to nowhere, which a write would follow.
    dangling: bool,
}

/// Where a write lands once links are resolved, even when the file or its folders don't exist yet.
fn write_target(path: &Path, shown: &str) -> Result<Target> {
    match fs::canonicalize(path) {
        Ok(real) => {
            let folder = real
                .parent()
                .map_or_else(|| real.clone(), Path::to_path_buf);
            return Ok(Target {
                path: real,
                folder,
                parent_missing: false,
                dangling: false,
            });
        }
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.into()),
        Err(_) => {}
    }
    let mut missing_parts = vec![path.file_name().map(PathBuf::from).unwrap_or_default()];
    let mut ancestor = path.parent().unwrap_or(path).to_path_buf();
    loop {
        match fs::canonicalize(&ancestor) {
            Ok(real) => {
                let dangling = fs::symlink_metadata(real.join(&missing_parts[0])).is_ok();
                let target = missing_parts
                    .iter()
                    .fold(real.clone(), |target, part| target.join(part));
                return Ok(Target {
                    path: target,
                    folder: real,
                    parent_missing: missing_parts.len() > 1,
                    dangling,
                });
            }
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error.into()),
            Err(_) => {}
        }
        let Some(parent) = ancestor.parent().filter(|parent| *parent != ancestor) else {
            return Err(missing(shown));
        };
        missing_parts.insert(
            0,
            ancestor.file_name().map(PathBuf::from).unwrap_or_default(),
        );
        ancestor = parent.to_path_buf();
    }
}

/// Holds an exclusive lock on a folder until dropped, so saves into it from separate processes take turns. Best
/// effort: a folder the OS won't open for reading (or Windows, which can't open folders this way) saves unlocked.
fn lock_folder(folder: &Path) -> Option<File> {
    let file = File::open(folder).ok()?;
    file.lock().ok()?;
    Some(file)
}

fn sha_or_null(path: &Path) -> Value {
    fs::read(path).map_or(Value::Null, |contents| json!(sha256_hex(&contents)))
}

/// `host.write_file`. `expectedSha256` absent writes over anything; null means "only if the file doesn't exist".
fn write(request: &Value) -> Result<Value> {
    let shown = absolute(request, "path", "Path")?;
    let root = root(request)?;
    let content = request
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let contents = match optional(request, "contentEncoding") {
        Some("base64") => unbase64(content),
        _ => content.as_bytes().to_vec(),
    };
    if contents.len() as u64 > FILE_BYTES {
        return Err(too_large("File", contents.len() as u64, FILE_BYTES));
    }
    let expected = request.get("expectedSha256");
    let mode = request
        .get("mode")
        .and_then(Value::as_u64)
        .map(|mode| mode as u32 & 0o777);
    let create_parents = flag(request, "createParents");
    let parent_shown = Path::new(shown)
        .parent()
        .map_or_else(String::new, |parent| parent.display().to_string());

    let target = write_target(&lexical(Path::new(shown)), shown)?;
    let _lock = lock_folder(&target.folder);
    if let Some(root) = root {
        let root = real_dir(Path::new(root), "Root path").map_err(|refusal| {
            match refusal.code.as_str() {
                "ENOENT" => missing(shown),
                _ => refusal,
            }
        })?;
        if target.dangling || !within(&root, &target.path) {
            return refuse(
                "invalid_path",
                format!("Path \"{shown}\" escapes write root"),
            );
        }
    }
    if target.parent_missing && !create_parents {
        return Err(missing(&parent_shown));
    }
    let (current, current_mode) = match fs::metadata(&target.path) {
        Ok(info) if info.is_dir() => {
            return refuse("invalid_path", "Path is a directory, not a file");
        }
        Ok(info) => (Some(fs::read(&target.path)?), Some(permissions(&info))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => (None, None),
        Err(error) => return Err(error.into()),
    };
    let current_sha = current.as_deref().map(sha256_hex);
    if let Some(expected) = expected
        && expected.as_str() != current_sha.as_deref()
    {
        return Ok(json!({"outcome": "conflict", "currentSha256": current_sha}));
    }
    if create_parents && let Some(parent) = target.path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mode = mode.or(current_mode);
    let failed = |error: io::Error| match error.kind() {
        io::ErrorKind::NotFound => missing(&parent_shown),
        io::ErrorKind::NotADirectory | io::ErrorKind::IsADirectory => Refusal {
            code: "invalid_path".to_owned(),
            message: format!("Cannot write file at {shown}"),
            expected: false,
        },
        _ => error.into(),
    };
    if expected.is_none() {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        set_mode(&mut options, mode);
        options
            .open(&target.path)
            .and_then(|mut file| file.write_all(&contents))
            .map_err(failed)?;
    } else {
        let temporary = Temporary::create(&target.path, &contents, mode).map_err(failed)?;
        if expected.is_some_and(Value::is_null) {
            // A hard link never replaces a file, so a file made meanwhile is a conflict, not lost.
            if let Err(error) = fs::hard_link(&temporary.0, &target.path) {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    return Ok(
                        json!({"outcome": "conflict", "currentSha256": sha_or_null(&target.path)}),
                    );
                }
                return Err(failed(error));
            }
        } else {
            let latest = sha_or_null(&target.path);
            if expected != Some(&latest) {
                return Ok(json!({"outcome": "conflict", "currentSha256": latest}));
            }
            fs::rename(&temporary.0, &target.path).map_err(failed)?;
        }
    }
    Ok(json!({"outcome": "written", "sha256": sha256_hex(&contents), "sizeBytes": contents.len()}))
}

/// A finished copy beside the target, removed when dropped unless it was renamed into place.
struct Temporary(PathBuf);

impl Temporary {
    fn create(target: &Path, contents: &[u8], mode: Option<u32>) -> io::Result<Self> {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut name = target.as_os_str().to_owned();
        name.push(format!(".cloudroom-write-{}-{nonce:x}", std::process::id()));
        let temporary = Self(PathBuf::from(name));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        set_mode(&mut options, mode);
        let mut file = options.open(&temporary.0)?;
        file.write_all(contents)?;
        file.sync_all()?;
        Ok(temporary)
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(unix)]
fn permissions(info: &Metadata) -> u32 {
    std::os::unix::fs::PermissionsExt::mode(&info.permissions()) & 0o777
}

#[cfg(not(unix))]
fn permissions(_: &Metadata) -> u32 {
    0o666
}

#[cfg(unix)]
fn set_mode(options: &mut OpenOptions, mode: Option<u32>) {
    if let Some(mode) = mode {
        std::os::unix::fs::OpenOptionsExt::mode(options, mode);
    }
}

#[cfg(not(unix))]
fn set_mode(_: &mut OpenOptions, _: Option<u32>) {}

/// An existing path, not itself a link, inside `root` when one is given.
fn existing_within(shown: &str, root: Option<&str>) -> Result<(PathBuf, Option<PathBuf>)> {
    if fs::symlink_metadata(shown)?.file_type().is_symlink() {
        return refuse(
            "invalid_path",
            format!("Path \"{shown}\" must not be a symbolic link"),
        );
    }
    let target = fs::canonicalize(shown)?;
    let root = root
        .map(|root| real_dir(Path::new(root), "Root path"))
        .transpose()?;
    if root.as_ref().is_some_and(|root| !within(root, &target)) {
        return refuse("invalid_path", format!("Path \"{shown}\" escapes root"));
    }
    Ok((target, root))
}

/// `host.mkdir`.
fn mkdir(request: &Value) -> Result<Value> {
    let shown = absolute(request, "path", "Path")?;
    let root = root(request)?
        .map(|root| real_dir(Path::new(root), "Root path"))
        .transpose()?;
    let target = write_target(Path::new(shown), shown)?;
    if root
        .as_ref()
        .is_some_and(|root| !within(root, &target.path))
    {
        return refuse("invalid_path", format!("Path \"{shown}\" escapes root"));
    }
    if flag(request, "recursive") {
        fs::create_dir_all(&target.path)?;
    } else {
        fs::create_dir(&target.path)?;
    }
    Ok(json!({"ok": true}))
}

/// `host.move_path`: never over an existing path.
fn move_path(request: &Value) -> Result<Value> {
    let source = absolute(request, "sourcePath", "Path")?;
    let root = root(request)?;
    let (source, _) = existing_within(source, root)?;
    let shown = absolute(request, "destinationPath", "destinationPath")?;
    let destination = Path::new(shown);
    let parent = fs::canonicalize(destination.parent().unwrap_or(destination))?;
    let destination = parent.join(destination.file_name().unwrap_or_default());
    let root = root
        .map(|root| real_dir(Path::new(root), "Root path"))
        .transpose()?;
    if root
        .as_ref()
        .is_some_and(|root| !within(root, &destination))
    {
        return refuse("invalid_path", format!("Path \"{shown}\" escapes root"));
    }
    if fs::symlink_metadata(&destination).is_ok() {
        return refuse(
            "path_exists",
            format!("Destination already exists: {shown}"),
        );
    }
    fs::rename(source, destination)?;
    Ok(json!({"ok": true}))
}

/// `host.remove_path`: never the declared root itself.
fn remove(request: &Value) -> Result<Value> {
    let shown = absolute(request, "path", "Path")?;
    let (target, root) = existing_within(shown, root(request)?)?;
    if root.is_some_and(|root| root == target) {
        return refuse("invalid_path", "Cannot remove the declared root");
    }
    let recursive = flag(request, "recursive");
    match fs::symlink_metadata(&target)?.is_dir() {
        true if recursive => fs::remove_dir_all(&target)?,
        true => fs::remove_dir(&target)?,
        false => fs::remove_file(&target)?,
    }
    Ok(json!({"ok": true}))
}

/// `host.paths_exist`. Anything but "not there" counts as there.
fn exists(request: &Value) -> Result<Value> {
    let paths = request
        .get("paths")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let existence: Map<String, Value> = paths
        .iter()
        .filter_map(Value::as_str)
        .map(|path| {
            let gone = fs::metadata(path).is_err_and(|error| {
                matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                )
            });
            (path.to_owned(), json!(!gone))
        })
        .collect();
    Ok(json!({"existence": existence}))
}

// ---- Listing

/// `host.list_files` and `host.list_paths`, before the app ranks and trims them: every file and folder under
/// `path`, as `/` paths relative to it, in the folder's own order. Never `.git` or links; Git-ignored paths only when
/// asked.
fn list(request: &Value) -> Result<Value> {
    let shown = absolute(request, "path", "Path")?;
    let root = match real_dir(Path::new(shown), "Path") {
        Ok(root) => root,
        Err(refusal) if refusal.code == "ENOENT" => return Ok(json!({"paths": []})),
        Err(refusal) => return Err(refusal),
    };
    let names = |field: &str| -> HashSet<String> {
        request
            .get(field)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    let walk = Walk {
        root: &root,
        files: flag(request, "includeFiles"),
        folders: flag(request, "includeDirectories"),
        hidden: flag(request, "includeHidden"),
        excluded: names("excludeNames"),
        ignored: if flag(request, "respectGitIgnore") {
            ignored(&root)?
        } else {
            HashSet::new()
        },
    };
    let mut paths = Vec::new();
    walk.folder(&root, &mut paths)?;
    Ok(json!({"paths": paths}))
}

struct Walk<'a> {
    root: &'a Path,
    files: bool,
    folders: bool,
    hidden: bool,
    excluded: HashSet<String>,
    ignored: HashSet<String>,
}

impl Walk<'_> {
    fn folder(&self, dir: &Path, out: &mut Vec<Value>) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let kind = entry.file_type()?;
            if name == ".git"
                || self.excluded.contains(&name)
                || (!self.hidden && name.starts_with('.'))
                || kind.is_symlink()
            {
                continue;
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(self.root)
                .unwrap_or(&path)
                .iter()
                .map(|part| part.to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            if self.excluded.contains(&relative) || self.ignored.contains(&relative) {
                continue;
            }
            if kind.is_dir() {
                if self.folders {
                    out.push(json!({"kind": "directory", "path": relative, "name": name}));
                }
                match self.folder(&path, out) {
                    Err(error) if !SKIPPED.contains(&error.kind()) => return Err(error),
                    _ => {}
                }
            } else if self.files {
                out.push(json!({"kind": "file", "path": relative, "name": name}));
            }
        }
        Ok(())
    }
}

/// Git-ignored files and folders under a work tree's root, relative to it. Nothing outside a work tree.
fn ignored(root: &Path) -> Result<HashSet<String>> {
    let inside = git(
        root,
        &["rev-parse", "--is-inside-work-tree"],
        None,
        GIT_TIMEOUT,
    );
    if !inside.is_ok_and(|output| output.status.success() && output.stdout.starts_with(b"true")) {
        return Ok(HashSet::new());
    }
    let args = [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
    ];
    let output = git(root, &args, None, GIT_TIMEOUT)?;
    if !output.status.success() {
        return refuse(
            "git_command_failed",
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        );
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            String::from_utf8_lossy(entry)
                .trim_end_matches('/')
                .to_owned()
        })
        .collect())
}

/// Git with the Git panel's read-only settings, killed after `timeout`.
fn git(dir: &Path, args: &[&str], stdin: Option<&str>, timeout: Duration) -> Result<Output> {
    let mut child = crate::git::git_command()
        .args(args)
        .envs(crate::git::READ_ENV.iter().copied())
        .current_dir(dir)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| Refusal {
            code: "git_command_failed".to_owned(),
            message: format!("Git could not start: {error}"),
            expected: false,
        })?;
    if let (Some(line), Some(mut input)) = (stdin, child.stdin.take()) {
        let _ = writeln!(input, "{line}");
    }
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buffer);
            }
            buffer
        })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return refuse(
                "git_command_failed",
                format!(
                    "git {} timed out after {} s",
                    args.join(" "),
                    timeout.as_secs()
                ),
            );
        }
        thread::sleep(Duration::from_millis(5));
    };
    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

// ---- Encoding

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, byte)| n | u32::from(*byte) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                BASE64[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

/// Like Node's `Buffer.from(text, "base64")`: either alphabet, padding optional, other characters skipped.
fn unbase64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut bits, mut count) = (0u32, 0);
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = bits << 6 | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    out
}

/// SHA-256 (FIPS 180-4) as lowercase hex: the app's file version, so no crate for it.
fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut tail = data[data.len() / 64 * 64..].to_vec();
    tail.push(0x80);
    tail.resize(if tail.len() > 56 { 120 } else { 56 }, 0);
    tail.extend_from_slice(&(data.len() as u64 * 8).to_be_bytes());
    for block in data
        .as_chunks::<64>()
        .0
        .iter()
        .chain(tail.as_chunks::<64>().0)
    {
        let mut w = [0u32; 64];
        for (i, word) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*word);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ (!e & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(choice)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(majority);
            (hh, g, f, e, d, c, b, a) = (g, f, e, d.wrapping_add(t1), c, b, a, t1.wrapping_add(t2));
        }
        for (state, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *state = state.wrapping_add(value);
        }
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}
