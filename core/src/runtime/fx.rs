//! Vercel fx over ACP. Reuses the Cursor ACP protocol; fx keeps its own session files.
use super::{Handle, Resume, command as child_command, cursor};
use crate::config::{Config, HarnessConfig};
use serde_json::{Value, json};
use std::{io, path::Path};
use tokio::process::Command;

pub(super) const FX: cursor::Flavor = cursor::Flavor {
    harness: "fx",
    name: "fx",
    native_path: |home, id| home.join("sessions").join(id).join("session.json"),
    valid_id,
    capture: false,
    notices: &["[context] ", "skill discovery warning: "],
    replay: false,
    explain_stops: true,
    empty_turn: None,
    cumulative_text: false,
};

pub(super) fn command(config: &Config, profile: &HarnessConfig) -> io::Result<Command> {
    if profile.home.canonicalize()? != config.account_home.join(".fx").canonicalize()? {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "fx home must belong to the configured agent account",
        ));
    }
    let mut command = child_command(&profile.binary, config);
    // Cloud agents run in full access (ADR 0045); the VM pins the fx version.
    command
        .env("FX_PERMISSION_MODE", "full-access")
        .env("FX_AUTO_UPGRADE", "0")
        .arg("acp");
    Ok(command)
}

pub(super) async fn start(handle: &Handle) -> io::Result<String> {
    let capabilities = cursor::initialize(handle, "fx").await.map_err(|error| {
        if error
            .to_string()
            .contains("needs access to Vercel AI Gateway")
        {
            io::Error::new(
                error.kind(),
                format!(
                    "{error} In Cloud, add AI_GATEWAY_API_KEY in Settings → Cloud environment."
                ),
            )
        } else {
            error
        }
    })?;
    let sessions = &capabilities["sessionCapabilities"];
    let mut params = json!({"cwd":handle.repository,"mcpServers":[]});
    // Resume reattaches without replaying history; Cloudroom already has it. Older fx only loads.
    let method = if let Some(saved) = &handle.resume {
        params["sessionId"] = json!(saved.id);
        if sessions["resume"].is_object() {
            "session/resume"
        } else {
            "session/load"
        }
    } else {
        // fx keeps these instructions with the session, so prompts need not repeat them. fx takes up to 64 KiB.
        let instructions = cursor::instructions(handle);
        if sessions["systemPrompt"].is_object() && instructions.len() <= 64 * 1024 {
            params["systemPrompt"] = json!([{"type":"text","text":instructions}]);
        }
        "session/new"
    };
    let (id, session) = cursor::attach(handle, "fx", method, params).await?;
    *handle.acp_config.lock().unwrap() = session;
    let requested = handle.profile.model.as_str();
    if requested != "default" {
        if !offers(&handle.acp_config.lock().unwrap(), "model", requested) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("fx model {requested} is unavailable for this account"),
            ));
        }
        set(handle, &id, "model", requested).await?;
    }
    prepare_turn(handle).await?;
    Ok(id)
}

/// Switches to the turn's effort. Like Local threads, a model without it keeps fx's default (ADR 0133).
pub(super) async fn prepare_turn(handle: &Handle) -> io::Result<()> {
    let Some(effort) = handle.reasoning.as_deref() else {
        return Ok(());
    };
    let change = {
        let state = handle.acp_config.lock().unwrap();
        offers(&state, "effort", effort) && cursor::option_value(&state, "effort") != Some(effort)
    };
    if change {
        set(handle, &handle.native()?, "effort", effort).await?;
    }
    Ok(())
}

pub(super) async fn send(handle: &Handle, request: &str, input: &Value) -> io::Result<()> {
    let id = handle.native()?;
    let images = images(handle, input).await?;
    let instructed = instructed(&handle.profile.home, &id);
    cursor::prompt(handle, request, input, instructed, images).await
}

/// Image attachments go inline when fx accepts images; their paths still follow the text.
async fn images(handle: &Handle, input: &Value) -> io::Result<Vec<Value>> {
    if handle.acp.lock().unwrap()["promptCapabilities"]["image"] != true {
        return Ok(Vec::new());
    }
    // Leave room in the ACP frame for the text, the instructions, and the envelope.
    let used = serde_json::to_vec(input)?.len() + cursor::instructions(handle).len() + 4096;
    let remaining = super::process::MAX_LINE.saturating_sub(used);
    let (reader, input) = (handle.clone(), input.clone());
    tokio::task::spawn_blocking(move || super::files::images(&reader, &input, remaining))
        .await
        .map_err(io::Error::other)?
        // No prompt was sent: reject this request and allow queued work to continue.
        .map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("cannot read image attachment: {error}"),
            )
        })
}

/// fx joins a steer to the running turn without cancelling its work. Older fx cancels and resends.
pub(super) async fn steer(handle: &Handle, request: &str, text: &str) -> io::Result<()> {
    if handle.acp.lock().unwrap()["_meta"]["fx"]["steering"] != true {
        return cursor::steer(handle, request, text).await;
    }
    let _control = handle.controls.lock().await;
    // fx answers a steer only when the turn ends, so this only waits for it to be sent.
    handle
        .process
        .dispatch(
            "cloudroom/join",
            json!({"sessionId":handle.native()?,"prompt":[{"type":"text","text":text}],
                "_meta":{"fx":{"steer":true}}}),
            None,
            Some(request),
        )
        .await
}

/// Whether the session keeps Cloudroom's instructions. fx saves them with the session: older fx as a file, fx 0.0.16
/// as a `client_prompt` line in its log.
fn instructed(home: &Path, id: &str) -> bool {
    if !valid_id(id) {
        return false;
    }
    if home
        .join("sessions")
        .join(id)
        .join("client/system-prompt.txt")
        .is_file()
    {
        return true;
    }
    let Ok(log) = std::fs::File::open(v2_log(home, id)) else {
        return false;
    };
    io::BufRead::lines(io::BufReader::new(log))
        .map_while(Result::ok)
        .filter(|line| line.contains("\"client_prompt\""))
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .any(|line| line["kind"] == "set" && line["key"] == "client_prompt")
}

/// fx 0.0.16 keeps each session as a log in `sessions/v2/<id>/`, and moves an older one there when it loads it.
fn v2_log(home: &Path, id: &str) -> std::path::PathBuf {
    home.join("sessions/v2").join(id).join("log.jsonl")
}

fn offers(session: &Value, option: &str, value: &str) -> bool {
    session["configOptions"]
        .as_array()
        .and_then(|options| options.iter().find(|o| o["id"] == option))
        .and_then(|option| option["options"].as_array())
        .is_some_and(|options| options.iter().any(|o| o["value"] == value))
}

async fn set(handle: &Handle, id: &str, option: &str, value: &str) -> io::Result<()> {
    let result = handle
        .call(
            "session/set_config_option",
            json!({"sessionId":id,"configId":option,"value":value}),
        )
        .await?;
    if cursor::option_value(&result, option) != Some(value) {
        return Err(io::Error::other(format!(
            "fx did not confirm {option} {value}"
        )));
    }
    *handle.acp_config.lock().unwrap() = result;
    Ok(())
}

pub(super) fn validate(
    profile: &HarnessConfig,
    saved: &Resume,
    identity: super::files::Identity,
) -> io::Result<()> {
    let root = profile.home.join("sessions");
    // The saved path stays the older layout's, whichever layout fx uses now.
    if !valid_id(&saved.id) || saved.path != (FX.native_path)(&profile.home, &saved.id) {
        return Err(io::Error::other(
            "fx native path does not match its session",
        ));
    }
    let limit = super::process::MAX_LINE as u64;
    // fx 0.0.16: the log's first line creates the session.
    let v2 =
        super::files::open(&root, &v2_log(&profile.home, &saved.id), identity).and_then(|file| {
            let mut first = String::new();
            io::BufRead::read_line(
                &mut io::BufReader::new(io::Read::take(file, limit)),
                &mut first,
            )?;
            let value: Value = serde_json::from_str(&first)?;
            if value["kind"] != "session_created" || value["id"] != saved.id.as_str() {
                return Err(io::Error::other("Unsupported fx native metadata"));
            }
            Ok(())
        });
    let Err(v2) = v2 else { return Ok(()) };
    let v1 = super::files::open(&root, &saved.path, identity).and_then(|file| {
        let value: Value = serde_json::from_reader(io::Read::take(file, limit))?;
        if value["id"] != saved.id.as_str() {
            return Err(io::Error::other("Unsupported fx native metadata"));
        }
        Ok(())
    });
    // Missing in both layouts stays NotFound; otherwise the layout that exists says what is wrong.
    v1.map_err(|v1| {
        if v1.kind() == io::ErrorKind::NotFound {
            v2
        } else {
            v1
        }
    })
}

/// fx's own rule for session IDs: letters, digits, `.`, `_` and `-`, never `.`, `..` or `v2`.
/// fx 0.0.x makes 12-character IDs; the 0.3.x line used `<ms>-<ns>-<16 hex>`.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 255
        && !matches!(id, "." | "..")
        && !id.eq_ignore_ascii_case("v2")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
