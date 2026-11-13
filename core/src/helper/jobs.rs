//! Mac access (ADR 0113, levels in ADR 0186): commands from the user's cloud agents run as this user, only while
//! enabled. Every rule and message here matches client.py's MacJobs.

use super::net::{self, Core, Error, Result, Shared};
use super::{base64, hex, home, private_json, text, unhex};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, c_char};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) const LEVELS: [&str; 4] = ["off", "read-only", "ask", "full"];
pub(super) const LIMIT: usize = 16 * 1024 * 1024;
// A sandbox's agent has root, so it can answer in place of Core: the helper keeps no more than a real Core sends. The
// longest job line comes from cores up to 0.1.75, which send a job's input inside it as hex, beside a 64 KiB command
// that JSON escaping can make 6 times longer.
pub(super) const LINE: usize = 2 * LIMIT + 1024 * 1024;
// Hex characters per result request: some sandbox proxies drop requests over about 8 MB,
// and each part must upload within POST on a slow home connection.
const PART: usize = 1024 * 1024;
const POST: Duration = Duration::from_secs(60);
const SCRIPT_TYPES: [&str; 10] = [
    "sh", "bash", "zsh", "py", "js", "mjs", "cjs", "ts", "rb", "pl",
];
// Where read-only commands may write (READ_ONLY), so agents can swap paths there without asking.
pub(super) const TEMP_FOLDERS: [&str; 2] = ["/private/tmp", "/private/var/folders"];
// A push's own tar. macOS's bsdtar refuses `..` and writing through symlinks, even when PATH puts GNU tar first.
const COPY_TAR: &str = if cfg!(target_os = "macos") {
    "/usr/bin/tar"
} else {
    "tar"
};
const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;

// Read-only commands (ADR 0186): no file writes outside temp folders, no signals to other processes, and no tools that
// drive apps or system settings. Beyond those named tools, they cannot run programs from the writable temp folders, open
// apps or URLs through Launch Services, send Apple Events, create launchd jobs, or write preferences through cfprefsd.
// Nothing they start outlives them (end). They also cannot reach this Mac's own servers and sockets or read Cloudroom's
// folders beyond its tools, so they cannot act through the app or its tokens (ADR 0260). The internet works. Seatbelt's
// localhost misses IPv4-mapped IPv6, so IPv6 is blocked outright and clients fall back to IPv4.
const READ_ONLY: &str = r##"(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))(deny signal (target others))(deny process-exec (literal "/usr/bin/osascript") (literal "/usr/bin/open") (literal "/usr/bin/shortcuts") (literal "/usr/bin/automator") (literal "/bin/launchctl") (literal "/usr/bin/tccutil") (literal "/usr/bin/defaults"))(deny process-exec (subpath "/private/tmp") (subpath "/private/var/folders"))(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents") (global-name "com.apple.lsd.open") (global-name "com.apple.lsd.openurl") (global-name "com.apple.lsd.modifydb"))(deny appleevent-send)(deny job-creation)(deny user-preference-write)(deny network-outbound (remote ip4 "localhost:*") (remote ip6 "*:*") (remote unix-socket))(allow network-outbound (literal "/private/var/run/mDNSResponder"))"##;
// Cloudroom's own tools stay readable in its hidden data folder.
pub(super) const READ_ONLY_TOOLS: &str = r#"(allow file-read* (literal (param "DATA")) (subpath (param "DATA_BIN")) (subpath (param "DATA_HARNESS")))"#;
// Older machine installers kept the relay key in a temp file, and an interrupted install left it behind.
pub(super) const READ_ONLY_OLD_KEYS: &str = r##"(regex #"/bb-app\.[^/]+/access\.curl$")"##;
const ASK: &str = "on run argv\nactivate\ndisplay dialog (item 1 of argv) with title \"Cloudroom\" buttons {\"Allow\", \"Allow for this sandbox\", \"Deny\"} default button \"Deny\" cancel button \"Deny\" with icon caution giving up after 300\nreturn button returned of result\nend run";

const OFF: &str = "Mac access is off.";
const LIMITED: &str = "This sandbox has only the API keys picked for its Cloud loop, so it can't use the Mac. Do not retry. If the loop needs the Mac, the user can give it all secrets in its Secrets row. That applies from its next run.";
const UNCONFIRMED_KEYS: &str = "The Mac could not confirm this sandbox's API keys with Cloudroom, so the command did not run. Try again.";
const BAD_COPY: &str = "This copy has a name or place the Mac cannot use, so nothing was copied.";
const UNCONTAINED: &str =
    "This Mac can't make sure a read-only command leaves nothing running, so it did not run.";

type Key = (String, String);

/// Older setups stored on/off; on meant full access.
pub(super) fn level(config: &Value) -> &'static str {
    match &config["macAccess"] {
        Value::Bool(true) => "full",
        Value::String(value) => LEVELS
            .iter()
            .find(|level| *level == value)
            .copied()
            .unwrap_or("off"),
        _ => "off",
    }
}

fn rank(level: &str) -> usize {
    LEVELS.iter().position(|known| *known == level).unwrap_or(0)
}

/// The level the app saved, which setup may not have applied yet, or None without an app. Unreadable means off.
fn saved_level(config: &Value) -> Option<&'static str> {
    let file =
        Path::new(text(config, "connectionFile")?).with_file_name("cloudroom-mac-access.json");
    let raw = match std::fs::read_to_string(file) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return Some("off"),
    };
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(saved)) => {
            let value = saved.get("level").cloned().unwrap_or(Value::Bool(
                saved.get("enabled") == Some(&Value::Bool(true)),
            ));
            Some(level(&json!({"macAccess": value})))
        }
        _ => Some("off"),
    }
}

/// Python's truthiness, for job fields.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(items) => !items.is_empty(),
    }
}

/// Python's `os.path.realpath`: links resolved as far as the path exists, `..` after them.
pub(super) fn realpath(path: &Path) -> PathBuf {
    fn join(mut base: PathBuf, rest: &Path, depth: u32) -> PathBuf {
        if rest.is_absolute() {
            base = PathBuf::from("/");
        }
        for part in rest.components() {
            match part {
                Component::ParentDir => {
                    base.pop();
                }
                Component::Normal(name) => {
                    let next = base.join(name);
                    base = match std::fs::read_link(&next) {
                        Ok(target) if depth < 40 => join(base, &target, depth + 1),
                        _ => next,
                    };
                }
                _ => {}
            }
        }
        base
    }
    join(PathBuf::from("/"), path, 0)
}

/// `~` and `~/…` start at the home folder, as `os.path.expanduser`.
fn expanduser(text: &str, home: &Path) -> PathBuf {
    match text.strip_prefix('~') {
        Some("") => home.to_owned(),
        Some(rest) if rest.starts_with('/') => home.join(rest.trim_start_matches('/')),
        _ => PathBuf::from(text),
    }
}

/// Python's `shlex.quote`.
pub(super) fn quote(text: &str) -> String {
    if text.is_empty() {
        return "''".into();
    }
    if text
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c))
    {
        return text.into();
    }
    format!("'{}'", text.replace('\'', "'\"'\"'"))
}

/// Python's `urllib.parse.quote`.
fn quote_url(text: &str) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"_.-~/".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn thousands(number: usize) -> String {
    let digits = number.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// Python's `str.isprintable`: not a control, format, separator (other than space), private-use or unassigned character.
fn printable(c: char) -> bool {
    let code = c as u32;
    let hidden = c.is_control()
        || matches!(code, 0xad | 0x600..=0x605 | 0x61c | 0x6dd | 0x70f | 0x890..=0x891 | 0x8e2 | 0x180e | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x2064 | 0x2066..=0x206f | 0xfeff | 0xfff9..=0xfffb | 0x110bd | 0x110cd | 0x13430..=0x1343f | 0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a | 0xe0001 | 0xe0020..=0xe007f)
        || matches!(
            code,
            0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000
        )
        || matches!(code, 0xe000..=0xf8ff | 0xf0000..=0x10ffff | 0xfdd0..=0xfdef | 0x40000..=0xdffff)
        || code & 0xfffe == 0xfffe;
    !hidden
}

/// Python's `unicode_escape` for one character.
fn escape(c: char) -> String {
    match c {
        '\t' => "\\t".into(),
        '\n' => "\\n".into(),
        '\r' => "\\r".into(),
        c if (c as u32) < 0x100 => format!("\\x{:02x}", c as u32),
        c if (c as u32) < 0x10000 => format!("\\u{:04x}", c as u32),
        c => format!("\\U{:08x}", c as u32),
    }
}

/// The part of an agent's text the Ask first popup shows, and how many characters it leaves out. Characters the popup
/// could hide or show as something else, like \r or a right-to-left mark, show as escapes such as \u202e. Only \n breaks
/// lines, and with `lines` at 1 it is escaped too.
pub(super) fn visible(text: &str, chars: usize, lines: usize) -> (String, usize) {
    let (mut chars, mut lines) = (chars as i64, lines as i64);
    let keep = lines > 1;
    let (mut shown, mut count) = (String::new(), 0);
    for c in text.chars() {
        let piece = if printable(c) || keep && c == '\n' {
            c.to_string()
        } else {
            escape(c)
        };
        lines -= i64::from(piece == "\n");
        chars -= piece.chars().count() as i64;
        if chars < 0 || lines == 0 {
            break;
        }
        shown.push_str(&piece);
        count += 1;
    }
    (shown, text.chars().count() - count)
}

/// Agent text under its label in the Ask first popup: its lines are indented, and the popup's own lines are not.
fn block(text: &str) -> String {
    format!("    {}", text.replace('\n', "\n    "))
}

/// What the Ask first popup says. The command comes first, and the folder after it on one line, so a folder name can't
/// pose as the command. Hidden parts still run: warn above them, where padding can't push the warning out of view. A
/// push shows only where its one item lands, because the command built here places nothing else (#222).
pub(super) fn popup_text(job: &Value, home: &Path) -> String {
    if truthy(&job["copy"]) {
        let place = job["place"][0].as_str().unwrap_or_default();
        let home = home.to_string_lossy();
        let shown = match place.strip_prefix(&format!("{home}/")) {
            Some(rest) => format!("~/{rest}"),
            None => place.to_owned(),
        };
        let (lands, cut) = visible(&shown, 300, 1);
        let note = if job["place"][1].as_bool() == Some(true) {
            "It replaces a file with the same name there, and merges into a folder with the same name."
        } else {
            "It gets this new name."
        };
        let ellipsis = if cut > 0 { "…" } else { "" };
        return format!(
            "A cloud agent wants to copy a file or folder to your Mac.\n\nCopy to: {lands}{ellipsis}\n\nOnly this one item is copied. {note}"
        );
    }
    let raw = job["command"].as_str().unwrap_or_default();
    let (command, hidden) = visible(raw.trim_end(), 600, 10);
    let mut warnings = if hidden > 0 {
        format!(
            "Warning: {} more characters of this command are not shown, and will also run.\n\n",
            thousands(hidden)
        )
    } else {
        String::new()
    };
    if ["/tmp", "/var/folders", "TMPDIR"]
        .iter()
        .any(|word| raw.contains(word))
    {
        warnings += "Warning: the command uses files in a temp folder. Cloud agents can change those without asking, and they are not shown.\n\n";
    }
    let (folder, cut) = visible(
        job["cwd"]
            .as_str()
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or("~"),
        200,
        1,
    );
    let mut text = format!(
        "Command:\n{}\n\nFolder: {folder}{}",
        block(&command),
        if cut > 0 { "…" } else { "" }
    );
    if let Some(stdin) = job["stdin"].as_str().filter(|stdin| !stdin.is_empty()) {
        let data = unhex(stdin)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .map(|data| data.trim_end().to_owned())
            .filter(|data| !data.contains('\0'));
        match data {
            Some(data) => {
                let (script, hidden) = visible(&data, 1000, 20);
                let count = data.matches('\n').count() + 1;
                let plural = if count != 1 { "s" } else { "" };
                let all = if hidden == 0 { ", all shown" } else { "" };
                text += &format!(
                    "\n\nInput ({} line{plural}{all}):\n{}",
                    thousands(count),
                    block(&script)
                );
                if hidden > 0 {
                    warnings += &format!(
                        "Warning: {} more characters of its input are not shown, and will also run.\n\n",
                        thousands(hidden)
                    );
                }
            }
            None => {
                warnings += &format!(
                    "Warning: the command also reads {} bytes of input that cannot be shown, such as an archive. What it changes can depend on that input.\n\n",
                    thousands(stdin.len() / 2)
                );
            }
        }
    }
    format!("A cloud agent wants to change your Mac.\n\n{warnings}{text}")
}

/// The command for a `room-cli mac push` (#222), built here from the job's names, never from the sandbox's command.
/// Returns it with where the item lands, whether that is inside a folder, and whether it is in a temp folder. See
/// client.py's copy_command for why each step is there; the shell text is the same.
pub(super) fn copy_command(
    copy: &Value,
    home: &Path,
    temp_folders: &[&str],
) -> std::result::Result<(String, String, bool, bool), ()> {
    let (Some(name), Some(to)) = (copy["name"].as_str(), copy["to"].as_str()) else {
        return Err(());
    };
    let to_length = to.chars().count();
    if !(0 < to_length
        && to_length <= 4096
        && !["", ".", ".."].contains(&name)
        && !name.contains('/')
        && !name.contains('\0')
        && !to.contains('\0')
        && name.len() <= 255)
    {
        return Err(());
    }
    let staged = match &copy["staged"] {
        Value::Null => None,
        Value::String(staged) => {
            let rest = staged.strip_prefix("/tmp/cloudroom.").ok_or(())?;
            if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_alphanumeric()) {
                return Err(());
            }
            Some(staged.as_str())
        }
        _ => return Err(()),
    };
    let home = home.to_string_lossy();
    let joined = if to == "~" || to.starts_with("~/") {
        format!("{home}{}", &to[1..])
    } else {
        to.to_owned()
    };
    let path = if joined.starts_with('/') {
        joined
    } else {
        format!("{home}/{joined}")
    };
    let inside = to.ends_with('/') || Path::new(&path).is_dir();
    let (folder, last) = if inside {
        (path.clone(), name.to_owned())
    } else {
        let split = path.rfind('/').unwrap_or(0);
        let head = path[..=split].trim_end_matches('/');
        (
            if head.is_empty() {
                "/".to_owned()
            } else {
                head.to_owned()
            },
            path[split + 1..].to_owned(),
        )
    };
    let folder = realpath(Path::new(&folder)).to_string_lossy().into_owned();
    if ["", ".", ".."].contains(&last.as_str()) {
        return Err(());
    }
    let place = if folder == "/" {
        format!("/{last}")
    } else {
        format!("{folder}/{last}")
    };
    let temp = temp_folders
        .iter()
        .any(|root| folder == *root || folder.starts_with(&format!("{root}/")));
    let taken = r#"{ [ ! -e "$to" ] && [ ! -L "$to" ] || taken; }"#;
    let mut command = format!(
        "b={}; n={}; to={}; s={}; ",
        quote(&folder),
        quote(name),
        quote(&place),
        staged.unwrap_or("")
    );
    command +=
        r#"taken() { printf '%s already exists; nothing was copied\n' "$to" >&2; return 1; }; "#;
    if !inside {
        command += &format!("{taken} || exit 1; ");
    }
    command += r#"mkdir -p -- "$b" && x=$(mktemp -d "$b/.cloudroom.XXXXXX") && mkdir -- "$x/i" || exit 1; "#;
    command +=
        r#"clean() { find "$x" -type d -exec chmod u+rwx {} + 2>/dev/null; rm -rf "$x" $s; }; "#;
    command += "trap 'clean; exit 1' HUP INT TERM; ";
    if let Some(staged) = staged {
        command += &format!("cat {staged}/* | ");
    }
    command += &format!(r#"{COPY_TAR} -xzf - -C "$x/i"; c=$?; "#);
    // Exactly one item, named $n. Entries are counted by NUL, since a name may hold a line break.
    command += r#"if [ $c = 0 ] && ! { { [ -e "$x/i/$n" ] || [ -L "$x/i/$n" ]; } && "#;
    command += r#"[ $(( $(find "$x/i" -mindepth 1 -maxdepth 1 -print0 | tr -dc '\000' | wc -c) )) = 1 ]; }; "#;
    command += r#"then echo "The copy held other files, so nothing was copied" >&2; c=1; fi; "#;
    command += "if [ $c = 0 ]; then ";
    // Into a folder: a new item moves in. Otherwise it is packed whole first, so a failure changes nothing there.
    if inside {
        command += r#"{ [ ! -e "$to" ] && [ ! -L "$to" ] && mv -- "$x/i/$n" "$to" 2>/dev/null; } || { (cd -- "$x/i" && "#;
        command += &format!(
            r#"COPYFILE_DISABLE=1 {COPY_TAR} --no-xattrs -cf ../p.tar -- "$n") && {COPY_TAR} -xf "$x/p.tar" -C "$b"; }}; "#
        );
    } else {
        command += &format!(r#"{taken} && mv -- "$x/i/$n" "$to"; "#);
    }
    command += r#"c=$?; fi; clean; [ $c != 0 ] || printf '%s\n' "$to"; exit $c"#;
    Ok((command, place, inside, temp))
}

/// A push runs only the command built here, from the home folder, and always counts as a change. One into a temp
/// folder also runs read-only, since agents can swap paths there. Why it can't run, or None.
pub(super) fn as_copy(job: &mut Value, home: &Path, temp_folders: &[&str]) -> Option<String> {
    let copy = job.get("copy").filter(|copy| !copy.is_null())?.clone();
    let Ok((command, place, inside, temp)) = copy_command(&copy, home, temp_folders) else {
        return Some(BAD_COPY.into());
    };
    job["command"] = json!(command);
    job["cwd"] = Value::Null;
    job["write"] = json!(true);
    job["sandbox"] = json!(temp);
    job["place"] = json!([place, inside]);
    None
}

/// Cloudroom's folders with keys: its data folders (this app's and any other copy's, like a dev build's), and each
/// machine install here for another Mac (~/.bb-machines), which holds that Mac's relay key. An install can be a link.
/// Older installs could use another folder; their LaunchAgent names it.
fn hidden_folders(data: &Path, home: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut machines = vec![home.join(".bb-machines")];
    if let Ok(entries) = std::fs::read_dir(&machines[0]) {
        machines.extend(entries.flatten().map(|entry| entry.path()));
    }
    if let Ok(entries) = std::fs::read_dir(home.join("Library/LaunchAgents")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("app.getbb.host-daemon.") && name.ends_with(".plist")) {
                continue;
            }
            // A broken plist must not stop Read-only commands.
            let found = std::process::Command::new("/usr/bin/plutil")
                .args([
                    "-extract",
                    "EnvironmentVariables.BB_DATA_DIR",
                    "raw",
                    "-o",
                    "-",
                ])
                .arg(entry.path())
                .output();
            if let Ok(found) = found
                && found.status.success()
            {
                let folder =
                    PathBuf::from(String::from_utf8_lossy(&found.stdout).trim_end_matches('\n'));
                if folder.is_absolute() {
                    machines.push(folder);
                }
            }
        }
    }
    let real = |paths: Vec<PathBuf>| {
        let mut seen = Vec::new();
        for path in paths.iter().map(|path| realpath(path)) {
            if !seen.contains(&path) {
                seen.push(path);
            }
        }
        seen
    };
    (
        real(vec![
            data.to_owned(),
            home.join(".gui-cloudroom"),
            home.join(".gui-cloudroom-dev"),
        ]),
        real(machines),
    )
}

/// sandbox-exec arguments for a read-only command; `data` is Cloudroom's folder, which holds its tokens. The sandbox
/// denies the `marks`, names no Mach service has, so `end` can find all the command started.
pub(super) fn read_only(data: &Path, home: &Path, marks: &[&str]) -> Vec<String> {
    let data = realpath(data); // Seatbelt matches real paths.
    let (folders, machines) = hidden_folders(&data, home);
    let mut params = vec![
        ("DATA".to_owned(), data.clone()),
        ("DATA_BIN".into(), data.join("bin")),
        ("DATA_HARNESS".into(), data.join("browser-harness")),
    ];
    params.extend(
        folders
            .iter()
            .enumerate()
            .map(|(n, path)| (format!("FOLDER_{n}"), path.clone())),
    );
    params.extend(
        machines
            .iter()
            .enumerate()
            .map(|(n, path)| (format!("MACHINE_{n}"), path.clone())),
    );
    let subpaths = |name: &str, count: usize| {
        (0..count)
            .map(|n| format!(" (subpath (param \"{name}_{n}\"))"))
            .collect::<String>()
    };
    // Labels and hex only, so nothing to escape.
    let names: String = marks
        .iter()
        .map(|mark| format!(" (global-name \"{mark}\")"))
        .collect();
    let names = if names.is_empty() {
        names
    } else {
        format!("(deny mach-lookup{names})")
    };
    // Machine installs come last, after the tools and temp-folder exceptions, so neither can reopen them.
    let profile = format!(
        "{READ_ONLY}{names}(deny file-read*{}){READ_ONLY_TOOLS}(deny file-read* file-write*{} {READ_ONLY_OLD_KEYS})",
        subpaths("FOLDER", folders.len()),
        subpaths("MACHINE", machines.len())
    );
    let mut args = vec!["/usr/bin/sandbox-exec".to_owned()];
    for (key, path) in params {
        args.extend(["-D".into(), format!("{key}={}", path.display())]);
    }
    args.extend(["-p".into(), profile]);
    args
}

#[repr(C)]
struct Passwd {
    name: *mut c_char,
    password: *mut c_char,
    uid: u32,
    gid: u32,
    #[cfg(target_os = "macos")]
    change: i64,
    #[cfg(target_os = "macos")]
    class: *mut c_char,
    gecos: *mut c_char,
    dir: *mut c_char,
    shell: *mut c_char,
    #[cfg(target_os = "macos")]
    expire: i64,
}

/// This user's login shell, as `pwd.getpwuid(os.getuid()).pw_shell`.
fn login_shell() -> Option<String> {
    unsafe extern "C" {
        fn getpwuid_r(
            uid: u32,
            entry: *mut Passwd,
            buffer: *mut c_char,
            length: usize,
            result: *mut *mut Passwd,
        ) -> i32;
    }
    let mut entry: Passwd = unsafe { std::mem::zeroed() };
    let mut buffer = vec![0 as c_char; 16384];
    let mut result = std::ptr::null_mut();
    let code = unsafe {
        getpwuid_r(
            super::uid(),
            &mut entry,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut result,
        )
    };
    if code != 0 || result.is_null() || entry.shell.is_null() {
        return None;
    }
    let shell = unsafe { CStr::from_ptr(entry.shell) }
        .to_string_lossy()
        .into_owned();
    (!shell.is_empty()).then_some(shell)
}

unsafe extern "C" {
    fn setsid() -> i32;
    fn killpg(group: i32, signal: i32) -> i32;
    fn kill(pid: i32, signal: i32) -> i32;
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn proc_listallpids(buffer: *mut i32, size: i32) -> i32;
    fn sandbox_check(pid: i32, operation: *const c_char, kind: i32, ...) -> i32;
    fn dlsym(handle: *mut std::ffi::c_void, symbol: *const c_char) -> *mut std::ffi::c_void;
}

/// libSystem's process list and sandbox check, as client.py's `sandbox_checks`. No process carries a mark off macOS,
/// where read-only commands never run.
struct Checks {
    #[cfg(target_os = "macos")]
    kind: i32,
}

impl Checks {
    /// An error when this Mac can't tell.
    #[cfg(target_os = "macos")]
    fn new() -> std::io::Result<Checks> {
        // SANDBOX_FILTER_GLOBAL_NAME, and SANDBOX_CHECK_NO_REPORT (looked up, as it is not public) so checks aren't
        // logged.
        let report = unsafe { dlsym(-2isize as *mut _, c"SANDBOX_CHECK_NO_REPORT".as_ptr()) };
        if report.is_null() {
            return Err(std::io::Error::other("This Mac cannot check sandboxes"));
        }
        Ok(Checks {
            kind: 2 | unsafe { *report.cast::<i32>() },
        })
    }

    #[cfg(not(target_os = "macos"))]
    fn new() -> std::io::Result<Checks> {
        Ok(Checks {})
    }

    /// Every PID.
    #[cfg(target_os = "macos")]
    fn list(&self) -> std::io::Result<Vec<i32>> {
        let mut size = usize::try_from(unsafe { proc_listallpids(std::ptr::null_mut(), 0) })
            .unwrap_or(0)
            + 256;
        loop {
            let mut pids = vec![0i32; size];
            let bytes = i32::try_from(size * 4).map_err(std::io::Error::other)?;
            let found = unsafe { proc_listallpids(pids.as_mut_ptr(), bytes) };
            // 0 is an error too: the list always holds launchd and this helper.
            let found = usize::try_from(found)
                .ok()
                .filter(|found| *found > 0)
                .ok_or_else(|| std::io::Error::other("This Mac cannot list its processes"))?;
            if found < size {
                pids.truncate(found);
                pids.retain(|pid| *pid > 0);
                return Ok(pids);
            }
            size *= 2; // A full list may have left some out.
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn list(&self) -> std::io::Result<Vec<i32>> {
        Ok(Vec::new())
    }

    /// Whether this process's sandbox denies names[0] (a mark, `read_only`) but allows names[1].
    #[cfg(target_os = "macos")]
    fn covered(&self, pid: i32, names: &[std::ffi::CString; 2]) -> bool {
        let denied = |name: &std::ffi::CString| unsafe {
            sandbox_check(pid, c"mach-lookup".as_ptr(), self.kind, name.as_ptr())
        };
        denied(&names[0]) == 1 && denied(&names[1]) == 0
    }

    #[cfg(not(target_os = "macos"))]
    fn covered(&self, _: i32, _: &[std::ffi::CString; 2]) -> bool {
        false
    }
}

/// The names for `Checks::covered`: the mark, and one its processes' sandbox allows, by default a random one beside it.
/// Many other sandboxes deny every name, and so do processes that have ended, so those never count.
fn marks(mark: &str, allowed: Option<&str>) -> std::io::Result<[std::ffi::CString; 2]> {
    let allowed = match allowed {
        Some(allowed) => allowed.to_owned(),
        None => format!("{mark}.{}", &super::uuid4()?[..16]),
    };
    Ok([
        std::ffi::CString::new(mark)?,
        std::ffi::CString::new(allowed)?,
    ])
}

/// This user's live processes in a read-only sandbox with this mark (`read_only`). They can leave their process group,
/// session, or parent, never their sandbox. An error when this Mac can't tell. As client.py's `marked`.
fn marked(mark: &str, allowed: Option<&str>) -> std::io::Result<Vec<i32>> {
    let (checks, names) = (Checks::new()?, marks(mark, allowed)?);
    let mut pids = checks.list()?;
    pids.retain(|pid| checks.covered(*pid, &names));
    Ok(pids)
}

/// Ends every process `marked` would find, each as soon as it is found. One may start another and end before its own
/// check, so the list is taken again until 20 lists in a row show none alive; after the first, only processes new to
/// the list, and those killed but not gone yet, need a check. SIGKILL, since it only read and a handler could start
/// more. A PID is killed right after its check, and macOS hands out new PIDs in order, so it is still that process's.
/// True once none is left; false if some still run after 5 s, or if this Mac can't tell. Blocks, as client.py's `end`.
pub(super) fn end(mark: &str, allowed: Option<&str>) -> bool {
    let (Ok(checks), Ok(names)) = (Checks::new(), marks(mark, allowed)) else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let (mut previous, mut alive, mut clean) = (HashSet::new(), HashSet::new(), 0);
    while clean < 20 {
        let Ok(pids) = checks.list() else {
            return false;
        };
        let mut found = HashSet::new();
        let fresh = pids.iter().filter(|pid| !previous.contains(*pid));
        for &pid in alive.iter().chain(fresh) {
            if checks.covered(pid, &names) {
                unsafe { kill(pid, SIGKILL) };
                found.insert(pid);
            }
        }
        clean = if found.is_empty() { clean + 1 } else { 0 };
        if !found.is_empty() && Instant::now() > deadline {
            return false;
        }
        (previous, alive) = (pids.into_iter().collect(), found);
    }
    true
}

/// A new session for each command and popup, so a stop ends everything it started.
fn command(program: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    // Mac commands' curl and git verify with the macOS trust store, which blocks leaked CA keys such as eMudhra's.
    if cfg!(target_os = "macos") && std::env::var_os("CURL_SSL_BACKEND").is_none() {
        command.env("CURL_SSL_BACKEND", "secure-transport");
    }
    unsafe {
        command.pre_exec(|| {
            setsid();
            Ok(())
        });
    }
    command
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[derive(Default)]
struct Processes {
    running: HashMap<String, u32>,
    /// How many jobs taken from the streams are not finished, by ID (two sandboxes' Cores can use the same one), and
    /// which of those IDs the agent stopped before they started; execute skips those. A stop for any other job is
    /// dropped, so a sandbox's Core can't fill this.
    taken: HashMap<String, usize>,
    cancelled: HashSet<String>,
    /// Each mark to end (`read_only`); `end_unwanted` ends each until nothing carries it, starting with what earlier runs
    /// left.
    sandboxes: HashMap<String, Sandbox>,
    /// The helper is stopping: no command starts any more.
    stopping: bool,
}

/// A mark to end: the core whose stream keeps it (None: none), the name its processes must allow (`marked`), and its
/// running shell.
#[derive(Clone, Default)]
struct Sandbox {
    core: Option<Key>,
    allowed: Option<String>,
    shell: Option<u32>,
}

pub(super) struct Jobs {
    shared: Arc<Shared>,
    folder: PathBuf,
    /// Read-only commands carry this helper's mark (from its folder, as its LaunchAgent label: a dev build's helper has
    /// another), this run's (`boot`), and their own (`read_only`).
    mark: String,
    boot: String,
    /// `end` was seen to work on this Mac (`containable`).
    contained: AtomicBool,
    processes: Mutex<Processes>,
    /// Ask first: one popup at a time.
    asking: tokio::sync::Mutex<()>,
    /// "Allow for this sandbox" trusts every agent on that sandbox's core (jobs carry no thread), until the helper
    /// restarts or the access level changes; with the level it was given at.
    trust: Mutex<(HashSet<Key>, Option<&'static str>)>,
    /// Whether each sandbox core has a key list, asked once per wake, one question at a time.
    lists: Mutex<HashMap<Key, bool>>,
    checking: tokio::sync::Mutex<()>,
    pub(super) wanted: Mutex<HashSet<Key>>,
    /// Each Mac command also goes to the website's Jev check (ADR 0224). It never delays the job: at most four reports
    /// in flight, a repeated command is skipped for an hour, and failures are dropped. Commands are kept as fixed-size
    /// hashes, at most 4,096 of them, so a sandbox's many long commands can't fill memory.
    reviews: Mutex<HashMap<String, Instant>>,
    slots: AtomicUsize,
}

pub(super) async fn serve(jobs: Arc<Jobs>) {
    let mut streams: HashMap<Key, tokio::task::JoinHandle<()>> = HashMap::new();
    // One job stream per reachable core: the VM's, and each awake sandbox's while it stays awake.
    loop {
        let config = jobs.enabled();
        jobs.track(level(config.as_ref().unwrap_or(&Value::Null)));
        let listed = match &config {
            Some(config) => net::cores(&jobs.shared, config).await.ok(),
            None => Some(Vec::new()),
        };
        if let Some(listed) = listed {
            *jobs.wanted.lock().unwrap() = listed.iter().map(|core| core.key.clone()).collect();
            let device = config
                .as_ref()
                .and_then(|config| text(config, "device"))
                .unwrap_or_default()
                .to_owned();
            for core in listed {
                if streams
                    .get(&core.key)
                    .is_none_or(|stream| stream.is_finished())
                {
                    streams.insert(
                        core.key.clone(),
                        tokio::spawn(jobs.clone().follow(core, device.clone())),
                    );
                }
            }
        }
        streams.retain(|_, stream| !stream.is_finished());
        jobs.end_unwanted().await; // Also when the list failed: it ends only what no listed stream keeps.
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

impl Jobs {
    pub(super) fn new(shared: Arc<Shared>) -> Jobs {
        let mark = format!("{}.read-only", super::label(&shared.folder));
        // Marks stay short, well below Mach's 128-byte names.
        let boot = format!("{mark}.{}", shared.boot.get(..16).unwrap_or(&shared.boot));
        let earlier = Sandbox {
            allowed: Some(boot.clone()),
            ..Sandbox::default()
        };
        let processes = Processes {
            sandboxes: HashMap::from([(mark.clone(), earlier)]),
            ..Processes::default()
        };
        Jobs {
            folder: shared.folder.clone(),
            mark,
            boot,
            contained: AtomicBool::new(false),
            shared,
            processes: Mutex::new(processes),
            asking: tokio::sync::Mutex::new(()),
            trust: Mutex::default(),
            lists: Mutex::default(),
            checking: tokio::sync::Mutex::new(()),
            wanted: Mutex::default(),
            reviews: Mutex::default(),
            slots: AtomicUsize::new(0),
        }
    }

    /// The setup while Mac access is on, else None. Off or a lower level the app saved counts from the next job, before
    /// setup applies it (#109); raising waits for setup. Anything unreadable counts as off.
    fn enabled(&self) -> Option<Value> {
        let mut config = private_json(&self.folder.join("config.json")).ok()?;
        // An old job stream may outlive a failed stop during an account switch (#109).
        if let Some(file) = text(&config, "connectionFile") {
            let connection = private_json(Path::new(file)).ok()?;
            if connection["account"]["id"] != config["binding"][1] {
                return None;
            }
        }
        if let Some(saved) = saved_level(&config)
            && rank(saved) < rank(level(&config))
        {
            config["macAccess"] = json!(saved);
        }
        (level(&config) != "off" && !truthy(&config["revoked"])).then_some(config)
    }

    /// Any access level change, even Off and back, ends "Allow for this sandbox".
    fn track(&self, level: &'static str) {
        let mut trust = self.trust.lock().unwrap();
        if trust.1 != Some(level) {
            *trust = (HashSet::new(), Some(level));
        }
    }

    /// Ends each read-only command whose core's stream ended (Mac access Off, sign-out, or a sandbox no longer awake),
    /// and what earlier runs or a failed `end` left, until nothing carries its mark.
    pub(super) async fn end_unwanted(&self) {
        let wanted = self.wanted.lock().unwrap().clone();
        let unwanted: Vec<(String, Sandbox)> = (self.processes.lock().unwrap().sandboxes.iter())
            .filter(|(_, sandbox)| (sandbox.core.as_ref()).is_none_or(|key| !wanted.contains(key)))
            .map(|(mark, sandbox)| (mark.clone(), sandbox.clone()))
            .collect();
        if unwanted.is_empty() {
            return;
        }
        let unwanted_count = unwanted.len();
        let ended = tokio::task::spawn_blocking(move || {
            (unwanted.into_iter())
                .filter(|(mark, sandbox)| {
                    if let Some(shell) = sandbox.shell {
                        // Its sandbox may not be set up yet. `run` drops the PID once it reaps the shell, and macOS
                        // hands out new PIDs in order, so it is still this shell's.
                        unsafe { kill(shell as i32, SIGKILL) };
                    }
                    end(mark, sandbox.allowed.as_deref())
                })
                .map(|(mark, _)| mark)
                .collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        let mut processes = self.processes.lock().unwrap();
        for mark in &ended {
            processes.sandboxes.remove(mark);
        }
        if ended.len() < unwanted_count {
            // The next read-only command checks again first (`containable`).
            self.contained.store(false, Ordering::SeqCst);
        }
    }

    /// Whether `end` works on this Mac and spares other sandboxes, tried on two `sleep`s: `marked` must find one whose
    /// sandbox denies a test mark, and not one whose sandbox denies every name but one, as apps' sandboxes do. Checked
    /// once per run, and again after a failure. Without it, read-only commands don't run. As client.py's `containable`.
    async fn containable(&self) -> bool {
        if self.contained.load(Ordering::SeqCst) {
            return true;
        }
        let mark = format!("{}.check", self.boot);
        let contained = tokio::task::spawn_blocking(move || {
            let open = format!("{mark}.open");
            let rules = [
                format!("(deny mach-lookup (global-name \"{mark}\"))"),
                format!("(deny mach-lookup)(allow mach-lookup (global-name \"{open}\"))"),
            ];
            let mut tests = Vec::new();
            for rule in rules {
                let test = std::process::Command::new("/usr/bin/sandbox-exec")
                    .args([
                        "-p",
                        &format!("(version 1)(allow default){rule}"),
                        "/bin/sleep",
                        "10",
                    ])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
                if let Ok(test) = test {
                    tests.push(test);
                }
            }
            let mut contained = false;
            if let [ours, apps] = &tests[..] {
                let (ours, apps) = (ours.id() as i32, apps.id() as i32);
                let has = |pid, allowed| marked(&mark, allowed).map(|pids| pids.contains(&pid));
                for _ in 0..200 {
                    // Until both sandboxes are set up.
                    match (has(ours, None), has(apps, Some(&open))) {
                        (Ok(true), Ok(true)) => {
                            contained = has(apps, None).is_ok_and(|found| !found);
                            break;
                        }
                        (Ok(_), Ok(_)) => std::thread::sleep(Duration::from_millis(10)),
                        _ => break,
                    }
                }
            }
            for test in &mut tests {
                let _ = test.kill();
                let _ = test.wait();
            }
            contained
        })
        .await
        .unwrap_or(false);
        if contained {
            self.contained.store(true, Ordering::SeqCst);
        }
        contained
    }

    /// The helper is stopping: no command starts any more, and none of its read-only commands outlives it.
    pub(super) async fn close(&self) {
        let shells: Vec<u32> = {
            let mut processes = self.processes.lock().unwrap();
            processes.stopping = true;
            processes
                .sandboxes
                .values()
                .filter_map(|sandbox| sandbox.shell)
                .collect()
        };
        let mark = self.mark.clone();
        let _ = tokio::task::spawn_blocking(move || {
            for shell in shells {
                unsafe { kill(shell as i32, SIGKILL) }; // As in `end_unwanted`.
            }
            end(&mark, None)
        })
        .await;
    }

    async fn follow(self: Arc<Self>, core: Core, device: String) {
        let mut delay = 2;
        while self.wanted.lock().unwrap().contains(&core.key) {
            let mut opened = false;
            let result = self.stream(&core, &device, &mut opened).await;
            if opened {
                delay = 2;
            }
            if let Err(error) = result {
                delay = (delay * 2).min(30);
                // A new sandbox refuses this Mac until it pairs; pair here instead of backing off until the preview loop does.
                if matches!(error, Error::Http(403))
                    && let Ok(key) = net::identity(&self.folder)
                    && core
                        .request(
                            &self.shared,
                            "/device",
                            Some(&json!({"device": device, "public_key": key})),
                            None,
                        )
                        .await
                        .is_ok()
                {
                    delay = 1;
                }
            }
            tokio::select! { // Check now wakes this wait.
                _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
                _ = self.shared.nudge.notified() => {}
            }
        }
    }

    pub(super) async fn stream(
        self: &Arc<Self>,
        core: &Core,
        device: &str,
        opened: &mut bool,
    ) -> Result<()> {
        let url = format!(
            "{}/v1/mac/jobs?device={device}&boot={}&fetch=true",
            core.url, self.shared.boot
        );
        let mut request = self
            .shared
            .client()
            .get(url)
            .header("Accept", "text/event-stream");
        for (name, value) in &core.headers {
            request = request.header(name, value);
        }
        let timeout = || Error::Net {
            unsent: net::Unsent::No,
            text: "timed out".into(),
        };
        let mut response = tokio::time::timeout(Duration::from_secs(60), request.send())
            .await
            .map_err(|_| timeout())?
            .map_err(net::network_error)?;
        if !response.status().is_success() {
            return Err(Error::Http(response.status().as_u16()));
        }
        *opened = true;
        let (mut buffer, mut event) = (Vec::new(), None);
        while let Some(chunk) = tokio::time::timeout(Duration::from_secs(60), response.chunk())
            .await
            .map_err(|_| timeout())?
            .map_err(net::network_error)?
        {
            // What was kept holds no line break, so only the new bytes are searched.
            let mut from = buffer.len();
            buffer.extend_from_slice(&chunk);
            while let Some(end) = buffer[from..].iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = buffer.drain(..=from + end).collect();
                from = 0;
                if line.len() > LINE {
                    return Err(Error::value("Mac job is too large"));
                }
                let line = String::from_utf8_lossy(&line);
                let line = line.trim_end_matches(['\r', '\n']);
                if let Some(name) = line.strip_prefix("event:") {
                    event = Some(name.trim().to_owned());
                } else if let Some(data) = line.strip_prefix("data:") {
                    let data: Value = serde_json::from_str(data)
                        .map_err(|error| Error::value(error.to_string()))?;
                    match event.as_deref() {
                        Some("job") => self.take(core, device, data),
                        Some("cancel") => self.cancel(data["id"].as_str().unwrap_or_default()),
                        _ => {}
                    }
                } else if line.starts_with(':')
                    && (self.enabled().is_none()
                        || !self.wanted.lock().unwrap().contains(&core.key))
                {
                    return Ok(());
                }
            }
            if buffer.len() > LINE {
                return Err(Error::value("Mac job is too large"));
            }
        }
        Ok(())
    }

    /// Starts a job from the stream. Until it ends, a stop for it is kept (see cancel).
    fn take(self: &Arc<Self>, core: &Core, device: &str, job: Value) {
        let id = job["id"].as_str().unwrap_or_default().to_owned();
        *self
            .processes
            .lock()
            .unwrap()
            .taken
            .entry(id.clone())
            .or_default() += 1;
        let (jobs, core, device) = (self.clone(), core.clone(), device.to_owned());
        tokio::spawn(async move {
            jobs.clone().execute(core, device, job).await;
            let mut processes = jobs.processes.lock().unwrap();
            if let Some(count) = processes.taken.get_mut(&id) {
                *count -= 1;
                if *count == 0 {
                    processes.taken.remove(&id);
                    processes.cancelled.remove(&id);
                }
            }
        });
    }

    /// A job's input, downloaded after confirming it, so a big push never holds up other jobs on the stream (#576).
    /// Older cores send it inside the job instead. None if it can't be downloaded or is over Core's 16 MiB limit.
    async fn stdin(&self, core: &Core, device: &str, job: &Value) -> Option<String> {
        let size = match &job["stdin_bytes"] {
            Value::Null => 0,
            size => size.as_u64().filter(|size| *size <= LIMIT as u64)? as usize,
        };
        if size == 0 {
            let stdin = job["stdin"].as_str().unwrap_or_default();
            return (stdin.len() <= 2 * LIMIT).then(|| stdin.to_owned());
        }
        let url = format!(
            "{}/v1/mac/jobs/{}/stdin?device={}",
            core.url,
            quote_url(job["id"].as_str().unwrap_or_default()),
            quote_url(device)
        );
        for _ in 0..3 {
            let mut request = self.shared.client().get(&url).timeout(POST);
            for (name, value) in &core.headers {
                request = request.header(name, value);
            }
            match request.send().await {
                Ok(response) if !response.status().is_success() => return None, // Core already gave up on this job.
                Ok(mut response) => {
                    let mut data = Vec::new();
                    while let Ok(Some(chunk)) = response.chunk().await {
                        // At most one byte past the size, as client.py reads.
                        data.extend_from_slice(&chunk[..chunk.len().min(size + 1 - data.len())]);
                        if data.len() > size {
                            break;
                        }
                    }
                    if data.len() == size {
                        return Some(hex(&data));
                    }
                }
                Err(_) => {}
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        None
    }

    /// Why this sandbox may not use the Mac at all, or None. A sandbox with a key list (a Cloud loop's run, its children
    /// and forks, ADR 0342) gets only the keys picked for it, and the Mac holds every file. The website's row decides,
    /// never the sandbox, whose agent has root: only a row it found without a list allows. Each wake brings a new token,
    /// so the answer is kept per core. A failed check refuses and asks again at the next job.
    async fn limited(&self, core: &Core) -> Option<String> {
        if !core.sandbox {
            return None;
        }
        let _one = self.checking.lock().await;
        let known = self.lists.lock().unwrap().get(&core.key).copied();
        let limited = match known {
            Some(limited) => limited,
            None => {
                let answer: Result<Value> = async {
                    let token = text(&core.connection, "sandboxToken")
                        .ok_or_else(|| Error::value("No sign-in to check"))?;
                    let thread = core
                        .thread
                        .as_deref()
                        .ok_or_else(|| Error::value("No thread to check"))?;
                    let headers = net::basic(&core.connection, token)
                        .ok_or_else(|| Error::value("Invalid account"))?;
                    let url = format!("{}/api/desktop/sandboxes", core.website()?);
                    let answer = self
                        .shared
                        .control(
                            &url,
                            Some(&json!({"action": "secrets", "thread": thread})),
                            Some("POST"),
                            &headers,
                            Duration::from_secs(5),
                        )
                        .await?;
                    let secrets = answer
                        .get("secrets")
                        .ok_or_else(|| Error::value("Unconfirmed key list"))?;
                    if answer["found"] != json!(true) || !(secrets.is_null() || secrets.is_array())
                    {
                        return Err(Error::value("Unconfirmed key list"));
                    }
                    Ok(answer)
                }
                .await;
                let Ok(answer) = answer else {
                    return Some(UNCONFIRMED_KEYS.into());
                };
                let limited = !answer["secrets"].is_null();
                self.lists.lock().unwrap().insert(core.key.clone(), limited);
                limited
            }
        };
        limited.then(|| LIMITED.into())
    }

    /// The access level, and why this sandbox may not use the Mac at all now (Off or a key list), or None.
    async fn closed(&self, core: &Core) -> (&'static str, Option<String>) {
        let current = level(&self.enabled().unwrap_or(Value::Null));
        self.track(current);
        if current == "off" {
            return (current, Some(OFF.into()));
        }
        (current, self.limited(core).await)
    }

    /// Why this job may not run as asked, or None. Everything else that is not full access runs read-only.
    pub(super) async fn refusal(&self, core: &Core, job: &mut Value) -> Option<String> {
        let (current, closed) = self.closed(core).await;
        if closed.is_some() {
            return closed;
        }
        // After Off and the key list, so a sandbox without Mac access can't learn which Mac folders exist from a push.
        if let Some(unusable) = as_copy(job, &home(), &TEMP_FOLDERS) {
            return Some(unusable);
        }
        let write = truthy(&job["write"]);
        if current == "full"
            || !write && cfg!(target_os = "macos") && ["read-only", "ask"].contains(&current)
        {
            return None;
        }
        if !cfg!(target_os = "macos") {
            return Some("Read-only and Ask first Mac access need macOS. The user can switch Mac access to Full in the Cloudroom sidebar.".into());
        }
        if current == "read-only" {
            return Some("Mac access is Read-only, so this command cannot change the Mac. The user can switch it to Ask first or Full in the Cloudroom sidebar.".into());
        }
        if current == "ask" && self.approve(core, job).await {
            // The user may have lowered Mac access while the popup was open.
            let now = level(&self.enabled().unwrap_or(Value::Null));
            return if ["ask", "full"].contains(&now) {
                None
            } else {
                Some("Mac access was lowered, so this command did not run.".into())
            };
        }
        Some("The user did not approve this command on their Mac. Do not retry it unless they ask you to.".into())
    }

    async fn approve(&self, core: &Core, job: &Value) -> bool {
        let _one = self.asking.lock().await;
        if self.trust.lock().unwrap().0.contains(&core.key) {
            return true;
        }
        let text = popup_text(job, &realpath(&home()));
        let id = job["id"].as_str().unwrap_or_default().to_owned();
        let popup = {
            let mut processes = self.processes.lock().unwrap();
            let spawned = command("/usr/bin/osascript")
                .args(["-e", ASK, &text])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn();
            let Ok(popup) = spawned else { return false };
            if let Some(pid) = popup.id() {
                processes.running.insert(id.clone(), pid);
            }
            popup
        };
        let answer = popup
            .wait_with_output()
            .await
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .unwrap_or_default();
        self.processes.lock().unwrap().running.remove(&id);
        if answer == "Allow for this sandbox" {
            self.trust.lock().unwrap().0.insert(core.key.clone());
        }
        answer == "Allow" || answer == "Allow for this sandbox"
    }

    fn review(self: &Arc<Self>, core: &Core, job: &Value, level: &'static str, script: bool) {
        let (Some(account), Some(token)) = (
            core.connection["account"]["id"]
                .as_str()
                .filter(|id| !id.is_empty()),
            text(&core.connection, "sandboxToken"),
        ) else {
            return;
        };
        let command = job["command"].as_str().unwrap_or_default().to_owned();
        let key = super::sha256(format!("{}\0{command}", core.url).as_bytes());
        {
            let mut sent = self.reviews.lock().unwrap();
            sent.retain(|_, at| at.elapsed() <= Duration::from_secs(3600));
            if sent.len() >= 4096 {
                sent.clear();
            }
            if sent.contains_key(&key) || self.slots.fetch_add(1, Ordering::SeqCst) >= 4 {
                if !sent.contains_key(&key) {
                    self.slots.fetch_sub(1, Ordering::SeqCst);
                }
                return;
            }
            sent.insert(key, Instant::now());
        }
        let mut body = json!({"command": command.chars().take(8000).collect::<String>(), "cwd": job["cwd"], "write": truthy(&job["write"]), "level": level, "thread": core.thread});
        let job = job.clone();
        let headers = vec![(
            "Authorization".to_owned(),
            format!("Basic {}", base64(format!("{account}:{token}").as_bytes())),
        )];
        let (jobs, website) = (self.clone(), core.website());
        tokio::spawn(async move {
            if script {
                // Never on the command's path or the async workers: an iCloud or network file can block for long.
                let read = tokio::task::spawn_blocking(move || script_of(&job));
                body["script"] = json!(
                    tokio::time::timeout(Duration::from_secs(5), read)
                        .await
                        .ok()
                        .and_then(|read| read.ok())
                        .flatten()
                );
            }
            if let Ok(website) = website {
                let _ = jobs
                    .shared
                    .control(
                        &format!("{website}/api/desktop/mac-reviews"),
                        Some(&body),
                        Some("POST"),
                        &headers,
                        Duration::from_secs(5),
                    )
                    .await;
            }
            jobs.slots.fetch_sub(1, Ordering::SeqCst);
        });
    }

    pub(super) async fn execute(self: Arc<Self>, core: Core, device: String, mut job: Value) {
        let id = job["id"].as_str().unwrap_or_default().to_owned();
        let url = format!("{}/v1/mac/results/{}", core.url, quote_url(&id));
        let post = |mut body: Value, timeout: Duration| {
            body["device"] = json!(device);
            let (shared, url, headers) = (self.shared.clone(), url.clone(), core.headers.clone());
            async move {
                shared
                    .control(&url, Some(&body), None, &headers, timeout)
                    .await
            }
        };
        // Run only once Core confirms it still wants the job. Core gives up on an unconfirmed job after about 10 s and
        // tells the agent it did not run, so running it anyway could change the Mac twice when the agent retries.
        let (mut confirmed, deadline) = (false, Instant::now() + Duration::from_secs(30));
        while !confirmed && Instant::now() < deadline {
            match post(json!({"state": "running"}), Duration::from_secs(10)).await {
                Ok(_) => confirmed = true,
                Err(Error::Http(401 | 403 | 404 | 409)) => return, // Core already told the agent it did not run.
                Err(_) => tokio::time::sleep(Duration::from_secs(1)).await,
            }
        }
        // Core may have taken a confirmation whose reply was lost, so it still gets this result instead of waiting forever.
        // Off and the key list come before the input, so a sandbox that may not use the Mac never makes it download any.
        let mut refused = if confirmed {
            self.closed(&core).await.1
        } else {
            Some("The Mac could not confirm this command with the cloud, so it did not run. Try again.".to_owned())
        };
        if refused.is_none() {
            refused = match self.stdin(&core, &device, &job).await {
                Some(stdin) => {
                    job["stdin"] = json!(stdin);
                    self.refusal(&core, &mut job).await
                }
                None => Some("The Mac could not download this command's input from the cloud, so it did not run. Try again.".to_owned()),
            };
        }
        // Refused commands are checked too, but a script file is read only for a command that will run.
        self.review(
            &core,
            &job,
            level(&self.enabled().unwrap_or(Value::Null)),
            refused.is_none(),
        );
        let full = level(&self.enabled().unwrap_or(Value::Null)) == "full";
        // A push into a temp folder runs read-only even once approved, since agents can swap paths there.
        let mut sandboxed =
            refused.is_none() && (!truthy(&job["write"]) || truthy(&job["sandbox"])) && !full;
        if sandboxed && !self.containable().await {
            refused = Some(UNCONTAINED.to_owned());
            sandboxed = false;
        }
        let data = Path::new(text(&core.config, "connectionFile").unwrap_or("/"))
            .parent()
            .unwrap_or(Path::new("/"))
            .to_owned();
        let result = match refused {
            Some(reason) => {
                json!({"state": "done", "code": 126, "stdout": "", "stderr": hex(reason.as_bytes()), "truncated": false})
            }
            None => {
                let sandbox = sandboxed.then_some(&core.key);
                self.run(
                    &job,
                    sandbox,
                    &data,
                    text(&core.config, "shellPath"),
                    text(&core.config, "serverUrl"),
                )
                .await
            }
        };
        // The result survives disconnects: retry until Core accepts it, forgets the job, or an hour passes.
        let deadline = Instant::now() + Duration::from_secs(3600);
        while Instant::now() < deadline {
            match deliver(&post, &result).await {
                Ok(()) | Err(Error::Http(403 | 404 | 409 | 413)) => return,
                Err(_) => tokio::time::sleep(Duration::from_secs(5)).await,
            }
        }
    }

    /// Runs one approved job as this user, through the login shell, and returns its result. With `sandbox`, the key of
    /// the core that sent it, it runs read-only, and everything it starts ends with it or with that core's stream.
    pub(super) async fn run(
        &self,
        job: &Value,
        sandbox: Option<&Key>,
        data: &Path,
        saved_path: Option<&str>,
        server: Option<&str>,
    ) -> Value {
        let id = job["id"].as_str().unwrap_or_default().to_owned();
        let sandboxed = sandbox.is_some();
        // Never the job's ID, which a sandbox can pick.
        let mark = match sandbox.map(|_| super::uuid4()).transpose() {
            Ok(token) => token.map(|token| format!("{}.{}", self.boot, &token[..16])),
            Err(error) => {
                return json!({"state": "done", "code": 127, "stdout": "", "stderr": hex(error.to_string().as_bytes()), "truncated": false});
            }
        };
        let login = login_shell().unwrap_or_else(|| "/bin/zsh".into());
        let fish = login.ends_with("/fish");
        // As in Local threads, Cloudroom's own tools come first, then the PATH the app read from an interactive login
        // shell, so tools set up in ~/.zshrc are found. On macOS that lookup always uses /bin/zsh, so other shells keep
        // their own PATH. The shell stays non-interactive: rc files could print into a `mac pull` archive (#338).
        let mut tools = quote(&data.join("bin").to_string_lossy());
        if let Some(saved) =
            saved_path.filter(|_| !cfg!(target_os = "macos") || login.ends_with("/zsh"))
        {
            tools += if fish { " " } else { ":" };
            tools += &quote(saved);
        }
        let mut path = if fish {
            format!("set -gx PATH {tools} $PATH; ")
        } else {
            format!("PATH={tools}:\"$PATH\"; ")
        };
        // A nested room-cli reaches the app that owns this helper, not a ROOM_SERVER_URL left in the helper's or the
        // login shell's environment, nor the default port of another app such as a Dev build (#1243, #1290).
        if let Some(server) = server {
            path += &if fish {
                format!("set -gx ROOM_SERVER_URL {}; ", quote(server))
            } else {
                format!("export ROOM_SERVER_URL={}; ", quote(server))
            };
        }
        let raw = job["command"].as_str().unwrap_or_default();
        // Agents and Core's copy scripts write sh, which fish can't parse (#204), so fish loads its login setup, then
        // hands the unchanged command to sh.
        let line = if fish {
            format!(
                "exec /bin/sh -c '{}'",
                raw.replace('\\', "\\\\").replace('\'', "\\'")
            )
        } else {
            raw.to_owned()
        };
        let mut argv = match &mark {
            Some(mark) => read_only(data, &home(), &[&self.mark, &self.boot, mark]),
            None => Vec::new(),
        };
        argv.extend([login, "-lc".into(), path + &line]);
        let folder = home().join(expanduser(
            job["cwd"]
                .as_str()
                .filter(|cwd| !cwd.is_empty())
                .unwrap_or("~"),
            &home(),
        ));
        let mut result =
            json!({"state": "done", "code": 127, "stdout": "", "stderr": "", "truncated": false});
        let spawned = {
            // A stop that arrives while the command starts either skips or kills it.
            let mut processes = self.processes.lock().unwrap();
            let denied = |reason| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    reason,
                ))
            };
            if processes.cancelled.remove(&id) {
                denied("The agent stopped this command before it started, so it did not run.")
            } else if processes.stopping {
                denied(
                    "Cloudroom on the Mac is stopping, so this command did not run. Try again in a minute.",
                )
            } else if sandbox.is_some_and(|key| !self.wanted.lock().unwrap().contains(key)) {
                // end_unwanted only ends what started before: Off or a sleeping sandbox counts from here on.
                denied(
                    "The Mac stopped taking commands from this sandbox, so this command did not run.",
                )
            } else {
                let spawned = command(&argv[0])
                    .args(&argv[1..])
                    .current_dir(&folder)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn();
                if let Ok(child) = &spawned
                    && let Some(pid) = child.id()
                {
                    processes.running.insert(id.clone(), pid);
                    if let (Some(mark), Some(key)) = (&mark, sandbox) {
                        let running = Sandbox {
                            core: Some(key.clone()),
                            allowed: None,
                            shell: Some(pid),
                        };
                        processes.sandboxes.insert(mark.clone(), running);
                    }
                }
                spawned
            }
        };
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => {
                result["code"] = json!(if error.kind() == std::io::ErrorKind::PermissionDenied {
                    126
                } else {
                    127
                });
                result["stderr"] = json!(hex(error.to_string().as_bytes()));
                return result;
            }
        };
        let read = |pipe: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| {
            let output = Arc::new(Mutex::new(Some(Vec::new())));
            let collected = output.clone();
            let task = tokio::spawn(async move {
                let Some(mut pipe) = pipe else { return };
                let mut chunk = vec![0u8; 65536];
                // Once the result is taken (None), keep draining: a background process the command left running
                // would die writing to a closed pipe.
                while let Ok(read @ 1..) = pipe.read(&mut chunk).await {
                    if let Some(output) = collected
                        .lock()
                        .unwrap()
                        .as_mut()
                        .filter(|output| output.len() <= LIMIT)
                    {
                        output.extend_from_slice(&chunk[..read]);
                    }
                }
            });
            (output, task)
        };
        let (stdout, out_task) = read(child.stdout.take().map(|pipe| Box::new(pipe) as _));
        let (stderr, err_task) = read(child.stderr.take().map(|pipe| Box::new(pipe) as _));
        let input = unhex(job["stdin"].as_str().unwrap_or_default()).unwrap_or_default();
        if let Some(mut pipe) = child.stdin.take() {
            tokio::spawn(async move {
                let _ = pipe.write_all(&input).await;
            });
        }
        let status = child.wait().await;
        if let Some(mark) = &mark
            && let Some(sandbox) = self.processes.lock().unwrap().sandboxes.get_mut(mark)
        {
            sandbox.shell = None; // Reaped: never signal its PID again.
        }
        let code = status.map(|status| {
            use std::os::unix::process::ExitStatusExt;
            status
                .code()
                .unwrap_or_else(|| -status.signal().unwrap_or(1))
        });
        result["code"] = json!(code.unwrap_or(127));
        // A read-only command leaves nothing running, so its output ends here too.
        let ended = match mark.clone() {
            Some(mark) => {
                (tokio::task::spawn_blocking(move || end(&mark, None)).await).unwrap_or(false)
            }
            None => false,
        };
        for task in [out_task, err_task] {
            // A background process may keep the pipe open: stop waiting after 2 s, but never stop reading.
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
        {
            let mut processes = self.processes.lock().unwrap();
            processes.running.remove(&id);
            if let Some(mark) = mark {
                if ended {
                    processes.sandboxes.remove(&mark);
                } else {
                    processes.sandboxes.insert(mark, Sandbox::default()); // end_unwanted keeps ending it.
                    self.contained.store(false, Ordering::SeqCst);
                }
            }
        }
        let (out, mut err) = (
            stdout.lock().unwrap().take().unwrap_or_default(),
            stderr.lock().unwrap().take().unwrap_or_default(),
        );
        let failed = result["code"] != json!(0);
        let lower = err.to_ascii_lowercase();
        let read_only = level(&self.enabled().unwrap_or(Value::Null)) == "read-only";
        // Blocked local connections fail as EPERM, or as curl's "couldn't connect".
        if sandboxed
            && failed
            && [&b"not permitted"[..], b"eperm", b"couldn't connect"]
                .iter()
                .any(|sign| contains(&lower, sign))
            && !contains(&lower, b"deadlock avoided")
        {
            err.extend_from_slice(if read_only {
                b"\nCloudroom: Mac access is Read-only, so commands cannot change the Mac, reach its local servers or sockets, or read Cloudroom's files.\n"
            } else {
                b"\nCloudroom: this ran read-only, without this Mac's local servers, sockets, or Cloudroom's files. To change the Mac or reach them, rerun with `room-cli mac run --write ...`; the user approves it first.\n"
            });
        }
        // Reading an iCloud file that "Optimize Mac Storage" moved off the Mac downloads it, which the sandbox blocks (#144).
        if sandboxed && failed && contains(&lower, b"deadlock avoided") {
            err.extend_from_slice(b"\nCloudroom: this iCloud file isn't downloaded to the Mac, and read-only commands cannot download it. ");
            err.extend_from_slice(if read_only {
                &b"Mac access is Read-only, so ask the user to download it in Finder: Download Now, or Keep Downloaded so macOS doesn't move it off again.\n"[..]
            } else {
                b"Rerun your command with `room-cli mac run --write ...`: a read outside the sandbox downloads the file and waits for it. Or download it first with `room-cli mac run --write 'brctl download PATH'`. The user approves either.\n"
            });
        }
        result["truncated"] = json!(out.len() > LIMIT || err.len() > LIMIT);
        result["stdout"] = json!(hex(&out[..out.len().min(LIMIT)]));
        result["stderr"] = json!(hex(&err[..err.len().min(LIMIT)]));
        result
    }

    pub(super) fn cancel(&self, id: &str) {
        let pid = {
            let mut processes = self.processes.lock().unwrap();
            match processes.running.get(id) {
                Some(pid) => Some(*pid as i32),
                None => {
                    if processes.taken.contains_key(id) {
                        processes.cancelled.insert(id.to_owned());
                    }
                    None
                }
            }
        };
        if let Some(pid) = pid {
            unsafe { killpg(pid, SIGTERM) };
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                unsafe { killpg(pid, SIGKILL) };
            });
        }
    }
}

/// A script file the command runs, often one the agent just pushed to /tmp, so the check judges what really runs.
fn script_of(job: &Value) -> Option<String> {
    let home = home();
    let folder = home.join(expanduser(
        job["cwd"]
            .as_str()
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or("~"),
        &home,
    ));
    for word in job["command"].as_str()?.split_whitespace() {
        let path = folder.join(expanduser(
            word.trim_matches(|c| "'\"();&|".contains(c)),
            &home,
        ));
        let script = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| SCRIPT_TYPES.contains(&extension));
        let remote = path.starts_with("/Volumes") || path.starts_with("/Network");
        if script && !remote && path.is_file() {
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(
                &mut std::io::Read::take(std::fs::File::open(&path).ok()?, 32_000),
                &mut bytes,
            )
            .ok()?;
            return Some(String::from_utf8_lossy(&bytes).chars().take(8000).collect());
        }
    }
    None
}

/// Large output travels in parts, then `done` carries the rest. A core without parts (HTTP 422) gets it whole.
async fn deliver<F, R>(post: &F, result: &Value) -> Result<()>
where
    F: Fn(Value, Duration) -> R,
    R: std::future::Future<Output = Result<Value>>,
{
    let (stdout, stderr) = (
        result["stdout"].as_str().unwrap_or_default(),
        result["stderr"].as_str().unwrap_or_default(),
    );
    let mut whole = result.clone();
    if stdout.len() + stderr.len() > PART {
        let parts: Result<()> = async {
            for (name, data) in [("stdout", stdout), ("stderr", stderr)] {
                for offset in (0..data.len()).step_by(PART) {
                    post(json!({"state": "part", "offset": offset, name: &data[offset..(offset + PART).min(data.len())]}), POST).await?;
                }
            }
            Ok(())
        }
        .await;
        match parts {
            Ok(()) => (whole["stdout"], whole["stderr"]) = (json!(""), json!("")),
            Err(Error::Http(422)) => {}
            Err(error) => return Err(error),
        }
    }
    post(whole, POST).await.map(|_| ())
}
