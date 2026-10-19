use crate::{
    observability::{Observability, Signal, elapsed_ms},
    session::{self, Manager},
};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, MatchedPath, Path, Query, Request, State},
    http::{HeaderMap, StatusCode, Version, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio_stream::wrappers::ReceiverStream;

pub fn router(manager: Arc<Manager>, token: String) -> Router {
    Router::new()
        .merge(crate::preview::routes())
        .merge(crate::runtime::terminal::routes())
        .merge(crate::mac::routes())
        .merge(crate::secrets::routes())
        .merge(crate::session::thread::routes())
        .merge(crate::session::relay::routes())
        .route("/v1/health", get(health))
        .route("/v1/ready", get(ready))
        .route("/v1/capabilities", get(capabilities))
        .route("/v1/accounts/cursor", get(cursor_auth))
        .route("/v1/accounts/cursor/{action}", post(cursor_account))
        .route("/v1/accounts/claude", get(claude_auth))
        .route("/v1/accounts/claude/version", post(claude_version))
        .route("/v1/accounts/claude/{action}", post(claude_account))
        .route("/v1/accounts/pi", get(pi_auth))
        .route("/v1/accounts/pi/import", post(pi_import))
        .route("/v1/accounts/pi/setup", post(pi_setup))
        .route("/v1/accounts/pi/key", post(pi_key))
        .route("/v1/accounts/codex", get(codex_auth))
        .route("/v1/accounts/codex/login", post(codex_login))
        .route("/v1/accounts/codex/import", post(codex_import))
        .route("/v1/accounts/codex/switched", post(codex_switched))
        .route("/v1/accounts/codex/cancel", post(codex_cancel))
        .route("/v1/workspaces/{id}", get(workspace))
        .route("/v1/settings", get(crate::sync::settings))
        .route("/v1/sync", post(crate::sync::check_in))
        .route("/v1/sync/{id}", get(crate::sync::scan))
        .route(
            "/v1/sync/{id}/file",
            get(crate::sync::read)
                .put(crate::sync::apply)
                .layer(DefaultBodyLimit::disable()),
        )
        .route("/v1/dashboard", get(dashboard))
        .route("/v1/drain", post(drain))
        .route(
            "/v1/teleports",
            post(teleport_prepare).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route("/v1/teleports/check", post(teleport_check))
        .route("/v1/teleports/{id}", get(teleport_status))
        .route("/v1/teleports/{id}/activate", post(teleport_activate))
        .route("/v1/teleports/{id}/cancel", post(teleport_cancel))
        .route(
            "/v1/teleports/{id}/files/{index}",
            post(teleport_upload).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route("/v1/sessions", post(start).get(list_sessions))
        .route("/v1/sessions/{id}", get(status))
        .route("/v1/sessions/{id}/requests/{request}", get(request_status))
        .route("/v1/sessions/{id}/workspace", get(session_workspace))
        .route("/v1/sessions/{id}/recovery", get(recovery))
        .route("/v1/sessions/{id}/prompts", post(prompt))
        .route("/v1/sessions/{id}/edit", post(edit))
        .route("/v1/sessions/{id}/cancel", post(cancel))
        .route("/v1/sessions/{id}/reorder", post(reorder))
        .route("/v1/sessions/{id}/steer", post(steer))
        .route("/v1/sessions/{id}/compact", post(compact))
        .route("/v1/sessions/{id}/goal", post(goal))
        .route("/v1/sessions/{id}/rewind", post(rewind))
        .route(
            "/v1/sessions/{id}/attachments",
            post(attach).layer(DefaultBodyLimit::max(26 * 1024 * 1024)),
        )
        .route("/v1/sessions/{id}/interrupt", post(interrupt))
        .route("/v1/sessions/{id}/stop", post(stop))
        .route("/v1/sessions/{id}/sleep", post(sleep))
        .route("/v1/sessions/{id}/detach", post(detach))
        .route("/v1/sessions/{id}/resume", post(resume))
        .route("/v1/sessions/{id}/close", post(close))
        .route("/v1/sessions/{id}/events", get(events))
        .route("/v1/sessions/{id}/stream", get(stream))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(
            Arc::new(token),
            authenticate,
        ))
        .layer(middleware::from_fn_with_state(
            manager.observability.clone(),
            observe,
        ))
        .with_state(manager)
}

async fn cursor_auth(State(manager): State<Arc<Manager>>) -> Json<crate::runtime::auth::Status> {
    Json(manager.cursor_auth_status().await)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorAccountRequest {
    request_id: String,
    api_key: Option<String>,
}
async fn cursor_account(
    State(manager): State<Arc<Manager>>,
    Path(action): Path<String>,
    Json(input): Json<CursorAccountRequest>,
) -> Result<(StatusCode, Json<crate::runtime::auth::Status>)> {
    crate::workspace::valid_id(&input.request_id)
        .map_err(|_| session::Error::Conflict("invalid request ID"))?;
    if !matches!(action.as_str(), "login" | "cancel" | "key")
        || (action == "key") != input.api_key.is_some()
    {
        return Err(session::Error::Conflict("invalid Cursor account operation"));
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(
            manager
                .cursor_account(&action, input.request_id, input.api_key)
                .await?,
        ),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaudeAccountRequest {
    request_id: String,
    code: Option<String>,
    state: Option<String>,
    token: Option<String>,
    plan: Option<String>,
    api_key: Option<String>,
}
async fn claude_auth(State(manager): State<Arc<Manager>>) -> Json<crate::runtime::auth::Status> {
    Json(manager.claude_auth_status().await)
}
async fn claude_account(
    State(manager): State<Arc<Manager>>,
    Path(action): Path<String>,
    Json(input): Json<ClaudeAccountRequest>,
) -> Result<(StatusCode, Json<crate::runtime::auth::Status>)> {
    crate::workspace::valid_id(&input.request_id)
        .map_err(|_| session::Error::Conflict("invalid request ID"))?;
    let valid = |value: &Option<String>, max: usize| {
        value.as_ref().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= max
                && s.bytes().all(|c| c.is_ascii_graphic())
                && !s.starts_with("sk-ant-")
        })
    };
    let secret = |value: &Option<String>, prefix: &str| {
        value.as_ref().is_some_and(|s| {
            s.starts_with(prefix)
                && s.len() <= 1024
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
    };
    let token = secret(&input.token, "sk-ant-oat");
    let key = input
        .api_key
        .as_deref()
        .is_some_and(crate::runtime::claude_login::is_api_key);
    if !matches!(
        action.as_str(),
        "login" | "cancel" | "complete" | "token" | "key"
    ) || (action == "complete" && (!valid(&input.code, 2048) || !valid(&input.state, 512)))
        || (action != "complete" && (input.code.is_some() || input.state.is_some()))
        || (action == "token") != token
        || (action != "token" && input.token.is_some())
        || (action == "key") != key
        || (action != "key" && input.api_key.is_some())
        || (action != "token" && input.plan.is_some())
        || input.plan.as_ref().is_some_and(|s| {
            s.is_empty() || s.len() > 32 || !s.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
        })
    {
        return Err(session::Error::Conflict("invalid Claude sign-in request"));
    }
    let (code, state) = match action.as_str() {
        "token" => (input.token, input.plan),
        "key" => (input.api_key, None),
        _ => (input.code, input.state),
    };
    Ok((
        StatusCode::ACCEPTED,
        Json(
            manager
                .claude_account(&action, input.request_id, code, state)
                .await?,
        ),
    ))
}

fn pi_error(error: std::io::Error) -> session::Error {
    if error.kind() == std::io::ErrorKind::InvalidInput {
        session::Error::Conflict("invalid Pi login")
    } else {
        error.into()
    }
}
async fn pi_auth(State(manager): State<Arc<Manager>>) -> Result<Json<Value>> {
    let result = crate::runtime::pi_auth::providers(&manager.config, &manager.storage).await;
    Ok(Json(result.map_err(pi_error)?))
}
async fn pi_import(
    State(manager): State<Arc<Manager>>,
    Json(credentials): Json<Value>,
) -> Result<Json<Value>> {
    if manager.is_stopping() {
        return Err(session::Error::Conflict("service is stopping"));
    }
    let result =
        crate::runtime::pi_auth::import(&manager.config, &manager.storage, credentials).await;
    Ok(Json(result.map_err(pi_error)?))
}
/// Copies the Mac's custom Pi providers and installs its packages before answering, so Pi
/// starts with the providers they add. A dropped request leaves the install running.
async fn pi_setup(
    State(manager): State<Arc<Manager>>,
    Json(setup): Json<Value>,
) -> Result<(StatusCode, Json<Value>)> {
    if manager.is_stopping() {
        return Err(session::Error::Conflict("service is stopping"));
    }
    let filtered = crate::runtime::pi_auth::filtered(&setup);
    let (result, missing) =
        crate::runtime::pi_auth::setup(&manager.config, &manager.storage, setup)
            .await
            .map_err(pi_error)?;
    if !missing.is_empty() || !filtered.is_empty() {
        let manager = manager.clone();
        let _ = tokio::spawn(async move {
            crate::runtime::pi_auth::install(&manager.config, &manager.storage, missing, filtered)
                .await
        })
        .await;
    }
    Ok((StatusCode::ACCEPTED, Json(result)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PiKey {
    provider: String,
    key: String,
}
async fn pi_key(
    State(manager): State<Arc<Manager>>,
    Json(input): Json<PiKey>,
) -> Result<Json<Value>> {
    if manager.is_stopping() {
        return Err(session::Error::Conflict("service is stopping"));
    }
    let result = crate::runtime::pi_auth::set_key(
        &manager.config,
        &manager.storage,
        input.provider,
        input.key,
    )
    .await;
    Ok(Json(result.map_err(pi_error)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Drain {
    hold: bool,
}
/// Sandbox hosts call this before stopping the machine (see session::sleep).
async fn drain(State(manager): State<Arc<Manager>>, Json(input): Json<Drain>) -> Json<Value> {
    let mut answer = manager.drain(input.hold);
    // The sandbox stops next: save what's pending first. Anything left stays in the journal for the next wake.
    if answer["drained"] == true {
        answer["pending_records"] = json!(
            manager
                .flush_history(std::time::Duration::from_secs(8))
                .await
        );
    }
    Json(answer)
}

async fn codex_auth(State(manager): State<Arc<Manager>>) -> Json<crate::runtime::auth::Status> {
    Json(manager.codex_auth_status().await)
}
async fn codex_login(
    State(manager): State<Arc<Manager>>,
    Json(input): Json<RequestId>,
) -> Result<(StatusCode, Json<crate::runtime::auth::Status>)> {
    crate::workspace::valid_id(&input.request_id)
        .map_err(|_| session::Error::Conflict("invalid request ID"))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(manager.codex_login(input.request_id).await?),
    ))
}
async fn codex_import(
    State(manager): State<Arc<Manager>>,
    Json(credentials): Json<Value>,
) -> Result<Json<crate::runtime::auth::Status>> {
    Ok(Json(manager.import_codex_login(credentials).await?))
}
async fn codex_switched(State(manager): State<Arc<Manager>>) -> Json<Value> {
    let (status, continued) = manager.codex_switched().await;
    Json(json!({"account":status,"continued":continued}))
}
async fn codex_cancel(
    State(manager): State<Arc<Manager>>,
    Json(input): Json<RequestId>,
) -> (StatusCode, Json<crate::runtime::auth::Status>) {
    (
        StatusCode::ACCEPTED,
        Json(manager.cancel_codex_login(&input.request_id).await),
    )
}

async fn teleport_prepare(
    State(manager): State<Arc<Manager>>,
    Json(manifest): Json<session::teleport::Manifest>,
) -> Result<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::ACCEPTED,
        Json(manager.teleport_prepare(manifest).await?),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaudeVersion {
    version: String,
}
async fn claude_version(
    State(manager): State<Arc<Manager>>,
    Json(input): Json<ClaudeVersion>,
) -> Result<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::ACCEPTED,
        Json(manager.match_claude_version(input.version).await?),
    ))
}
async fn teleport_check(
    State(manager): State<Arc<Manager>>,
    Json(check): Json<session::teleport::Check>,
) -> (StatusCode, Json<Value>) {
    (
        StatusCode::ACCEPTED,
        Json(manager.teleport_check(check).await),
    )
}
async fn teleport_status(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(manager.teleport_status(&id).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TeleportActivation {
    retry_request_id: Option<String>,
}
async fn teleport_activate(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<TeleportActivation>,
) -> Result<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::ACCEPTED,
        Json(
            manager
                .teleport_activate(&id, body.retry_request_id)
                .await?,
        ),
    ))
}
async fn teleport_cancel(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::ACCEPTED,
        Json(manager.teleport_cancel(&id).await?),
    ))
}
#[derive(Deserialize)]
struct TeleportOffset {
    offset: u64,
    sha256: String,
    size: Option<u64>,
}
async fn teleport_upload(
    State(manager): State<Arc<Manager>>,
    path: std::result::Result<Path<(String, String)>, axum::extract::rejection::PathRejection>,
    query: std::result::Result<Query<TeleportOffset>, axum::extract::rejection::QueryRejection>,
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    // A malformed path or query, or an oversized part, gets the JSON error shape, not the extractors' plain text.
    let parsed = match (path, query) {
        (Ok(Path((id, index))), Ok(Query(query))) => {
            index.parse::<usize>().ok().map(|index| (id, index, query))
        }
        _ => None,
    };
    let Some((id, index, query)) = parsed else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid teleport file","code":"teleport_rejected"})),
        )
            .into_response();
    };
    let body = match body {
        Ok(body) => body,
        Err(rejection) if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(
                    json!({"error":"teleport file part exceeds 1 MiB","code":"teleport_rejected"}),
                ),
            )
                .into_response();
        }
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid teleport file","code":"teleport_rejected"})),
            )
                .into_response();
        }
    };
    match manager
        .teleport_upload(&id, index, query.offset, query.sha256, query.size, body)
        .await
    {
        Ok(view) => (StatusCode::ACCEPTED, Json(view)).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn observe(
    State(diagnostics): State<Observability>,
    request: Request,
    next: Next,
) -> Response {
    let started = Instant::now();
    let version = request.version();
    let method = match request.method().as_str() {
        "GET" => "GET",
        "POST" => "POST",
        _ => "other",
    };
    // Route templates only: arbitrary URLs, query strings and headers may contain secrets.
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str())
        .unwrap_or("unmatched")
        .to_owned();
    let mut response = next.run(request).await;
    // The hosting gateway retains idle upstream sockets. Keep SSE streams and upgraded tunnels, not completed requests.
    if matches!(version, Version::HTTP_10 | Version::HTTP_11)
        && response.status() != StatusCode::SWITCHING_PROTOCOLS
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| value.as_bytes().starts_with(b"text/event-stream"))
    {
        response
            .headers_mut()
            .insert(header::CONNECTION, "close".parse().unwrap());
    }
    let id = diagnostics.record(Signal::Api {
        method,
        route,
        status: response.status().as_u16(),
        duration_ms: elapsed_ms(started),
    });
    response.headers_mut().insert(
        "x-cloudroom-diagnostic-id",
        id.parse().expect("generated diagnostic ID"),
    );
    response
}

async fn authenticate(State(token): State<Arc<String>>, request: Request, next: Next) -> Response {
    // Some sandbox proxies replace Authorization with their own login, so the token may also arrive in X-Cloudroom-Token.
    let headers = request.headers();
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    let custom = headers
        .get("x-cloudroom-token")
        .and_then(|h| h.to_str().ok());
    let authorized = [bearer, custom]
        .into_iter()
        .flatten()
        .any(|supplied| same_token(supplied, token.as_str()));
    let mut response = if authorized {
        next.run(request).await
    } else {
        (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            Json(json!({"error":"unauthorized"})),
        )
            .into_response()
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

/// Compares every byte, so response timing does not reveal how much of the token matched.
fn same_token(supplied: &str, expected: &str) -> bool {
    let (supplied, expected) = (supplied.as_bytes(), expected.as_bytes());
    let difference = supplied
        .iter()
        .zip(expected)
        .fold(0, |difference, (a, b)| difference | (a ^ b));
    supplied.len() == expected.len() && std::hint::black_box(difference) == 0
}

impl IntoResponse for session::Error {
    fn into_response(self) -> Response {
        let (status, error) = match self {
            Self::NotFound => (StatusCode::NOT_FOUND, "session not found"),
            Self::RequestNotFound => (StatusCode::NOT_FOUND, "request not found"),
            Self::Conflict(message) => (StatusCode::CONFLICT, message),
            Self::Storage(detail) => {
                eprintln!("storage unavailable: {detail}");
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({
                        "error": format!("storage unavailable ({detail}); retry with the same request_id"),
                        "code": "storage_unavailable",
                    })),
                )
                    .into_response();
            }
        };
        let code = conflict_code(error);
        (status, Json(json!({"error":error,"code":code}))).into_response()
    }
}

/// The code a rejected session command answers with (api.md: branch on `code`). The session routes and the
/// relay share it, so a refused relay request carries the same code as the same refusal on `/prompts`.
pub(crate) fn conflict_code(error: &str) -> &'static str {
    match error {
        "invalid model" => "invalid_model",
        "invalid provider" | "provider selection requires Pi" => "invalid_provider",
        "invalid reasoning effort" => "invalid_reasoning_effort",
        "invalid service tier" => "invalid_service_tier",
        "invalid teleport manifest"
        | "invalid teleport file"
        | "invalid transfer ID"
        | "invalid upload offset"
        | "overlapping upload"
        | "upload content changed"
        | "upload checksum changed"
        | "teleport file validation failed"
        | "session text is still uploading"
        | "saved transfer requires recovery"
        | "native conversation already belongs to a cloud session"
        | "session ID belongs to another session" => "teleport_rejected",
        "transfer cancelled" => "teleport_cancelled",
        "cloud execution already owns this transfer; use Stop" => "teleport_running",
        "Cloud folder permission denied" => "attachment_permission_denied",
        "attachment upload failed" | "attachments must be an array" => "invalid_attachment",
        "image exceeds the 10 MiB limit" | "file exceeds the 25 MiB limit" => {
            "attachment_too_large"
        }
        "request_id already has different content"
        | "session already exists"
        | "saved session has no matching receipt" => "request_conflict",
        "agent setup is incomplete" | "harness is not configured" => "harness_not_configured",
        "invalid workspace" | "workspace mapping unavailable" => "invalid_workspace",
        "storage unsafe; new execution is blocked"
        | "storage unsafe; uploads are blocked"
        | "new execution is paused; try again shortly"
        | "workload is paused for storage; close it or wait for recovery" => "storage_blocked",
        "wait for the pending close or interrupt"
        | "wait for the pending rewind"
        | "session is still starting"
        | "the agent is starting; try again in a few seconds"
        | "the turn is still starting; try the interrupt again in a moment"
        | "wait for compaction"
        | "compaction is already running"
        | "harness is not ready for compaction"
        | "harness is not ready to rewind"
        | "wait for child agents before editing a message"
        | "wait for the active turn to finish before editing a sent message"
        | "the source agent is busy; fork from an earlier message or try again shortly"
        | "too many uploads in progress; try again" => "session_busy",
        "service is stopping" => "service_stopping",
        "service is draining" => "service_draining",
        "this thread was asleep and is waking up; try again in a few seconds" => "session_waking",
        "model catalog unavailable" => "model_catalog_unavailable",
        "connect Codex before starting cloud work" => "codex_auth_required",
        "connect Claude Code before starting cloud work" => "claude_auth_required",
        "Claude account could not be verified" => "claude_auth_unavailable",
        "Codex usage limit reached" => "codex_usage_limit",
        "Codex account could not be verified" => "codex_auth_unavailable",
        "connect Cursor before starting cloud work" => "cursor_auth_required",
        "Cursor account could not be verified" => "cursor_auth_unavailable",
        "close Cursor sessions before changing the cloud login" => "cursor_auth_busy",
        "finish active Codex work before signing in" => "codex_auth_busy",
        "request not found" => "request_not_found",
        _ => "request_rejected",
    }
}

type Result<T> = std::result::Result<T, session::Error>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestId {
    request_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Start {
    request_id: String,
    harness: Option<crate::runtime::Kind>,
    model: Option<String>,
    reasoning: Option<String>,
    workspace: Option<String>,
    provider: Option<String>,
    workspace_name: Option<String>,
    command_guard_enabled: Option<bool>,
    strip_ai_co_authors: Option<bool>,
    system_prompt: Option<String>,
    /// Starts a child thread in this parent's folder; it inherits the parent's settings.
    parent_session: Option<String>,
    /// The app's parent thread in another sandbox, which this session reports its turns to (relay.rs).
    parent_thread: Option<String>,
    prompt: Option<String>,
    title: Option<String>,
    /// Starts a side chat on a copy of this session's conversation; it inherits the source's settings.
    fork: Option<session::ForkFrom>,
}

async fn workspace(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match manager.workspaces.get(&id) {
        Ok(Some(workspace)) => (StatusCode::OK, Json(json!(workspace))),
        // The same code a missing session carries: no workspace-specific code is documented.
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"workspace not found","code":"request_rejected"})),
        ),
        Err(error) => {
            let code = workspace_refusal(&error);
            (
                StatusCode::CONFLICT,
                Json(json!({"error":format!("workspace unavailable: {error}"),"code":code})),
            )
        }
    }
}

/// A damaged or invalid registry entry stays invalid until someone repairs it, so it is not temporary. Any other
/// failure (I/O, filesystem) may clear.
fn workspace_refusal(error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    if matches!(
        error.kind(),
        ErrorKind::InvalidData | ErrorKind::UnexpectedEof
    ) {
        return "invalid_workspace";
    }
    match error.to_string().as_str() {
        "Invalid workspace ID"
        | "Invalid workspace path"
        | "Invalid workspace parent"
        | "Invalid workspace directory"
        | "Invalid workspace root"
        | "Workspace identity mismatch"
        | "Workspace parent missing" => "invalid_workspace",
        _ => "workspace_unavailable",
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prompt {
    request_id: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    content: Option<Value>,
    #[serde(default)]
    attachments: Option<Value>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    service_tier: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Edit {
    request_id: String,
    target_request_id: String,
    expected_revision: u64,
    #[serde(default)]
    text: String,
    #[serde(default)]
    content: Option<Value>,
    #[serde(default)]
    attachments: Option<Value>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    service_tier: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    request_id: String,
    target_request_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reorder {
    request_id: String,
    order: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Steer {
    request_id: String,
    target_request_id: String,
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rewind {
    request_id: String,
    replacement: Option<Prompt>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    last_turn_id: Option<String>,
    #[serde(default)]
    fork: bool,
}
#[derive(Deserialize)]
struct AttachQuery {
    request_id: String,
    name: String,
    kind: String,
    /// Large files arrive in parts (`upload_parts`): this part's byte offset and the whole file's size.
    offset: Option<usize>,
    total: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Interrupt {
    request_id: String,
    target_request_id: String,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    #[serde(default)]
    after: u64,
}

fn key(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(session::Error::Conflict(
            "request_id must be 1-64 ASCII letters, digits, underscores or hyphens",
        ));
    }
    Ok(())
}
fn cursor(after: u64) -> Result<()> {
    if after > i64::MAX as u64 {
        return Err(session::Error::Conflict("invalid replay cursor"));
    }
    Ok(())
}

async fn dashboard(State(manager): State<Arc<Manager>>) -> Json<Value> {
    Json(manager.dashboard())
}

async fn list_sessions(State(manager): State<Arc<Manager>>) -> Json<Value> {
    Json(manager.list_sessions())
}

async fn ready(State(manager): State<Arc<Manager>>) -> impl IntoResponse {
    let ready = manager.ready().await;
    (
        if ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({"ready":ready})),
    )
}

async fn capabilities(State(manager): State<Arc<Manager>>) -> Json<Value> {
    Json(manager.capabilities().await)
}

async fn stop(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<RequestId>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    let receipt = manager.command(&id, body.request_id, "stop", json!({}))?;
    Ok(accepted(&manager, &id, receipt))
}

async fn resume(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<RequestId>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    let receipt = manager.command(&id, body.request_id, "resume", json!({}))?;
    Ok(accepted(&manager, &id, receipt))
}

async fn sleep(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<RequestId>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    let receipt = manager.command(&id, body.request_id, "sleep", json!({}))?;
    Ok(accepted(&manager, &id, receipt))
}

async fn detach(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<Value>)> {
    manager.detach(&id)?;
    Ok((StatusCode::ACCEPTED, Json(json!({"detached":true}))))
}

async fn health(State(manager): State<Arc<Manager>>) -> Json<Value> {
    Json(json!({"status":"ready","saving":manager.saving(),"storage":manager.storage.snapshot()}))
}
async fn start(
    State(manager): State<Arc<Manager>>,
    Json(body): Json<Start>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    manager.mac.expect();
    if body.provider.as_ref().is_some_and(|p| {
        p.is_empty()
            || p.chars()
                .any(|c| c.is_control() || c.is_whitespace() || c == '/')
    }) {
        return Err(session::Error::Conflict("invalid provider"));
    }
    if body
        .model
        .as_ref()
        .is_some_and(|m| m.is_empty() || m.len() > 256 || m.chars().any(char::is_control))
    {
        return Err(session::Error::Conflict("invalid model"));
    }
    if body
        .reasoning
        .as_deref()
        .is_some_and(|r| r.is_empty() || r.len() > 64 || !r.bytes().all(|b| b.is_ascii_lowercase()))
    {
        return Err(session::Error::Conflict("invalid reasoning effort"));
    }
    if body
        .system_prompt
        .as_ref()
        .is_some_and(|p| p.trim().is_empty() || p.len() > 32768 || p.contains('\0'))
    {
        return Err(session::Error::Conflict("invalid system prompt"));
    }
    if let Some(fork) = body.fork {
        if body.parent_session.is_some()
            || body.prompt.is_some()
            || body.title.is_some()
            || body.model.is_some()
            || body.reasoning.is_some()
            || body.workspace.is_some()
            || body.workspace_name.is_some()
            || body.provider.is_some()
            || body.command_guard_enabled.is_some()
            || body.strip_ai_co_authors.is_some()
            || body.system_prompt.is_some()
            || body.parent_thread.is_some()
        {
            return Err(session::Error::Conflict(
                "a side chat takes only harness and fork",
            ));
        }
        let (id, receipt) = manager.fork(body.request_id, body.harness, fork).await?;
        return Ok(accepted(&manager, &id, receipt));
    }
    if let Some(parent) = body.parent_session {
        let prompt = body
            .prompt
            .filter(|p| !p.trim().is_empty() && p.len() <= 32768);
        let title = body.title.map(|t| t.trim().to_owned());
        if body.workspace.is_some()
            || body.workspace_name.is_some()
            || body.provider.is_some()
            || body.command_guard_enabled.is_some()
            || body.strip_ai_co_authors.is_some()
            || body.system_prompt.is_some()
            || body.parent_thread.is_some()
            || title.as_ref().is_some_and(|t| {
                t.is_empty() || t.chars().count() > 200 || t.chars().any(char::is_control)
            })
        {
            return Err(session::Error::Conflict(
                "a child takes only harness, model, reasoning, title and prompt",
            ));
        }
        let prompt = prompt.ok_or(session::Error::Conflict(
            "prompt must contain 1-32768 bytes of text",
        ))?;
        let spawn = session::Spawn {
            harness: body.harness,
            model: body.model,
            reasoning: body.reasoning,
            title,
            prompt,
            service_tier: None,
        };
        let (id, receipt) = manager
            .spawn_child(&parent, &body.request_id, spawn)
            .await?;
        return Ok(accepted(&manager, &id, receipt));
    }
    if body.prompt.is_some() || body.title.is_some() {
        return Err(session::Error::Conflict(
            "prompt and title require parent_session",
        ));
    }
    let (id, receipt) = manager
        .start(
            body.request_id,
            body.harness,
            body.model,
            body.reasoning,
            (body.workspace, body.workspace_name),
            (
                body.provider,
                body.command_guard_enabled,
                body.strip_ai_co_authors,
                body.system_prompt,
                body.parent_thread,
            ),
        )
        .await?;
    Ok(accepted(&manager, &id, receipt))
}

fn accepted(manager: &Manager, id: &str, receipt: session::Receipt) -> (StatusCode, Json<Value>) {
    (
        StatusCode::ACCEPTED,
        Json(json!({"session_id":id,"receipt":receipt,"saving":manager.saving()})),
    )
}

async fn close(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<RequestId>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    let receipt = manager.command(&id, body.request_id, "close", json!({}))?;
    Ok(accepted(&manager, &id, receipt))
}

async fn status(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    Ok(Json(
        json!({"session":manager.session(&id).await?,"saving":manager.saving()}),
    ))
}
/// One request's state and whether its thread is archived, without the session's growing history.
/// Cloud automations (ADR 0212) read it before each run: wait, count a failure, or stop.
async fn request_status(
    State(manager): State<Arc<Manager>>,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<Value>> {
    key(&request)?;
    let session = manager.session(&id).await?;
    let receipt = session.receipts.get(&request);
    // A cancel now writes `cancelled` onto the prompt's own receipt. A receipt journaled before that, or one whose
    // cancel a restart cut short, still reads `accepted` while the cancel is accepted or completed; this derives its state.
    let cancelled = !session.queue.contains(&request)
        && session.receipts.values().any(|r| {
            r.command == "cancel"
                && matches!(r.state.as_str(), "accepted" | "completed")
                && r.input["target_request_id"] == request.as_str()
        });
    Ok(Json(json!({
        "archived": session.archived,
        "state": receipt.map(|r| if cancelled && r.state == "accepted" { "cancelled" } else { r.state.as_str() }),
        "error": receipt.and_then(|r| r.error.as_ref()),
    })))
}
async fn recovery(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let session = manager.session(&id).await?;
    Ok(Json(manager.recovery_check(&session)))
}
async fn session_workspace(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let session = manager.session(&id).await?;
    let workspace = session.workspace.ok_or(session::Error::NotFound)?;
    Ok(Json(manager.workspaces.checkout(&workspace).await?))
}

fn prompt_input(
    text: String,
    content: Option<Value>,
    attachments: Option<Value>,
    reasoning: Option<String>,
    service_tier: Option<String>,
) -> Result<Value> {
    let has_attachments = attachments
        .as_ref()
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    if (text.trim().is_empty() && !has_attachments) || text.len() > 32768 {
        return Err(session::Error::Conflict(
            "prompt must contain 1-32768 bytes of text",
        ));
    }
    let mut input = json!({"text": text});
    if let Some(content) = content {
        input["content"] = content;
    }
    if let Some(attachments) = attachments {
        input["attachments"] = attachments;
    }
    if let Some(reasoning) = reasoning {
        input["reasoning"] = json!(reasoning);
    }
    if let Some(service_tier) = service_tier {
        input["service_tier"] = json!(service_tier);
    }
    Ok(input)
}

/// A malformed effort is refused before the catalog is consulted, so a catalog outage cannot mask it.
/// Checked for a new request only: an accepted retry answers its receipt whatever it sends now.
fn attachments_array(attachments: Option<&Value>) -> std::result::Result<(), session::Error> {
    if attachments.is_some_and(|value| !value.is_array()) {
        return Err(session::Error::Conflict("attachments must be an array"));
    }
    Ok(())
}

fn reasoning_syntax(level: Option<&str>) -> std::result::Result<(), session::Error> {
    if level.is_some_and(|level| {
        level.is_empty() || level.len() > 64 || !level.bytes().all(|b| b.is_ascii_lowercase())
    }) {
        return Err(session::Error::Conflict("invalid reasoning effort"));
    }
    Ok(())
}

async fn prompt(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<Prompt>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    // An accepted retry must not depend on the model catalog still being available.
    let known = manager.known_request(&id, &body.request_id);
    if !known {
        attachments_array(body.attachments.as_ref())?;
    }
    let input = prompt_input(
        body.text,
        body.content,
        body.attachments,
        body.reasoning.clone(),
        body.service_tier.clone(),
    )?;
    if !known {
        reasoning_syntax(body.reasoning.as_deref())?;
        manager
            .check_prompt_reasoning(&id, body.reasoning.as_deref())
            .await?;
        manager.check_prompt_service_tier(&id, body.service_tier.as_deref())?;
    }
    let receipt = manager.command(&id, body.request_id, "prompt", input)?;
    Ok(accepted(&manager, &id, receipt))
}

async fn edit(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<Edit>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    key(&body.target_request_id)?;
    let known = manager.known_request(&id, &body.request_id);
    if !known {
        attachments_array(body.attachments.as_ref())?;
    }
    let mut input = prompt_input(
        body.text,
        body.content,
        body.attachments,
        body.reasoning.clone(),
        body.service_tier.clone(),
    )?;
    input["target_request_id"] = json!(body.target_request_id);
    input["expected_revision"] = json!(body.expected_revision);
    if !known {
        reasoning_syntax(body.reasoning.as_deref())?;
        manager
            .check_prompt_reasoning(&id, body.reasoning.as_deref())
            .await?;
        manager.check_prompt_service_tier(&id, body.service_tier.as_deref())?;
    }
    let receipt = manager.command(&id, body.request_id, "edit", input)?;
    Ok(accepted(&manager, &id, receipt))
}

async fn cancel(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<Target>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    key(&body.target_request_id)?;
    let receipt = manager.command(
        &id,
        body.request_id,
        "cancel",
        json!({"target_request_id":body.target_request_id}),
    )?;
    Ok(accepted(&manager, &id, receipt))
}

async fn reorder(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<Reorder>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    for target in &body.order {
        key(target)?;
    }
    let receipt = manager.command(&id, body.request_id, "reorder", json!({"order":body.order}))?;
    Ok(accepted(&manager, &id, receipt))
}

async fn steer(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<Steer>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    key(&body.target_request_id)?;
    if body.text.trim().is_empty() || body.text.len() > 32768 {
        return Err(session::Error::Conflict(
            "prompt must contain 1-32768 bytes of text",
        ));
    }
    let receipt = manager.command(
        &id,
        body.request_id,
        "steer",
        json!({"target_request_id":body.target_request_id,"text":body.text}),
    )?;
    Ok(accepted(&manager, &id, receipt))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Goal {
    request_id: String,
    status: Option<String>,
    objective: Option<String>,
    #[serde(default)]
    clear: bool,
}

/// The user's goal control: pause, resume, replace the objective, or clear.
async fn goal(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<Goal>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    if body
        .status
        .as_deref()
        .is_some_and(|status| !matches!(status, "active" | "paused"))
        || body
            .objective
            .as_ref()
            .is_some_and(|text| text.trim().is_empty() || text.len() > 4000)
        || (body.clear == (body.status.is_some() || body.objective.is_some()))
    {
        return Err(session::Error::Conflict(
            "goal needs clear, or an active/paused status and/or an objective of 1-4000 bytes",
        ));
    }
    let input = json!({"status":body.status,"objective":body.objective,"clear":body.clear});
    let receipt = manager.command(&id, body.request_id, "goal", input)?;
    Ok(accepted(&manager, &id, receipt))
}

async fn compact(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<RequestId>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    let receipt = manager.command(&id, body.request_id, "compact", json!({}))?;
    Ok(accepted(&manager, &id, receipt))
}

async fn rewind(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<Rewind>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    let mut input = json!({});
    if let Some(before) = body.before {
        input["before"] = json!(before);
    }
    if let Some(last_turn_id) = body.last_turn_id {
        input["last_turn_id"] = json!(last_turn_id);
    }
    if body.fork {
        input["fork"] = json!(true);
    }
    if let Some(prompt) = body.replacement {
        key(&prompt.request_id)?;
        let known = manager.known_request(&id, &body.request_id);
        if !known {
            attachments_array(prompt.attachments.as_ref())?;
        }
        let payload = prompt_input(
            prompt.text,
            prompt.content,
            prompt.attachments,
            prompt.reasoning.clone(),
            prompt.service_tier.clone(),
        )?;
        if !known {
            reasoning_syntax(prompt.reasoning.as_deref())?;
            manager
                .check_prompt_reasoning(&id, prompt.reasoning.as_deref())
                .await?;
            manager.check_prompt_service_tier(&id, prompt.service_tier.as_deref())?;
        }
        input["replacement"] = json!({"request_id":prompt.request_id,"input":payload});
    }
    let receipt = manager.command(&id, body.request_id, "rewind", input)?;
    Ok(accepted(&manager, &id, receipt))
}

async fn attach(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(query): Query<AttachQuery>,
    body: Body,
) -> Result<impl IntoResponse> {
    key(&query.request_id)?;
    if query.offset.is_some() != query.total.is_some() {
        return Err(session::Error::Conflict(
            "offset and total must be sent together",
        ));
    }
    // A part is read before any reply, so a retried last part gets its receipt instead of a reset connection.
    let (body, part) = match query.total {
        Some(_) => match axum::body::to_bytes(body, PART_BYTES).await {
            Ok(part) => (Body::empty(), Some(part)),
            Err(_) => {
                // An unknown session answers 404 whatever the size of its part.
                manager.session(&id).await?;
                return Err(session::Error::Conflict("upload part exceeds 8 MiB"));
            }
        },
        None => (body, None),
    };
    if let Some(receipt) = manager.receipt(&id, &query.request_id) {
        if receipt.command != "attach" {
            return Err(session::Error::Conflict(
                "request_id already has different content",
            ));
        }
        let (offset, bytes) = match part {
            Some(part) => (query.offset.unwrap_or(0), part),
            None => (
                0,
                axum::body::to_bytes(body, 25 << 20)
                    .await
                    .map_err(|_| session::Error::Conflict("file exceeds the 25 MiB limit"))?,
            ),
        };
        let matches = stored_matches(&receipt.input, &query, offset, &bytes)
            .await
            .map_err(|error| session::Error::Storage(error.to_string()))?;
        if !matches {
            return Err(session::Error::Conflict(
                "request_id already has different content",
            ));
        }
        return Ok(accepted(&manager, &id, receipt));
    }
    let session = manager.session(&id).await?;
    let workspace = session
        .workspace
        .ok_or(session::Error::Conflict("invalid workspace"))?;
    if workspace.id != "legacy" && manager.workspaces.get(&workspace.id)?.is_none() {
        return Err(session::Error::Conflict("workspace mapping unavailable"));
    }
    // The same refusals the session gives an attach, checked before the file is written, so a refused upload
    // does not write bytes that the discard below must then remove.
    if session.rewind_request.is_some() {
        return Err(session::Error::Conflict("wait for the pending rewind"));
    }
    if manager.close_pending(&id) {
        return Err(session::Error::Conflict(
            "wait for the pending close or interrupt",
        ));
    }
    if matches!(
        session.state.as_str(),
        "closed" | "process_lost" | "failed" | "saved_history_only"
    ) {
        return Err(session::Error::Conflict(
            "process unavailable; history does not restore execution",
        ));
    }
    if !manager.recording_available() {
        return Err(session::Error::Storage(
            "session journal is not writable".into(),
        ));
    }
    if manager.is_stopping() || manager.storage.blocks() {
        return Err(session::Error::Conflict(
            "storage unsafe; uploads are blocked",
        ));
    }
    let key = format!("{id}/{}", query.request_id);
    // Bytes a completing part added to its partial; dropped again if the file is refused.
    let mut before_part = None;
    let body = match (query.offset, query.total, part) {
        (None, None, _) => body,
        (Some(offset), Some(total), Some(part)) => {
            // Checked before any part is buffered, so a bad name fails on its first part.
            if !matches!(query.kind.as_str(), "image" | "file")
                || !crate::workspace::valid_attachment_name(&query.name)
            {
                return Err(session::Error::Conflict("attachment upload failed"));
            }
            let limit = if query.kind == "image" {
                10 << 20
            } else {
                25 << 20
            };
            if total > limit {
                return Err(session::Error::Conflict(if query.kind == "image" {
                    "image exceeds the 10 MiB limit"
                } else {
                    "file exceeds the 25 MiB limit"
                }));
            }
            match attach_part(&key, &query.name, &query.kind, offset, total, &part)
                .map_err(session::Error::Conflict)?
            {
                Progress::Complete { whole, before } => {
                    before_part = Some(before);
                    Body::from(whole)
                }
                Progress::Received(received) => {
                    return Ok((StatusCode::ACCEPTED, Json(json!({ "received": received }))));
                }
            }
        }
        _ => {
            return Err(session::Error::Conflict(
                "offset and total must be sent together",
            ));
        }
    };
    let written = manager
        .workspaces
        .attach(
            &workspace,
            &id,
            &query.request_id,
            &query.name,
            &query.kind,
            body,
            &manager.storage,
        )
        .await
        .map_err(|error| {
            if let Some(before) = before_part {
                truncate_part(&key, before);
            }
            eprintln!(
                "attachment upload failed: session={id} request={} kind={:?} errno={:?}: {error}",
                query.request_id,
                error.kind(),
                error.raw_os_error()
            );
            session::Error::Conflict(match error.kind() {
                _ if error.to_string() == crate::workspace::CONTENT_CONFLICT => {
                    crate::workspace::CONTENT_CONFLICT
                }
                std::io::ErrorKind::WouldBlock => "storage unsafe; uploads are blocked",
                std::io::ErrorKind::PermissionDenied => "Cloud folder permission denied",
                std::io::ErrorKind::FileTooLarge if query.kind == "image" => {
                    "image exceeds the 10 MiB limit"
                }
                std::io::ErrorKind::FileTooLarge => "file exceeds the 25 MiB limit",
                _ => "attachment upload failed",
            })
        })?;
    let receipt = match manager.command(&id, query.request_id.clone(), "attach", written) {
        Ok(receipt) => receipt,
        Err(error) => {
            // The session refused the file, so it must not stay in the repository. A concurrent request that won
            // with this request ID and name already owns the same path, so its file stays.
            let owned_by_winner = manager
                .receipt(&id, &query.request_id)
                .is_some_and(|receipt| {
                    receipt.command == "attach"
                        && receipt.input["name"].as_str() == Some(query.name.as_str())
                });
            if !owned_by_winner
                && let Err(discard) = manager
                    .workspaces
                    .discard_attachment(
                        &workspace,
                        &id,
                        &query.request_id,
                        &query.name,
                        &manager.storage,
                    )
                    .await
            {
                eprintln!(
                    "refused attachment not removed: session={id} request={}: {discard}",
                    query.request_id
                );
            }
            return Err(error);
        }
    };
    PARTS.lock().unwrap().remove(&key);
    Ok(accepted(&manager, &id, receipt))
}

/// True when a retry repeats the request that wrote the receipt. The repository file is never read back: the agent
/// may have edited, moved or replaced it. A whole-body retry compares the digest recorded at write time; a
/// receipt written before that has only name, kind and size. A part retry compares name, kind, total and range,
/// since the bytes of a completed upload are no longer held.
async fn stored_matches(
    input: &Value,
    query: &AttachQuery,
    offset: usize,
    bytes: &[u8],
) -> std::io::Result<bool> {
    if input["name"].as_str() != Some(query.name.as_str())
        || input["kind"].as_str() != Some(query.kind.as_str())
    {
        return Ok(false);
    }
    if let Some(total) = query.total {
        let in_range = offset
            .checked_add(bytes.len())
            .is_some_and(|end| end <= total);
        return Ok(input["size"].as_u64() == u64::try_from(total).ok() && in_range);
    }
    if input["size"].as_u64() != u64::try_from(bytes.len()).ok() {
        return Ok(false);
    }
    match input["sha256"].as_str() {
        Some(stored) => Ok(crate::workspace::digest(bytes).await? == stored),
        None => Ok(true),
    }
}

/// Attachments arriving in parts, by session and request: (total size, bytes so far, last part). Some sandbox
/// proxies drop requests over about 8 MB, so clients send large files in 4 MiB parts. Unfinished uploads expire.
struct Partial {
    total: usize,
    name: String,
    kind: String,
    bytes: Vec<u8>,
    at: Instant,
}
static PARTS: LazyLock<Mutex<HashMap<String, Partial>>> = LazyLock::new(Default::default);
/// The sizes of all open uploads together, across sessions (the core's memory bound for partial uploads).
const UPLOAD_BUDGET: usize = 256 << 20;
const PART_BYTES: usize = 8 << 20;

/// Adds one part; returns the bytes received and, once complete, the whole file. The partial stays until its
/// receipt is recorded, so a retried last part can save it again. Every part must name the same file.
fn attach_part(
    key: &str,
    name: &str,
    kind: &str,
    offset: usize,
    total: usize,
    part: &[u8],
) -> std::result::Result<Progress, &'static str> {
    let mut parts = PARTS.lock().unwrap();
    parts.retain(|_, partial| partial.at.elapsed() < Duration::from_secs(600));
    if offset == 0 && !parts.contains_key(key) {
        // Keys are "session/request"; a session may hold eight open uploads, whatever the others hold.
        let session = key.split('/').next();
        let open = parts
            .keys()
            .filter(|open| open.split('/').next() == session)
            .count();
        if open >= 8 {
            return Err("too many uploads in progress; try again");
        }
        // Every open upload holds its whole size in memory once its parts arrive, so the sizes are budgeted
        // across all sessions as well as per session.
        let reserved: usize = parts.values().map(|partial| partial.total).sum();
        if reserved.saturating_add(total) > UPLOAD_BUDGET {
            return Err("too many uploads in progress; try again");
        }
        parts.insert(
            key.to_owned(),
            Partial {
                total,
                name: name.to_owned(),
                kind: kind.to_owned(),
                bytes: Vec::new(),
                at: Instant::now(),
            },
        );
    }
    let partial = parts.get_mut(key).ok_or("upload part out of order")?;
    if partial.total != total || partial.name != name || partial.kind != kind {
        return Err("request_id already has different content");
    }
    let before = partial.bytes.len();
    append_part(&mut partial.bytes, offset, part, total)?;
    partial.at = Instant::now();
    let received = partial.bytes.len();
    Ok(if received == total {
        Progress::Complete {
            whole: partial.bytes.clone(),
            before,
        }
    } else {
        Progress::Received(received)
    })
}

enum Progress {
    Received(usize),
    Complete { whole: Vec<u8>, before: usize },
}

/// Drops the bytes a refused completing part added, so a corrected retry is not compared with them.
fn truncate_part(key: &str, before: usize) {
    if let Some(partial) = PARTS.lock().unwrap().get_mut(key) {
        partial.bytes.truncate(before);
    }
}

/// Appends one part of an upload that arrives in pieces. A repeated part with the same bytes is ignored, so
/// retrying after a lost response is safe; different bytes for buffered offsets, a gap or an overflow are refused.
pub(crate) fn append_part(
    buffer: &mut Vec<u8>,
    offset: usize,
    part: &[u8],
    total: usize,
) -> std::result::Result<(), &'static str> {
    let end = offset
        .checked_add(part.len())
        .filter(|end| *end <= total)
        .ok_or("upload part exceeds the upload size")?;
    if offset == buffer.len() {
        buffer.extend_from_slice(part);
    } else if end > buffer.len() {
        return Err("upload part out of order");
    } else if buffer[offset..end] != *part {
        return Err("request_id already has different content");
    }
    Ok(())
}
async fn interrupt(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Json(body): Json<Interrupt>,
) -> Result<impl IntoResponse> {
    key(&body.request_id)?;
    key(&body.target_request_id)?;
    let receipt = manager.command(
        &id,
        body.request_id,
        "interrupt",
        json!({"target_request_id":body.target_request_id}),
    )?;
    Ok(accepted(&manager, &id, receipt))
}
async fn events(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(query): Query<Cursor>,
) -> Result<Json<Value>> {
    cursor(query.after)?;
    manager.session(&id).await?;
    Ok(Json(
        json!({"events":manager.records(&id,query.after).await?,"saving":manager.saving()}),
    ))
}
async fn stream(
    State(manager): State<Arc<Manager>>,
    Path(id): Path<String>,
    Query(query): Query<Cursor>,
    headers: HeaderMap,
) -> Result<impl IntoResponse> {
    let mut after = match headers.get("last-event-id") {
        Some(header) => header
            .to_str()
            .ok()
            .and_then(|h| h.parse().ok())
            .ok_or(session::Error::Conflict("invalid Last-Event-ID"))?,
        None => query.after,
    };
    cursor(after)?;
    let mut changed = manager.subscribe();
    let session = manager.session(&id).await?;
    if after > session.last_sequence {
        return Err(session::Error::Conflict("cursor exceeds session history"));
    }
    let (sender, receiver) = tokio::sync::mpsc::channel(32);
    tokio::spawn(async move {
        loop {
            if manager.is_stopping() {
                return;
            }
            match manager.records(&id, after).await {
                Ok(records) if !records.is_empty() => {
                    for record in records {
                        let sequence = record.sequence;
                        let event = Event::default()
                            .id(sequence.to_string())
                            .event("record")
                            .data(serde_json::to_string(&record).expect("record serialization"));
                        tokio::select! {
                            result = sender.send(Ok::<_, Infallible>(event)) => if result.is_err() { return; },
                            _ = changed.wait_for(|_| manager.is_stopping()) => return,
                        }
                        after = sequence;
                    }
                }
                Ok(_) => tokio::select! {
                    _=sender.closed()=>return,
                    result=changed.changed()=>if result.is_err(){return;},
                },
                Err(_) => return,
            }
        }
    });
    Ok(Sse::new(ReceiverStream::new(receiver)).keep_alive(KeepAlive::default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(name: &str, kind: &str, offset: Option<usize>, total: Option<usize>) -> AttachQuery {
        AttachQuery {
            request_id: "r1".into(),
            name: name.into(),
            kind: kind.into(),
            offset,
            total,
        }
    }

    fn stored(size: usize, digest: Option<&str>) -> Value {
        let mut input =
            json!({"name": "a.txt", "kind": "file", "size": size, "path": "/no/such/file"});
        if let Some(digest) = digest {
            input["sha256"] = json!(digest);
        }
        input
    }

    #[tokio::test]
    async fn a_retry_matches_the_stored_name_kind_size_and_digest() {
        let digest = crate::workspace::digest(b"x").await.unwrap();
        let input = stored(1, Some(&digest));
        let same = query("a.txt", "file", None, None);
        assert!(stored_matches(&input, &same, 0, b"x").await.unwrap());
        assert!(
            !stored_matches(&input, &same, 0, b"y").await.unwrap(),
            "other bytes, same size"
        );
        assert!(
            !stored_matches(&input, &same, 0, b"yy").await.unwrap(),
            "other size"
        );
        assert!(
            !stored_matches(&input, &query("b.txt", "file", None, None), 0, b"x")
                .await
                .unwrap(),
            "other name"
        );
        assert!(
            !stored_matches(&input, &query("a.txt", "image", None, None), 0, b"x")
                .await
                .unwrap(),
            "other kind"
        );
        let legacy = stored(1, None);
        assert!(
            stored_matches(&legacy, &same, 0, b"y").await.unwrap(),
            "a receipt without a digest"
        );
    }

    #[tokio::test]
    async fn a_retried_part_matches_the_stored_total_and_range() {
        let input = stored(4, None);
        let part = query("a.txt", "file", Some(2), Some(4));
        assert!(stored_matches(&input, &part, 2, b"cd").await.unwrap());
        assert!(
            !stored_matches(&input, &part, usize::MAX, b"cd")
                .await
                .unwrap(),
            "offset overflow"
        );
        assert!(
            !stored_matches(&stored(5, None), &part, 2, b"cd")
                .await
                .unwrap(),
            "other total"
        );
    }

    #[test]
    fn parts_of_one_upload_must_all_name_the_same_file() {
        let key = "test-f13/r1";
        assert!(matches!(
            attach_part(key, "first.txt", "file", 0, 4, b"ab"),
            Ok(Progress::Received(2))
        ));
        assert_eq!(
            attach_part(key, "second.md", "file", 2, 4, b"cd").err(),
            Some("request_id already has different content")
        );
        assert!(matches!(
            attach_part(key, "first.txt", "file", 2, 4, b"cd"),
            Ok(Progress::Complete { .. })
        ));
        PARTS.lock().unwrap().remove(key);
    }

    #[test]
    fn a_repeated_part_must_match_the_buffered_bytes() {
        let mut buffer = Vec::new();
        append_part(&mut buffer, 0, b"AAAA", 12).unwrap();
        append_part(&mut buffer, 4, b"BBBB", 12).unwrap();
        assert!(
            append_part(&mut buffer, 0, b"AAAA", 12).is_ok(),
            "a retry of the same bytes"
        );
        assert_eq!(
            append_part(&mut buffer, 4, b"CCCC", 12),
            Err("request_id already has different content")
        );
        assert_eq!(buffer, b"AAAABBBB");
    }

    #[test]
    fn a_refused_completing_part_leaves_no_bytes_behind() {
        let key = "test-f93/r1";
        assert!(matches!(
            attach_part(key, "ok.txt", "file", 0, 3, b"a"),
            Ok(Progress::Received(1))
        ));
        let Ok(Progress::Complete { before, .. }) = attach_part(key, "ok.txt", "file", 1, 3, b"XY")
        else {
            panic!("the last part completes the file");
        };
        // The workspace refused the file, so the handler drops the part again.
        truncate_part(key, before);
        let Ok(Progress::Complete { whole, .. }) = attach_part(key, "ok.txt", "file", 1, 3, b"bc")
        else {
            panic!("the corrected retry completes the file");
        };
        assert_eq!(whole, b"abc");
        PARTS.lock().unwrap().remove(key);
    }

    #[test]
    fn attachments_in_a_prompt_must_be_an_array() {
        let refused = |attachments: Value| attachments_array(Some(&attachments)).is_err();
        assert!(refused(json!("report.pdf")), "a string is refused");
        assert!(refused(json!({"kind": "file"})), "an object is refused");
        assert!(!refused(json!([])), "an empty array is accepted");
        assert!(!refused(json!([{"kind": "file"}])));
        assert!(
            prompt_input(
                "see file".into(),
                None,
                Some(json!("report.pdf")),
                None,
                None
            )
            .is_ok(),
            "a retry of an accepted prompt is answered by its receipt, so the input is not refused here"
        );
    }

    #[test]
    fn a_damaged_or_invalid_workspace_entry_is_not_temporary() {
        let damaged = std::io::Error::from(serde_json::from_slice::<Value>(b"{").unwrap_err());
        assert_eq!(workspace_refusal(&damaged), "invalid_workspace");
        let empty = std::io::Error::from(serde_json::from_slice::<Value>(b"").unwrap_err());
        assert_eq!(workspace_refusal(&empty), "invalid_workspace");
        for message in [
            "Invalid workspace ID",
            "Invalid workspace path",
            "Invalid workspace parent",
            "Invalid workspace directory",
            "Invalid workspace root",
            "Workspace identity mismatch",
            "Workspace parent missing",
        ] {
            assert_eq!(
                workspace_refusal(&std::io::Error::other(message)),
                "invalid_workspace",
                "{message}"
            );
        }
        assert_eq!(
            workspace_refusal(&std::io::Error::other("workspace filesystem unavailable")),
            "workspace_unavailable"
        );
        assert_eq!(
            workspace_refusal(&std::io::Error::from_raw_os_error(5)),
            "workspace_unavailable",
            "an I/O failure may clear"
        );
    }

    #[test]
    fn temporary_refusals_carry_retryable_codes() {
        for (error, code) in [
            (
                "the turn is still starting; try the interrupt again in a moment",
                "session_busy",
            ),
            ("wait for the pending close or interrupt", "session_busy"),
            ("wait for the pending rewind", "session_busy"),
            ("session is still starting", "session_busy"),
            ("wait for compaction", "session_busy"),
            ("too many uploads in progress; try again", "session_busy"),
            ("storage unsafe; uploads are blocked", "storage_blocked"),
            (
                "the agent is starting; try again in a few seconds",
                "session_busy",
            ),
            ("compaction is already running", "session_busy"),
            ("harness is not ready for compaction", "session_busy"),
            ("harness is not ready to rewind", "session_busy"),
            (
                "wait for child agents before editing a message",
                "session_busy",
            ),
            (
                "wait for the active turn to finish before editing a sent message",
                "session_busy",
            ),
            (
                "the source agent is busy; fork from an earlier message or try again shortly",
                "session_busy",
            ),
            (
                "new execution is paused; try again shortly",
                "storage_blocked",
            ),
            (
                "workload is paused for storage; close it or wait for recovery",
                "storage_blocked",
            ),
            (
                "interrupt target is no longer the active request",
                "request_rejected",
            ),
            ("session ID belongs to another session", "teleport_rejected"),
            ("request not found", "request_not_found"),
        ] {
            assert_eq!(conflict_code(error), code, "{error}");
        }
    }

    #[tokio::test]
    async fn a_refused_attach_during_a_pending_close_writes_no_file() {
        let root = std::env::temp_dir().join(format!(
            "cloudroom-api-pending-attach-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("code")).unwrap();
        let manager = Manager::open(crate::config::Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            token: String::new(),
            state_dir: root.join("state"),
            repository: root.clone(),
            api_url: Some("http://127.0.0.1:1".into()),
            store: "test".into(),
            instance: None,
            account_home: root.clone(),
            default_harness: crate::runtime::Kind::Claude,
            harnesses: Default::default(),
            storage: None,
            rpc_timeout: Duration::from_secs(30),
            diagnostic_upload: Duration::from_secs(1),
        })
        .unwrap();
        let start = json!({"request_id":"start","command":"start","input":{"harness":"claude-code"},"state":"completed",
            "workspace":{"id":"legacy","path":root.join("code")}});
        manager.note("cr_pending", "receipt", start).unwrap();
        let close = json!({"request_id":"c1","command":"close","input":{},"state":"accepted"});
        manager.note("cr_pending", "receipt", close).unwrap();
        assert!(manager.close_pending("cr_pending"));
        let attempt = attach(
            State(manager.clone()),
            Path("cr_pending".into()),
            Query(query("secret.txt", "file", None, None)),
            Body::from("refused upload"),
        )
        .await;
        assert!(
            matches!(
                attempt,
                Err(session::Error::Conflict(
                    "wait for the pending close or interrupt"
                ))
            ),
            "an attach during a pending close is refused with the pending-close refusal"
        );
        assert!(
            !root.join("code/.cloudroom").exists(),
            "nothing is written to the workspace for a refused attach"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn open_uploads_share_one_byte_budget_across_sessions() {
        let (first, second) = ("test-f28-budget-a/open0", "test-f28-budget-b/open0");
        assert!(attach_part(first, "a.txt", "file", 0, UPLOAD_BUDGET - 1024, b"ab").is_ok());
        assert_eq!(
            attach_part(second, "a.txt", "file", 0, 2048, b"ab").err(),
            Some("too many uploads in progress; try again"),
            "a second session's upload past the shared budget"
        );
        let mut parts = PARTS.lock().unwrap();
        parts.remove(first);
        parts.remove(second);
    }

    #[test]
    fn open_uploads_are_limited_per_session() {
        let keys = |session: &str| -> Vec<String> {
            (0..9).map(|n| format!("{session}/open{n}")).collect()
        };
        for key in &keys("test-f28-a")[..8] {
            assert!(attach_part(key, "a.txt", "file", 0, 4, b"ab").is_ok());
        }
        assert_eq!(
            attach_part("test-f28-a/open8", "a.txt", "file", 0, 4, b"ab").err(),
            Some("too many uploads in progress; try again"),
            "a ninth open upload in the same session"
        );
        assert!(
            attach_part("test-f28-b/open0", "a.txt", "file", 0, 4, b"ab").is_ok(),
            "another session's upload is not blocked"
        );
        let mut parts = PARTS.lock().unwrap();
        for key in keys("test-f28-a")
            .iter()
            .chain(&["test-f28-b/open0".to_owned()])
        {
            parts.remove(key);
        }
    }
}
