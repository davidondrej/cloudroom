//! Preview registration, not web-server or harness lifecycle ownership.
use crate::config::Config;
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
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::net::{TcpStream, UnixListener};

const SOCKET: &str = "/run/cloudroom/preview.sock";
const FRESH_SECONDS: u64 = 15;
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
        self.reports.lock().unwrap().clear();
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
        let active = reports.values().filter(|(at, r)| {
            r.port == port
                && r.generation == entry.generation
                && now().saturating_sub(*at) <= FRESH_SECONDS
        });
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
            "url":url,"message":error.map(String::as_str).unwrap_or(if ready.is_some() {"Preview connected"} else {"Waiting for the paired Mac; check again with room-cli preview status"})}),
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
            if !saved.devices.is_empty() {
                return Err(conflict(
                    "Previews are paired with another Mac; disconnect its previews first",
                ));
            }
            let mut next = saved.clone();
            next.devices.insert(device.device, device.public_key);
            self.save(&next)?;
            *saved = next;
        }
        if setup.tunnel {
            return Ok(json!({"tunnel":true}));
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
        self.reports.lock().unwrap().clear();
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
    let task = tokio::spawn(async move {
        if let Ok(upgraded) = upgrade.await {
            let mut mac = hyper_util::rt::TokioIo::new(upgraded);
            let _ = tokio::io::copy_bidirectional(&mut mac, &mut upstream).await;
        }
    });
    let mut tunnels = m.previews.tunnels.lock().unwrap();
    tunnels.retain(|live| !live.task.is_finished());
    tunnels.push(Live {
        port,
        device: input.device,
        task: task.abort_handle(),
    });
    Ok(Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, protocol)
        .body(Body::empty())
        .unwrap())
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
    Ok(Json(m.previews.pair(input)?))
}
async fn revoke(
    State(m): State<Arc<crate::session::Manager>>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Value>> {
    Ok(Json(m.previews.revoke(&id)?))
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
    let request = |method: &str, path: &str, body: Option<Value>| -> io::Result<Value> {
        let mut command = std::process::Command::new("curl");
        command.args([
            "--silent",
            "--show-error",
            "--max-time",
            "5",
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
            result = request("GET", &path, None)?;
        }
    }
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
