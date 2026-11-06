//! One preview: a browser-facing proxy on localhost (both loopbacks) that forwards each request to the agent's port,
//! through an HTTPS upgrade to a sandbox's core (relay) or an SSH forward to a VM's Unix socket.

use super::net::{Core, Error, Result, Shared};
use super::sha256;
use serde_json::Value;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio::task::{JoinHandle, JoinSet};

const HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];
const HEAD_LIMIT: usize = 64 * 1024;
const SECOND: Duration = Duration::from_secs(1);
#[cfg(target_os = "macos")]
const NO_IPV6: [i32; 3] = [49, 47, 43]; // EADDRNOTAVAIL, EAFNOSUPPORT, EPROTONOSUPPORT
#[cfg(not(target_os = "macos"))]
const NO_IPV6: [i32; 3] = [99, 97, 93];

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// What every connection of one preview needs.
pub(super) struct Info {
    pub core: Core,
    pub port: u16,
    pub generation: String,
    pub local_port: u16,
    pub relay: bool,
    authority: String,
    loopbacks: Vec<IpAddr>,
    socket_path: PathBuf,
    device: String,
    direct: reqwest::Client,
    stopped: AtomicBool,
    /// Core found nothing listening on the port, as after a sleep.
    down: AtomicBool,
}

pub(super) struct Tunnel {
    pub info: Arc<Info>,
    pub endpoint: Value,
    ssh: Option<(tokio::process::Child, Arc<Mutex<Vec<u8>>>)>,
    listeners: Vec<JoinHandle<()>>,
    log_path: PathBuf,
}

impl Tunnel {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn open(
        shared: &Shared,
        folder: &Path,
        core: Core,
        port: u16,
        generation: String,
        device: &str,
        metadata: Value,
        allow_private: bool,
        local_port: u16,
    ) -> Result<Tunnel> {
        let relay = metadata["tunnel"].as_bool().unwrap_or(false);
        let suffix = if core.sandbox {
            sha256(core.url.as_bytes())[..8].to_owned()
        } else {
            String::new()
        };
        let socket_path = folder.join(format!("p{port}{suffix}.sock"));
        let _ = std::fs::remove_file(&socket_path);
        let log_path = folder.join(format!("ssh-{port}{suffix}.log"));
        let mut ssh = if relay {
            None
        } else {
            Some(ssh(folder, port, &metadata, allow_private, &socket_path)?)
        };
        let (listeners, local_port) = match listen(local_port).await {
            Ok(found) => found,
            Err(error) => {
                if let Some((child, _)) = &mut ssh {
                    stop_child(child).await;
                }
                return Err(error.into());
            }
        };
        let loopbacks = listeners
            .iter()
            .filter_map(|listener| listener.local_addr().ok().map(|address| address.ip()))
            .collect();
        let info = Arc::new(Info {
            core,
            port,
            generation,
            local_port,
            relay,
            authority: format!(
                "p{port}-{}.localhost:{local_port}",
                &device[..device.len().min(8)]
            ),
            loopbacks,
            socket_path,
            device: device.to_owned(),
            direct: shared.direct.clone(),
            stopped: AtomicBool::new(false),
            down: AtomicBool::new(false),
        });
        let listeners = listeners
            .into_iter()
            .map(|listener| tokio::spawn(serve(listener, info.clone())))
            .collect();
        Ok(Tunnel {
            info,
            endpoint: metadata,
            ssh,
            listeners,
            log_path,
        })
    }

    /// Whether its SSH process still runs; a relay runs until closed.
    pub(super) fn alive(&mut self) -> bool {
        match &mut self.ssh {
            Some((child, _)) => matches!(child.try_wait(), Ok(None)),
            None => !self.info.stopped.load(Ordering::SeqCst),
        }
    }

    pub(super) async fn close(&mut self) {
        self.info.stopped.store(true, Ordering::SeqCst);
        // Ending a listener's task drops every browser connection it serves, WebSockets included.
        for listener in self.listeners.drain(..) {
            listener.abort();
        }
        let mut log = Vec::new();
        if let Some((child, stderr)) = &mut self.ssh {
            stop_child(child).await;
            log = stderr.lock().unwrap().clone();
        }
        if std::fs::write(&self.log_path, log).is_ok() {
            let _ =
                std::fs::set_permissions(&self.log_path, std::fs::Permissions::from_mode(0o600));
        }
        let _ = std::fs::remove_file(&self.info.socket_path);
    }
}

async fn stop_child(child: &mut tokio::process::Child) {
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if let Some(pid) = child.id() {
        unsafe { kill(pid as i32, 15) };
    }
    if tokio::time::timeout(Duration::from_secs(6), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
    }
}

/// client.py's `is_global`, for a VM's SSH address.
fn global(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a == 0
                || a >= 240
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (18..20).contains(&b)))
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            !(ip.is_loopback()
                || ip.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first == 0x2001 && ip.segments()[1] == 0xdb8)
                || ip.to_ipv4_mapped().is_some())
        }
    }
}

fn ssh(
    folder: &Path,
    port: u16,
    metadata: &Value,
    allow_private: bool,
    socket_path: &Path,
) -> Result<(tokio::process::Child, Arc<Mutex<Vec<u8>>>)> {
    let address: IpAddr = metadata["host"]
        .as_str()
        .and_then(|host| host.parse().ok())
        .ok_or_else(|| Error::value("Invalid preview SSH endpoint"))?;
    if !global(address) && !allow_private {
        return Err(Error::value(
            "Private SSH addresses require explicit self-hosted setup",
        ));
    }
    let ssh_port = metadata["port"]
        .as_u64()
        .filter(|port| (1..=65535).contains(port));
    let (Some(ssh_port), Some("cloudroom-preview")) = (ssh_port, metadata["user"].as_str()) else {
        return Err(Error::value("Invalid preview SSH endpoint"));
    };
    let key = metadata["host_key"].as_str().unwrap_or_default();
    let base64 = |c: char| c.is_ascii_alphanumeric() || "+/=".contains(c);
    if key.len() != 80 || !key.starts_with("ssh-ed25519 ") || !key[12..].chars().all(base64) {
        return Err(Error::value("Invalid SSH host identity"));
    }
    let known = folder.join("known_hosts");
    std::fs::write(&known, format!("cloudroom-preview {key}\n"))?;
    std::fs::set_permissions(&known, std::fs::Permissions::from_mode(0o600))?;
    let mut child = tokio::process::Command::new("/usr/bin/ssh")
        .args(["-F", "/dev/null", "-N", "-T", "-i"])
        .arg(folder.join("id_ed25519"))
        .args([
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "HostKeyAlias=cloudroom-preview",
        ])
        .arg("-o")
        .arg(format!("UserKnownHostsFile={}", known.display()))
        .args([
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=2",
        ])
        .arg("-L")
        .arg(format!("{}:127.0.0.1:{port}", socket_path.display()))
        .args([
            "-p",
            &ssh_port.to_string(),
            &format!("cloudroom-preview@{address}"),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()?;
    let stderr = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut pipe) = child.stderr.take() {
        let stderr = stderr.clone();
        tokio::spawn(async move {
            let mut chunk = [0u8; 1024];
            while let Ok(read @ 1..) = pipe.read(&mut chunk).await {
                let mut log = stderr.lock().unwrap();
                log.extend_from_slice(&chunk[..read]);
                let extra = log.len().saturating_sub(16384);
                log.drain(..extra);
            }
        });
    }
    Ok((child, stderr))
}

/// Binds a port only when nothing answers there: macOS lets a second program bind a port in use, which would take
/// over the user's own local server.
async fn bind(ip: IpAddr, port: u16) -> io::Result<TcpListener> {
    let address = SocketAddr::new(ip, port);
    if port != 0
        && tokio::time::timeout(Duration::from_millis(500), TcpStream::connect(address))
            .await
            .is_ok_and(|connected| connected.is_ok())
    {
        return Err(io::Error::other(format!(
            "Port {port} is in use by another program"
        )));
    }
    TcpListener::bind(address).await
}

/// Browsers try ::1 first for *.localhost, so hold the port on both loopbacks. Otherwise another app on [::1]:port
/// answers the browser while the IPv4 health check still passes (#837).
async fn listen(wanted: u16) -> io::Result<(Vec<TcpListener>, u16)> {
    for attempt in [wanted, 0, 0, 0] {
        let Ok(v4) = bind(Ipv4Addr::LOCALHOST.into(), attempt).await else {
            continue;
        };
        let port = v4.local_addr()?.port();
        match bind(Ipv6Addr::LOCALHOST.into(), port).await {
            Ok(v6) => return Ok((vec![v4, v6], port)),
            Err(error)
                if error
                    .raw_os_error()
                    .is_some_and(|code| NO_IPV6.contains(&code)) =>
            {
                return Ok((vec![v4], port));
            }
            Err(_) => continue,
        }
    }
    Err(io::Error::other("No free local preview port"))
}

async fn serve(listener: TcpListener, info: Arc<Info>) {
    let mut connections = JoinSet::new();
    loop {
        while connections.try_join_next().is_some() {}
        match listener.accept().await {
            Ok((stream, _)) => {
                connections.spawn(proxy(stream, info.clone()));
            }
            // A client that left first or a full file table passes; only close() ends a preview (#902).
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
}

/// HTTP heads travel as Latin-1, as in client.py: every byte maps to one character and back, so a header that isn't
/// UTF-8, like a Latin-1 download name, passes through unchanged.
fn latin1(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
        .collect()
}

/// An HTTP head (request or response) with its header lines in order.
struct Head {
    first: String,
    headers: Vec<(String, String)>,
}

impl Head {
    fn parse(bytes: &[u8]) -> Option<Head> {
        let text: String = bytes.iter().map(|byte| char::from(*byte)).collect();
        let mut lines = text
            .split("\r\n")
            .map(|line| line.strip_suffix('\r').unwrap_or(line));
        let first = lines.next()?.to_owned();
        let mut headers = Vec::new();
        for line in lines.filter(|line| !line.is_empty()) {
            let (name, value) = line.split_once(':')?;
            if name.is_empty() || name.contains(char::is_whitespace) {
                return None;
            }
            headers.push((name.to_owned(), value.trim_matches([' ', '\t']).to_owned()));
        }
        Some(Head { first, headers })
    }

    fn all(&self, name: &str) -> Vec<&str> {
        self.headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .collect()
    }

    fn get(&self, name: &str) -> Option<&str> {
        self.all(name).first().copied()
    }

    /// Lower-cased names a Connection header lists, which are hop-by-hop too.
    fn connection_tokens(&self) -> Vec<String> {
        self.get("connection")
            .unwrap_or_default()
            .split(',')
            .map(|token| token.trim().to_lowercase())
            .collect()
    }
}

/// Reads up to the blank line after a head, starting with bytes already read; returns the head and any bytes past it.
async fn read_head(
    stream: &mut (impl AsyncRead + Unpin),
    mut buffer: Vec<u8>,
) -> io::Result<(Vec<u8>, Vec<u8>)> {
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            let rest = buffer.split_off(end + 4);
            buffer.truncate(end);
            return Ok((buffer, rest));
        }
        if buffer.len() > HEAD_LIMIT {
            return Err(io::Error::other("HTTP head too large"));
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
}

fn error_page(status: u16, message: &str, head_only: bool) -> Vec<u8> {
    let body = format!(
        "<!DOCTYPE HTML>\n<html><head><title>Error response</title></head><body><h1>Error response</h1><p>Error code: {status}</p><p>Message: {message}.</p></body></html>\n"
    );
    let mut out = format!("HTTP/1.1 {status} {message}\r\nConnection: close\r\nContent-Type: text/html;charset=utf-8\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
    if !head_only {
        out.extend_from_slice(body.as_bytes());
    }
    out
}

async fn proxy(mut client: TcpStream, info: Arc<Info>) {
    // 15 s for the browser to send its request head.
    let Ok(Ok((head, rest))) =
        tokio::time::timeout(Duration::from_secs(15), read_head(&mut client, Vec::new())).await
    else {
        return;
    };
    let Some(request) = Head::parse(&head) else {
        let _ = client
            .write_all(&error_page(400, "Bad request syntax", false))
            .await;
        return;
    };
    let mut parts = request.first.split(' ');
    let (Some(method), Some(path), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        let _ = client
            .write_all(&error_page(400, "Bad request syntax", false))
            .await;
        return;
    };
    if version == "HTTP/1.1"
        && request
            .get("expect")
            .is_some_and(|expect| expect.eq_ignore_ascii_case("100-continue"))
    {
        let _ = client.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await;
    }
    if let Err((status, message)) = forward(&mut client, &request, method, path, rest, &info).await
    {
        let _ = client
            .write_all(&error_page(status, &message, method == "HEAD"))
            .await;
    }
}

/// Checks a browser request and forwards it. An error before any answer was sent becomes an error page.
async fn forward(
    client: &mut TcpStream,
    request: &Head,
    method: &str,
    path: &str,
    rest: Vec<u8>,
    info: &Info,
) -> std::result::Result<(), (u16, String)> {
    let deny = |status: u16, message: &str| Err((status, message.to_owned()));
    let expected = &info.authority;
    let origin = request.get("origin");
    let own = format!("http://{expected}");
    if request.all("host") != [expected.as_str()] || origin.is_some_and(|origin| origin != own) {
        return deny(403, "Preview origin is not allowed");
    }
    let navigation = ["GET", "HEAD"].contains(&method)
        && request.get("sec-fetch-mode") == Some("navigate")
        && request.get("sec-fetch-dest") == Some("document");
    if request.get("sec-fetch-site") == Some("cross-site") && !navigation {
        return deny(403, "Cross-site preview request blocked");
    }
    if !path.starts_with('/') || path.starts_with("//") || request.all("content-length").len() > 1 {
        return deny(400, "Invalid preview request");
    }
    if request
        .get("transfer-encoding")
        .is_some_and(|value| !value.is_empty())
    {
        return deny(411, "Use a content length for preview uploads");
    }
    let length: u64 = match request
        .get("content-length")
        .map(|value| value.trim().trim_start_matches('+').parse::<i64>())
    {
        None => 0,
        Some(Ok(length)) if length >= 0 => length as u64,
        Some(_) => return deny(400, "Invalid content length"),
    };
    let websocket = request
        .get("upgrade")
        .is_some_and(|upgrade| upgrade.eq_ignore_ascii_case("websocket"));
    if websocket && origin != Some(own.as_str()) {
        return deny(403, "WebSocket origin is required");
    }
    let unavailable = || {
        if info.down.load(Ordering::SeqCst) {
            (502, "Your app's server in the sandbox isn't running. A sleep stops every server: ask the agent to start it again".to_owned())
        } else {
            (502, "Cloud preview unavailable; reconnecting".to_owned())
        }
    };
    let mut upstream = info.upstream().await.map_err(|_| unavailable())?;
    let skip = request.connection_tokens();
    let mut out = format!("{method} {path} HTTP/1.1\r\n");
    for (name, value) in &request.headers {
        let lower = name.to_lowercase();
        if !HOP.contains(&lower.as_str()) && !skip.contains(&lower) {
            out += &format!("{name}: {value}\r\n");
        }
    }
    out += if websocket {
        "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
    } else {
        "Connection: close\r\n\r\n"
    };
    let sent: io::Result<Vec<u8>> = async {
        upstream.write_all(&latin1(&out)).await?;
        // The body: what came with the head, then the rest from the browser.
        let take = rest.len().min(length as usize);
        upstream.write_all(&rest[..take]).await?;
        let mut left = length - take as u64;
        let mut chunk = vec![0u8; 64 * 1024];
        while left > 0 {
            let wanted = left.min(chunk.len() as u64) as usize;
            let read = client.read(&mut chunk[..wanted]).await?;
            if read == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            upstream.write_all(&chunk[..read]).await?;
            left -= read as u64;
        }
        Ok(rest[take..].to_vec())
    }
    .await;
    let Ok(early) = sent else {
        return Ok(()); // The browser left mid-upload.
    };
    // The app answers within 10 s, as client.py's upstream timeout. 1xx answers other than 101 come before the real one.
    let mut pending = Vec::new();
    let (response, body) = loop {
        let Ok(Ok((head, rest))) =
            tokio::time::timeout(Duration::from_secs(10), read_head(&mut upstream, pending)).await
        else {
            return Err(unavailable());
        };
        let Some(response) = Head::parse(&head) else {
            return Err(unavailable());
        };
        let status = response
            .first
            .split(' ')
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .ok_or_else(unavailable)?;
        if !(100..200).contains(&status) || status == 101 {
            break (response, rest);
        }
        pending = rest;
    };
    let mut line = response.first.splitn(3, ' ');
    let (_, status, reason) = (
        line.next(),
        line.next().unwrap_or("502"),
        line.next().unwrap_or(""),
    );
    let upgraded = status == "101";
    // Transfer-Encoding stays: the body passes through as the app sent it, and the browser decodes it.
    let skip: Vec<String> = response.connection_tokens();
    let mut out = format!("HTTP/1.1 {status} {reason}\r\n");
    for (name, value) in &response.headers {
        let lower = name.to_lowercase();
        if (lower == "transfer-encoding" || !HOP.contains(&lower.as_str()))
            && !skip.contains(&lower)
            && lower != "x-cloudroom-preview"
        {
            out += &format!("{name}: {value}\r\n");
        }
    }
    out += &format!(
        "X-Cloudroom-Preview: {}\r\nContent-Security-Policy: frame-ancestors 'self'\r\n",
        info.generation
    );
    out += if upgraded {
        "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
    } else {
        "Connection: close\r\n\r\n"
    };
    if client.write_all(&latin1(&out)).await.is_err()
        || client.write_all(&body).await.is_err()
        || upgraded && !websocket
    {
        return Ok(());
    }
    if upgraded {
        // A WebSocket: bytes both ways until either side ends it.
        let _ = upstream.write_all(&early).await;
        let (mut browser_read, mut browser_write) = client.split();
        let (mut app_read, mut app_write) = tokio::io::split(upstream);
        tokio::select! {
            _ = tokio::io::copy(&mut browser_read, &mut app_write) => {}
            _ = tokio::io::copy(&mut app_read, &mut browser_write) => {}
        }
    } else {
        // The app closes after its answer (Connection: close), which ends the body.
        let _ = tokio::io::copy(&mut upstream, client).await;
    }
    Ok(())
}

impl Info {
    /// The tunnel's local end is there: the SSH forward's Unix socket, or a relay that is open.
    pub(super) fn reachable(&self) -> bool {
        if self.relay {
            !self.stopped.load(Ordering::SeqCst)
        } else {
            self.socket_path.exists()
        }
    }

    async fn upstream(&self) -> io::Result<Box<dyn Stream>> {
        if !self.relay {
            let connected = tokio::time::timeout(
                Duration::from_secs(10),
                UnixStream::connect(&self.socket_path),
            )
            .await;
            return Ok(Box::new(
                connected.map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??,
            ));
        }
        self.down.store(false, Ordering::SeqCst); // Only this attempt's answer counts, never an older one's.
        // Some sandbox proxies relay bytes only after a WebSocket handshake; cores before 0.1.35 know only cloudroom-tunnel.
        match self.connect("websocket").await {
            Err(Some(400)) => self.connect("cloudroom-tunnel").await,
            other => other,
        }
        .map_err(|_| io::Error::other("Preview tunnel refused"))
    }

    /// Each local connection becomes an HTTPS upgrade to the sandbox core, which joins it to the agent's port. The
    /// "websocket" name only gets it through proxies: the bytes are raw, with no WebSocket frames (docs/previews.md).
    async fn connect(&self, protocol: &str) -> std::result::Result<Box<dyn Stream>, Option<u16>> {
        let url = format!(
            "{}/v1/previews/{}/tunnel?device={}",
            self.core.url, self.port, self.device
        );
        let mut request = self
            .direct
            .get(url)
            .header("Connection", "Upgrade")
            .header("Upgrade", protocol);
        for (name, value) in &self.core.headers {
            request = request.header(name, value);
        }
        let response = tokio::time::timeout(Duration::from_secs(10), request.send())
            .await
            .map_err(|_| None)?
            .map_err(|_| None)?;
        let status = response.status().as_u16();
        if status == 400 {
            return Err(Some(400));
        }
        self.down.store(status == 409, Ordering::SeqCst);
        if status != 101 {
            return Err(Some(status));
        }
        Ok(Box::new(response.upgrade().await.map_err(|_| None)?))
    }

    /// The browser-facing proxy answers on every loopback for this preview's generation.
    pub(super) async fn healthy(&self) -> bool {
        if !self.reachable() {
            return false;
        }
        for ip in &self.loopbacks {
            let check = async {
                let mut stream = TcpStream::connect(SocketAddr::new(*ip, self.local_port)).await?;
                let request = format!(
                    "HEAD / HTTP/1.1\r\nHost: {}\r\nAccept-Encoding: identity\r\n\r\n",
                    self.authority
                );
                stream.write_all(request.as_bytes()).await?;
                let (head, _) = read_head(&mut stream, Vec::new()).await?;
                Ok::<_, io::Error>(Head::parse(&head).is_some_and(|head| {
                    head.get("x-cloudroom-preview") == Some(self.generation.as_str())
                }))
            };
            if !tokio::time::timeout(10 * SECOND, check)
                .await
                .is_ok_and(|ok| ok.is_ok_and(|ok| ok))
            {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
pub(super) async fn test_proxy(
    socket_path: PathBuf,
    generation: &str,
) -> (Arc<Info>, Vec<JoinHandle<()>>) {
    let (listeners, local_port) = listen(0).await.unwrap();
    let core = Core {
        url: "http://127.0.0.1:9".into(),
        headers: Vec::new(),
        sandbox: false,
        thread: None,
        key: (String::new(), String::new()),
        config: Value::Null,
        connection: Value::Null,
    };
    let info = Arc::new(Info {
        core,
        port: 3000,
        generation: generation.into(),
        local_port,
        relay: false,
        authority: format!("p3000-test.localhost:{local_port}"),
        loopbacks: listeners
            .iter()
            .map(|listener| listener.local_addr().unwrap().ip())
            .collect(),
        socket_path,
        device: "test".into(),
        direct: reqwest::Client::new(),
        stopped: AtomicBool::new(false),
        down: AtomicBool::new(false),
    });
    let tasks = listeners
        .into_iter()
        .map(|listener| tokio::spawn(serve(listener, info.clone())))
        .collect();
    (info, tasks)
}

#[cfg(test)]
impl Info {
    pub(super) fn authority(&self) -> &str {
        &self.authority
    }
}
