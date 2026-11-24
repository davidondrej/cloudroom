//! Preview registration, not web-server or harness lifecycle ownership.
use crate::{config::Config, observability::Signal};
use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, Path as RoutePath, Query, Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    net::IpAddr,
    os::unix::{
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::UnixStream as StdUnixStream,
    },
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UnixListener},
};

const SOCKET: &str = "/run/cloudroom/preview.sock";
const FRESH_SECONDS: u64 = 15;
/// An open preview keeps a hosted sandbox's pairing while its helper reported within this long (#608). Helpers report
/// every 10 s, one sandbox at a time with 5 s timeouts, so a slow sandbox can delay a report past FRESH_SECONDS. The
/// app's `previewStatus` uses the same 45 s.
const BROWSING_SECONDS: u64 = 45;
/// An awake helper pairs every 60 s plus one check (PAIR_SECONDS, POLL_SECONDS in client.py). A longer gap may be a
/// sleep, so the next pairing starts a new streak; a slow helper then just keeps the usual message.
const PAIRING_GAP: Duration = Duration::from_secs(75);
/// A helper that kept pairing this long without reporting a preview isn't asleep, so its pending message says so (#1839).
/// Generous: a helper checking many slow sandboxes can take over 100 s between reports.
const SILENT: Duration = Duration::from_secs(180);
const MAX_PAIRING_SEEN: usize = 16;
pub const SKILL: &str = include_str!("cloud-preview/SKILL.md");

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Setup {
    socket: PathBuf,
    host: Option<IpAddr>,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    host_key_file: PathBuf,
    agent_uid: u32,
    /// Sandboxes have no inbound SSH: the Mac reaches previews through Core's own HTTPS port.
    #[serde(default)]
    tunnel: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    generation: String,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    previews: BTreeMap<u16, Entry>,
    devices: BTreeMap<String, String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    device: String,
    generation: String,
    port: u16,
    local_port: Option<u16>,
    error: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Device {
    device: String,
    public_key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Port {
    port: u16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Host {
    host: IpAddr,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TunnelDevice {
    device: String,
}
/// An open preview tunnel, closed when its preview or device goes away.
struct Live {
    port: u16,
    device: String,
    task: tokio::task::AbortHandle,
}

pub struct Previews {
    directory: PathBuf,
    setup: Mutex<Option<Setup>>,
    saved: Mutex<Saved>,
    reports: Mutex<BTreeMap<(String, u16), (u64, Report)>>,
    tunnels: Mutex<Vec<Live>>,
    core_port: u16,
    /// When a browser last loaded a preview page or called its API, in ms; 0 for never. The website counts it as activity.
    active: AtomicU64,
    /// Each device's last recorded pairing outcome and holder. Helpers retry every few seconds; only changes are recorded.
    pairing_seen: Mutex<BTreeMap<String, (&'static str, Option<String>)>>,
    /// The paired device, when it last paired, and since when it has kept pairing: an awake helper does once a minute,
    /// a sleeping Mac never.
    checked_in: Mutex<Option<(String, Instant, Instant)>>,
    /// When each port was last reported, and when a preview was last registered or reports were cleared (initially,
    /// Core's start). Monotonic, unlike the reports' own times, so a clock change can't fake a silence.
    reported: Mutex<BTreeMap<u16, Instant>>,
    reset: Mutex<Instant>,
    /// A pairing just freed for a Mac that asked for jobs waits a few seconds for it, so the device that lost it
    /// can't pair again first (#608).
    reserved: Mutex<Option<(String, Instant)>>,
    /// A hosted Cloud sandbox: the website names each one's Core `room-…` (CLOUDROOM_INSTANCE). Only these move their
    /// pairing on their own; VMs and self-hosted servers, which may use tunnels too, keep theirs (#608).
    sandbox: bool,
}
#[derive(Debug)]
pub struct Failure(StatusCode, String);
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Preview storage unavailable: {error}"),
        )
    }
}
type Result<T> = std::result::Result<T, Failure>;
fn conflict(message: &'static str) -> Failure {
    Failure(StatusCode::CONFLICT, message.into())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn short_device(device: &str) -> String {
    device.chars().take(8).collect()
}
fn valid_device(device: &str) -> bool {
    device.len() == 32 && device.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_key(key: &str) -> bool {
    key.strip_prefix("ssh-ed25519 ").is_some_and(|key| {
        key.len() == 68
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
    })
}
fn atomic(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    serde_json::to_writer(&mut file, value)?;
    file.flush()?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    fs::File::open(path.parent().unwrap())?.sync_all()
}

impl Previews {
    pub fn open(config: &Config) -> io::Result<Arc<Self>> {
        let directory = config.state_dir.join("previews");
        let setup: Option<Setup> = match fs::read(directory.join("setup.json")) {
            Ok(bytes) => Some(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        if let Some(setup) = &setup {
            if (!setup.tunnel && (!setup.host_key_file.is_absolute() || setup.port == 0))
                || !setup.socket.is_absolute()
                || config
                    .storage
                    .as_ref()
                    .is_some_and(|p| p.agent_uid != setup.agent_uid)
            {
                return Err(io::Error::other("invalid preview setup"));
            }
            for path in [directory.as_path(), directory.join("setup.json").as_path()] {
                let m = fs::symlink_metadata(path)?;
                if m.file_type().is_symlink()
                    || m.mode() & 0o022 != 0
                    || config
                        .storage
                        .as_ref()
                        .is_some_and(|p| !p.container() && m.uid() == p.agent_uid)
                {
                    return Err(io::Error::other(
                        "preview setup must be protected from agent writes",
                    ));
                }
            }
        }
        let saved = if setup.is_some() {
            match fs::read(directory.join("registry.json")) {
                Ok(bytes) => serde_json::from_slice(&bytes)?,
                Err(e) if e.kind() == io::ErrorKind::NotFound => Saved::default(),
                Err(e) => return Err(e),
            }
        } else {
            Saved::default()
        };
        Ok(Arc::new(Self {
            directory,
            setup: Mutex::new(setup),
            saved: Mutex::new(saved),
            reports: Mutex::new(BTreeMap::new()),
            tunnels: Mutex::new(Vec::new()),
            core_port: config.listen.port(),
            active: AtomicU64::new(0),
            pairing_seen: Mutex::default(),
            checked_in: Mutex::default(),
            reported: Mutex::default(),
            reset: Mutex::new(Instant::now()),
            reserved: Mutex::default(),
            sandbox: config
                .instance
                .as_deref()
                .is_some_and(|name| name.starts_with("room-")),
        }))
    }
    /// Mac access shares the preview pairing and agent identity.
    pub(crate) fn agent(&self) -> Option<(PathBuf, u32)> {
        self.setup
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| (s.socket.with_file_name("mac.sock"), s.agent_uid))
    }
    pub(crate) fn paired(&self, device: &str) -> bool {
        self.saved.lock().unwrap().devices.contains_key(device)
    }
    /// Frees a hosted sandbox's pairing for `next`, a Mac that asked for jobs (#608), if the paired device has no
    /// preview open and `may_free(device, when it last paired since Core started)` agrees. The registry stays locked
    /// from check to revoke, as in `while_paired` and `track`, so a reconnect or new tunnel can't slip in between.
    pub(crate) fn release_for(
        &self,
        next: &str,
        may_free: impl FnOnce(&str, Option<Instant>) -> bool,
    ) -> bool {
        if !self.sandbox {
            return false;
        }
        let mut saved = self.saved.lock().unwrap();
        let Some(holder) = saved.devices.keys().next().cloned() else {
            return false;
        };
        // Tunnels open per request, so an idle preview tab shows only as the helper's report, about every 10 s.
        let browsing =
            self.tunnels
                .lock()
                .unwrap()
                .iter()
                .any(|live| live.device == holder && !live.task.is_finished())
                || self.reports.lock().unwrap().values().any(|(at, r)| {
                    r.device == holder && now().saturating_sub(*at) <= BROWSING_SECONDS
                });
        let checked_in = self
            .checked_in
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(device, _, _)| *device == holder)
            .map(|(_, at, _)| *at);
        if browsing || !may_free(&holder, checked_in) {
            return false;
        }
        let mut after = saved.clone();
        after.devices.remove(&holder);
        if self.save(&after).is_err() {
            return false;
        }
        *saved = after;
        *self.reserved.lock().unwrap() = Some((next.to_owned(), Instant::now()));
        self.clear_reports();
        let _ = self.disconnect(|live| live.device == holder);
        true
    }
    /// Runs `attach` only while `device` is paired, with the registry locked against `release_for`.
    pub(crate) fn while_paired(&self, device: &str, attach: impl FnOnce()) -> bool {
        let saved = self.saved.lock().unwrap();
        let paired = saved.devices.contains_key(device);
        if paired {
            attach();
        }
        paired
    }
    fn clear_reports(&self) {
        self.reports.lock().unwrap().clear();
        *self.reset.lock().unwrap() = Instant::now();
    }
    /// The device that holds this sandbox's pairing, shortened for diagnostics.
    pub(crate) fn holder(&self) -> Option<String> {
        let saved = self.saved.lock().unwrap();
        saved
            .devices
            .keys()
            .next()
            .map(|device| short_device(device))
    }
    /// What to record for this pairing try: nothing unless its outcome or holder changed.
    fn pairing_signal(&self, device: &str, paired: bool) -> Option<Signal> {
        if !valid_device(device) {
            return None;
        }
        let holder = self.holder();
        let outcome = if paired {
            "paired"
        } else if holder.as_deref() == Some(short_device(device).as_str()) {
            "failed"
        } else {
            "refused"
        };
        let mut seen = self.pairing_seen.lock().unwrap();
        let unseen = !seen.contains_key(device);
        if (unseen && seen.len() >= MAX_PAIRING_SEEN)
            || seen
                .get(device)
                .is_some_and(|(o, h)| *o == outcome && *h == holder)
        {
            return None;
        }
        seen.insert(device.to_owned(), (outcome, holder.clone()));
        Some(Signal::MacPairing {
            device: short_device(device),
            outcome,
            holder,
        })
    }
    pub fn last_activity(&self) -> Option<u64> {
        Some(self.active.load(Ordering::Relaxed)).filter(|at| *at > 0)
    }
    pub fn enabled(&self) -> bool {
        self.setup.lock().unwrap().is_some()
    }
    fn setup(&self) -> Result<Setup> {
        self.setup
            .lock()
            .unwrap()
            .clone()
            .ok_or(conflict("Preview setup is not installed on this VM"))
    }
    fn save(&self, saved: &Saved) -> Result<()> {
        atomic(&self.directory.join("registry.json"), saved)?;
        Ok(())
    }
    pub fn set_host(&self, host: IpAddr) -> Result<Value> {
        if host.is_unspecified() || host.is_multicast() {
            return Err(conflict("Invalid SSH host"));
        }
        let mut guard = self.setup.lock().unwrap();
        let mut setup = guard
            .clone()
            .ok_or(conflict("Preview setup is not installed on this VM"))?;
        setup.host = Some(host);
        atomic(&self.directory.join("setup.json"), &setup)?;
        *guard = Some(setup);
        Ok(json!({"configured":true}))
    }
    fn port_allowed(&self, port: u16) -> Result<()> {
        if port < 1024 || port == self.core_port || port == self.setup()?.port {
            return Err(conflict(
                "Only non-administrative application ports can be previewed",
            ));
        }
        if !agent_listener(port, self.setup()?.agent_uid)? {
            return Err(conflict(
                "Start the HTTP server as the agent account before requesting a preview",
            ));
        }
        Ok(())
    }
    pub async fn register(&self, port: u16) -> Result<Value> {
        self.port_allowed(port)?;
        tokio::time::timeout(
            Duration::from_secs(2),
            TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)),
        )
        .await
        .map_err(|_| conflict("The cloud server did not accept a connection within 2 seconds"))?
        .map_err(|error| {
            Failure(
                StatusCode::CONFLICT,
                format!("The cloud server is not listening on 127.0.0.1:{port}: {error}"),
            )
        })?;
        let mut saved = self.saved.lock().unwrap();
        if !saved.previews.contains_key(&port) {
            let mut next = saved.clone();
            let generation = format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            next.previews.insert(port, Entry { generation });
            self.save(&next)?;
            *saved = next;
            *self.reset.lock().unwrap() = Instant::now();
        }
        drop(saved);
        self.view(port)
    }
    pub fn close(&self, port: u16) -> Result<Value> {
        self.setup()?;
        let mut saved = self.saved.lock().unwrap();
        let mut next = saved.clone();
        next.previews.remove(&port);
        self.save(&next)?;
        *saved = next;
        self.clear_reports();
        self.disconnect(|live| live.port == port)?;
        Ok(json!({"port":port,"state":"closed"}))
    }
    pub fn view(&self, port: u16) -> Result<Value> {
        self.setup()?;
        let saved = self.saved.lock().unwrap();
        let entry = saved.previews.get(&port).ok_or(Failure(
            StatusCode::NOT_FOUND,
            "Preview is not registered".into(),
        ))?;
        let reports = self.reports.lock().unwrap();
        let mine = reports
            .values()
            .filter(|(_, r)| r.port == port && r.generation == entry.generation);
        let last = mine.clone().map(|(at, _)| now().saturating_sub(*at)).min();
        let active = mine.filter(|(at, _)| now().saturating_sub(*at) <= FRESH_SECONDS);
        // Say which wait it is (#1060). Reports for an older generation are refused, so none are stored.
        let pending = match last {
            None if saved.devices.is_empty() => {
                "No Mac is paired with this sandbox yet (room-cli mac status says why)".into()
            }
            None => "The paired Mac has not reported this preview yet (it checks every 10 seconds)"
                .into(),
            Some(age) if age > FRESH_SECONDS => format!(
                "The paired Mac stopped reporting this preview {age} seconds ago, so it may be asleep or offline"
            ),
            Some(_) => "The paired Mac is still opening its tunnel to this preview".into(),
        } + "; check again with room-cli preview status";
        // A helper that kept pairing all along but hasn't reported this preview for SILENT is online (#1839).
        let silent = self
            .checked_in
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(device, at, _)| {
                saved.devices.contains_key(device) && at.elapsed() < PAIRING_GAP
            })
            .map(|(_, _, since)| {
                let reported = self.reported.lock().unwrap().get(&port).copied();
                let waiting = (*since).max(*self.reset.lock().unwrap());
                reported.map_or(waiting, |at| at.max(waiting)).elapsed()
            })
            .filter(|waited| *waited > SILENT);
        let pending = match silent {
            Some(waited) => format!(
                "The paired Mac is online but its preview helper hasn't reported this preview for {} seconds. \
                 If this doesn't clear, the user can restart Cloudroom on that Mac; check again with room-cli preview status",
                waited.as_secs()
            ),
            None => pending,
        };
        let ready = active.clone().find(|(_, r)| r.local_port.is_some());
        let error = active.filter_map(|(_, r)| r.error.as_ref()).next();
        let url = ready.map(|(_, r)| {
            format!(
                "http://p{port}-{}.localhost:{}",
                &r.device[..8],
                r.local_port.unwrap()
            )
        });
        Ok(
            json!({"port":port,"generation":entry.generation,"state":if ready.is_some() {"ready"} else if error.is_some() {"error"} else {"pending"},
            "url":url,"message":error.map(String::as_str).unwrap_or(if ready.is_some() {"Preview connected"} else {&pending})}),
        )
    }
    pub fn list(&self) -> Result<Value> {
        self.setup()?;
        let ports: Vec<_> = self
            .saved
            .lock()
            .unwrap()
            .previews
            .keys()
            .copied()
            .collect();
        Ok(json!({"previews":ports.into_iter().map(|p|self.view(p)).collect::<Result<Vec<_>>>()?}))
    }
    pub fn pair(&self, device: Device) -> Result<Value> {
        let setup = self.setup()?;
        if !valid_device(&device.device) || !valid_key(&device.public_key) {
            return Err(conflict("Invalid preview device key"));
        }
        let host = match setup.host {
            Some(host) => Some(host),
            None if setup.tunnel => None,
            None => {
                return Err(conflict(
                    "The VM's preview SSH address has not been configured",
                ));
            }
        };
        let mut saved = self.saved.lock().unwrap();
        if saved
            .devices
            .get(&device.device)
            .is_some_and(|key| key != &device.public_key)
        {
            return Err(conflict("This preview device already has a different key"));
        }
        if !saved.devices.contains_key(&device.device) {
            let reserved = self
                .reserved
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|(next, at)| {
                    *next != device.device && at.elapsed() < Duration::from_secs(10)
                });
            if !saved.devices.is_empty() || reserved {
                return Err(conflict(
                    "Previews are paired with another Mac; disconnect its previews first",
                ));
            }
            let mut next = saved.clone();
            next.devices
                .insert(device.device.clone(), device.public_key);
            self.save(&next)?;
            *saved = next;
        }
        let mut checked_in = self.checked_in.lock().unwrap();
        let since = checked_in
            .as_ref()
            .filter(|(held, at, _)| *held == device.device && at.elapsed() < PAIRING_GAP)
            .map_or_else(Instant::now, |(_, _, since)| *since);
        *checked_in = Some((device.device, Instant::now(), since));
        drop(checked_in);
        if setup.tunnel {
            // Core counts page loads on every read of a tunnel, so a helper may keep one for a browser connection's next
            // requests. Older Cores count only a tunnel's first request (#2428).
            return Ok(json!({"tunnel":true,"reuse":true}));
        }
        let text = fs::read_to_string(&setup.host_key_file)?;
        let host_key = text
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        if !valid_key(&host_key) {
            return Err(conflict("The VM's public SSH host key is unavailable"));
        }
        Ok(json!({"host":host,"port":setup.port,"user":"cloudroom-preview","host_key":host_key}))
    }
    pub fn revoke(&self, device: &str) -> Result<Value> {
        self.setup()?;
        let mut saved = self.saved.lock().unwrap();
        let mut next = saved.clone();
        next.devices.remove(device);
        self.save(&next)?;
        *saved = next;
        self.clear_reports();
        self.disconnect(|live| live.device == device)?;
        Ok(json!({"revoked":true}))
    }
    pub fn report(&self, input: Report) -> Result<Value> {
        let saved = self.saved.lock().unwrap();
        if !saved.devices.contains_key(&input.device)
            || !saved
                .previews
                .get(&input.port)
                .is_some_and(|p| p.generation == input.generation)
        {
            return Err(conflict(
                "Preview or device changed; refresh before reporting",
            ));
        }
        if input.local_port == Some(0)
            || input.local_port.is_some() && input.error.is_some()
            || input.error.as_ref().is_some_and(|s| {
                ![
                    "SSH connection unavailable",
                    "Tunnel unavailable",
                    "Cloud HTTP server unavailable",
                    "Local preview port unavailable",
                ]
                .contains(&s.as_str())
            })
        {
            return Err(conflict("Invalid preview status"));
        }
        self.reported
            .lock()
            .unwrap()
            .insert(input.port, Instant::now());
        self.reports
            .lock()
            .unwrap()
            .insert((input.device.clone(), input.port), (now(), input));
        Ok(json!({"accepted":true}))
    }
    /// Ends SSH forwarding (VMs) or open tunnels (sandboxes) that no longer have a preview or device.
    fn disconnect(&self, stale: impl Fn(&Live) -> bool) -> Result<()> {
        if self.setup()?.tunnel {
            self.tunnels.lock().unwrap().retain(|live| {
                if stale(live) {
                    live.task.abort();
                }
                !stale(live) && !live.task.is_finished()
            });
            return Ok(());
        }
        disconnect_ssh(
            self.setup()?.agent_uid,
            fs::metadata(&self.directory)?.uid(),
        )?;
        Ok(())
    }
    /// A paired Mac's tunnel to a registered preview, rechecking that the agent still owns the listener.
    async fn connect(&self, port: u16, device: &str) -> Result<TcpStream> {
        if !self.setup()?.tunnel {
            return Err(conflict("Previews on this VM use SSH"));
        }
        {
            let saved = self.saved.lock().unwrap();
            if !saved.devices.contains_key(device) || !saved.previews.contains_key(&port) {
                return Err(Failure(
                    StatusCode::FORBIDDEN,
                    "Preview or device is not registered".into(),
                ));
            }
        }
        self.port_allowed(port)?;
        TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .map_err(|_| conflict("The cloud server is not listening"))
    }
    pub async fn listen(self: &Arc<Self>) -> io::Result<()> {
        let Some(setup) = self.setup.lock().unwrap().clone() else {
            return Ok(());
        };
        let path = &setup.socket;
        if let Ok(info) = fs::symlink_metadata(path) {
            if !info.file_type().is_socket() || StdUnixStream::connect(path).is_ok() {
                return Err(io::Error::other("preview socket is already occupied"));
            }
            fs::remove_file(path)?;
        }
        let listener = UnixListener::bind(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o666))?;
        let app = Router::new()
            .route("/previews", get(local_list).post(local_open))
            .route("/previews/{port}", get(local_get).delete(local_close))
            .layer(axum::extract::DefaultBodyLimit::max(1024))
            .with_state(self.clone());
        tokio::spawn(async move {
            if axum::serve(listener, app.into_make_service_with_connect_info::<Peer>())
                .await
                .is_err()
            {
                eprintln!("Cloudroom preview socket stopped");
            }
        });
        Ok(())
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Peer(pub(crate) Option<u32>, pub(crate) Option<i32>);
impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, UnixListener>>
    for Peer
{
    fn connect_info(stream: axum::serve::IncomingStream<'_, UnixListener>) -> Self {
        let cred = stream.io().peer_cred().ok();
        Self(cred.map(|c| c.uid()), cred.and_then(|c| c.pid()))
    }
}
fn local_auth(previews: &Previews, peer: Peer) -> Result<()> {
    if peer.0 != Some(previews.setup()?.agent_uid) {
        return Err(Failure(
            StatusCode::FORBIDDEN,
            "Only the VM agent account may request local previews".into(),
        ));
    }
    Ok(())
}
async fn local_open(
    State(p): State<Arc<Previews>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    Json(input): Json<Port>,
) -> Result<Json<Value>> {
    local_auth(&p, peer)?;
    Ok(Json(p.register(input.port).await?))
}
async fn local_list(
    State(p): State<Arc<Previews>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
) -> Result<Json<Value>> {
    local_auth(&p, peer)?;
    Ok(Json(p.list()?))
}
async fn local_get(
    State(p): State<Arc<Previews>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    RoutePath(port): RoutePath<u16>,
) -> Result<Json<Value>> {
    local_auth(&p, peer)?;
    Ok(Json(p.view(port)?))
}
async fn local_close(
    State(p): State<Arc<Previews>>,
    ConnectInfo(peer): ConnectInfo<Peer>,
    RoutePath(port): RoutePath<u16>,
) -> Result<Json<Value>> {
    local_auth(&p, peer)?;
    Ok(Json(p.close(port)?))
}

pub fn routes() -> Router<Arc<crate::session::Manager>> {
    Router::new()
        .route("/v1/previews", get(list).post(open))
        .route("/v1/previews/host", post(host))
        .route("/v1/previews/device", post(pair))
        .route("/v1/previews/device/{id}", axum::routing::delete(revoke))
        .route("/v1/previews/report", post(report))
        .route("/v1/previews/{port}", get(status).delete(close))
        .route("/v1/previews/{port}/tunnel", get(tunnel))
}
/// Sandbox previews: after `101 Switching Protocols`, raw bytes flow between the Mac and 127.0.0.1:PORT.
async fn tunnel(
    State(m): State<Arc<crate::session::Manager>>,
    RoutePath(port): RoutePath<u16>,
    Query(input): Query<TunnelDevice>,
    mut request: Request,
) -> Result<Response> {
    // Some sandbox proxies relay bytes only after a WebSocket handshake, so `websocket` names the same raw tunnel.
    // No WebSocket frames follow either way.
    let protocol = match request
        .headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
    {
        Some("cloudroom-tunnel") => "cloudroom-tunnel",
        Some("websocket") => "websocket",
        _ => {
            return Err(Failure(
                StatusCode::BAD_REQUEST,
                "Send Upgrade: websocket or cloudroom-tunnel".into(),
            ));
        }
    };
    let mut upstream = m.previews.connect(port, &input.device).await?;
    let upgrade = hyper::upgrade::on(&mut request);
    let previews = m.previews.clone();
    let task = tokio::spawn(async move {
        if let Ok(upgraded) = upgrade.await {
            let (mut mac_read, mut mac_write) =
                tokio::io::split(hyper_util::rt::TokioIo::new(upgraded));
            let (mut app_read, mut app_write) = upstream.split();
            // The Mac keeps a tunnel for its browser connection's next requests (#2428), so any read may start one.
            let requests = async {
                let mut chunk = vec![0; 8192];
                while let Ok(read @ 1..) = mac_read.read(&mut chunk).await {
                    if page_request(&chunk[..read]) {
                        previews
                            .active
                            .store(crate::observability::now_ms(), Ordering::Relaxed);
                    }
                    if app_write.write_all(&chunk[..read]).await.is_err() {
                        break;
                    }
                }
                let _ = app_write.shutdown().await;
            };
            let answers = async {
                let _ = tokio::io::copy(&mut app_read, &mut mac_write).await;
                let _ = mac_write.shutdown().await;
            };
            tokio::join!(requests, answers);
        }
    });
    let live = Live {
        port,
        device: input.device,
        task: task.abort_handle(),
    };
    // Registered with the registry locked, so `release_for` sees this tunnel or the tunnel sees the release (#608).
    if !m.previews.while_paired(&live.device.clone(), || {
        let mut tunnels = m.previews.tunnels.lock().unwrap();
        tunnels.retain(|live| !live.task.is_finished());
        tunnels.push(live);
    }) {
        task.abort();
        return Err(conflict(
            "Preview or device changed; refresh before connecting",
        ));
    }
    Ok(Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, protocol)
        .body(Body::empty())
        .unwrap())
}
/// A browser's page load or its own API call. Assets, WebSockets and the Mac helper's health checks
/// (they send no Sec-Fetch headers) don't count.
fn page_request(head: &[u8]) -> bool {
    let head = String::from_utf8_lossy(head).to_ascii_lowercase();
    let headers = head.split("\r\n\r\n").next().unwrap_or("");
    headers.lines().any(|line| {
        line.strip_prefix("sec-fetch-dest:")
            .is_some_and(|dest| matches!(dest.trim(), "document" | "iframe" | "empty"))
    })
}
async fn list(State(m): State<Arc<crate::session::Manager>>) -> Result<Json<Value>> {
    Ok(Json(m.previews.list()?))
}
async fn open(
    State(m): State<Arc<crate::session::Manager>>,
    Json(p): Json<Port>,
) -> Result<Json<Value>> {
    Ok(Json(m.previews.register(p.port).await?))
}
async fn status(
    State(m): State<Arc<crate::session::Manager>>,
    RoutePath(port): RoutePath<u16>,
) -> Result<Json<Value>> {
    Ok(Json(m.previews.view(port)?))
}
async fn close(
    State(m): State<Arc<crate::session::Manager>>,
    RoutePath(port): RoutePath<u16>,
) -> Result<Json<Value>> {
    Ok(Json(m.previews.close(port)?))
}
async fn host(
    State(m): State<Arc<crate::session::Manager>>,
    Json(input): Json<Host>,
) -> Result<Json<Value>> {
    Ok(Json(m.previews.set_host(input.host)?))
}
async fn pair(
    State(m): State<Arc<crate::session::Manager>>,
    Json(input): Json<Device>,
) -> Result<Json<Value>> {
    let device = input.device.clone();
    let result = m.previews.pair(input);
    if let Some(signal) = m.previews.pairing_signal(&device, result.is_ok()) {
        m.observability.record(signal);
    }
    Ok(Json(result?))
}
async fn revoke(
    State(m): State<Arc<crate::session::Manager>>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Value>> {
    let held = m.previews.paired(&id);
    let revoked = m.previews.revoke(&id)?;
    if held {
        m.observability.record(Signal::MacPairing {
            device: short_device(&id),
            outcome: "revoked",
            holder: None,
        });
    }
    Ok(Json(revoked))
}
async fn report(
    State(m): State<Arc<crate::session::Manager>>,
    Json(input): Json<Report>,
) -> Result<Json<Value>> {
    Ok(Json(m.previews.report(input)?))
}

fn agent_listener(port: u16, uid: u32) -> io::Result<bool> {
    let mut owners: [Vec<u32>; 3] = Default::default();
    for name in ["/proc/net/tcp", "/proc/net/tcp6"] {
        for line in fs::read_to_string(name)?.lines().skip(1) {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() <= 7 || fields[3] != "0A" {
                continue;
            }
            let Some((address, number)) = fields[1].rsplit_once(':') else {
                continue;
            };
            if u16::from_str_radix(number, 16).ok() != Some(port) {
                continue;
            }
            // An exact loopback bind takes precedence over wildcard listeners. Other addresses prove nothing.
            let priority = match address {
                "0100007F" | "0000000000000000FFFF00000100007F" => 0,
                "00000000" => 1,
                "00000000000000000000000000000000" => 2,
                _ => continue,
            };
            owners[priority].push(fields[7].parse().map_err(io::Error::other)?);
        }
    }
    Ok(owners
        .iter()
        .find(|uids| !uids.is_empty())
        .is_some_and(|uids| uids.iter().all(|owner| *owner == uid)))
}

#[cfg(target_os = "linux")]
fn disconnect_ssh(agent_uid: u32, service_uid: u32) -> io::Result<()> {
    use std::ffi::c_long;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    // musl has no pidfd wrappers, so call the kernel directly. These numbers are the same on every architecture.
    unsafe extern "C" {
        fn syscall(number: c_long, ...) -> c_long;
    }
    const PIDFD_OPEN: c_long = 434;
    const PIDFD_SEND_SIGNAL: c_long = 424;
    const NO_FLAGS: c_long = 0;
    const SIGKILL: c_long = 9;
    let pidfd_open = |pid: i32| unsafe { syscall(PIDFD_OPEN, c_long::from(pid), NO_FLAGS) as i32 };
    let pidfd_kill = |fd: i32| unsafe {
        syscall(
            PIDFD_SEND_SIGNAL,
            c_long::from(fd),
            SIGKILL,
            std::ptr::null::<()>(),
            NO_FLAGS,
        )
    };
    let passwd = fs::read_to_string("/etc/passwd")?;
    let uid = passwd
        .lines()
        .find_map(|line| {
            let fields: Vec<_> = line.split(':').collect();
            (fields.first() == Some(&"cloudroom-preview"))
                .then(|| fields.get(2)?.parse::<u32>().ok())
                .flatten()
        })
        .ok_or_else(|| io::Error::other("preview account missing"))?;
    if [0, agent_uid, service_uid].contains(&uid) {
        return Err(io::Error::other("unsafe preview account"));
    }
    // One paired Mac. SSH caches permitted ports at authentication, so closing a port invalidates these connections too.
    // Include root's dedicated SSH monitor: it exists before key lookup and owns any authentication still in flight.
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        let fd = pidfd_open(pid);
        if fd < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(3) {
                continue;
            }
            return Err(error);
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let status = match fs::read_to_string(entry.path().join("status")) {
            Ok(status) => status,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let ids: Vec<u32> = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .unwrap_or("")
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        let dedicated = ids.len() == 4 && ids.iter().all(|id| *id == uid);
        let monitor = if ids == [0, 0, 0, 0] {
            let args = fs::read(entry.path().join("cmdline")).unwrap_or_default();
            [
                "sshd: cloudroom-preview [priv]",
                "sshd-session: cloudroom-preview [priv]",
            ]
            .iter()
            .any(|title| args.split(|b| *b == 0).next() == Some(title.as_bytes()))
        } else {
            false
        };
        if (dedicated || monitor) && pidfd_kill(fd.as_raw_fd()) != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(3) {
                return Err(error);
            }
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn disconnect_ssh(_: u32, _: u32) -> io::Result<()> {
    Err(io::Error::other("preview SSH revocation requires Linux"))
}

#[cfg(all(test, target_os = "linux"))]
#[test]
fn only_the_forwarded_loopback_listener_proves_ownership() {
    let uid = fs::metadata("/proc/self").unwrap().uid();
    let other = std::net::TcpListener::bind("127.0.0.2:0").unwrap();
    let port = other.local_addr().unwrap().port();
    assert!(!agent_listener(port, uid).unwrap());
    let _exact = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
    assert!(agent_listener(port, uid).unwrap());
    assert!(!agent_listener(port, uid + 1).unwrap());
    let wildcard = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    assert!(agent_listener(wildcard.local_addr().unwrap().port(), uid).unwrap());
}

pub fn authorized_keys(registry: &Path, uid: u32) -> io::Result<()> {
    let saved: Saved = serde_json::from_slice(&fs::read(registry)?)?;
    let ports: Vec<_> = saved
        .previews
        .keys()
        .filter(|p| **p >= 1024 && agent_listener(**p, uid).unwrap_or(false))
        .collect();
    if ports.is_empty() {
        return Ok(());
    }
    let options = ports
        .iter()
        .map(|p| format!("permitopen=\"127.0.0.1:{p}\""))
        .collect::<Vec<_>>()
        .join(",");
    for key in saved.devices.values().filter(|key| valid_key(key)) {
        println!("restrict,port-forwarding,command=\"/bin/false\",{options} {key}");
    }
    Ok(())
}

pub async fn cli(args: &[String]) -> io::Result<()> {
    let mut args = args.to_vec();
    let socket = if args.first().map(String::as_str) == Some("--socket") {
        if args.len() < 2 {
            return Err(io::Error::other("--socket requires a path"));
        }
        let path = args.remove(1);
        args.remove(0);
        path
    } else {
        SOCKET.to_owned()
    };
    if args.is_empty() || args[0] == "--help" {
        println!(
            "room-cli preview PORT\nroom-cli preview status [PORT]\nroom-cli preview close PORT\nReturns JSON. Only state=ready contains a usable local URL. Local threads use their ordinary localhost server."
        );
        return Ok(());
    }
    let status = args[0] == "status";
    let close = args[0] == "close";
    let raw = args.get(usize::from(status || close));
    let port = raw
        .map(|p| {
            p.parse::<u16>()
                .map_err(|_| io::Error::other("port must be 1–65535"))
        })
        .transpose()?;
    if !status && port.is_none() {
        return Err(io::Error::other("preview requires a port"));
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    let left = || deadline.saturating_duration_since(Instant::now());
    let request = |method: &str, path: &str, body: Option<Value>| -> io::Result<Value> {
        let mut command = std::process::Command::new("curl");
        command.args([
            "--silent",
            "--show-error",
            "--max-time",
            &format!("{:.3}", left().as_secs_f64()),
            "--unix-socket",
            &socket,
            "-X",
            method,
            "-H",
            "Content-Type: application/json",
        ]);
        if let Some(body) = body {
            command.args(["--data-binary", &body.to_string()]);
        }
        let output = command.arg(format!("http://localhost{path}")).output()?;
        if output.status.code() == Some(28) {
            return Err(io::Error::other(
                "Cloudroom is busy; retry room-cli preview in a moment",
            ));
        }
        if !output.status.success() {
            return Err(io::Error::other(
                "Preview service unavailable; install preview setup or use the local thread's localhost server",
            ));
        }
        let value: Value = serde_json::from_slice(&output.stdout)?;
        if let Some(message) = value.get("error").and_then(Value::as_str) {
            return Err(io::Error::other(message.to_owned()));
        }
        Ok(value)
    };
    let path = port
        .map(|p| format!("/previews/{p}"))
        .unwrap_or("/previews".into());
    let mut result = if status {
        request("GET", &path, None)?
    } else if close {
        request("DELETE", &path, None)?
    } else {
        request("POST", "/previews", Some(json!({"port":port})))?
    };
    if !status && !close {
        for _ in 0..10 {
            if result["state"] != "pending" {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
            if left() < Duration::from_secs(1) {
                break;
            }
            result = request("GET", &path, None)?;
        }
    }
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
