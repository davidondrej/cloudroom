//! Saved history, diagnostics, and feedback leave the machine over HTTPS (ADR 0232), never through a database login.
//! History goes up as gzip JSONL files, one per session per batch, straight to file storage through short-lived links
//! the API hands out (ADR 0231, 0237). Without `CLOUDROOM_API_URL`, history stays only in the local journal.
use super::{Receipt, Record, Session};
use crate::config::Config;
use flate2::{Compression, write::GzEncoder};
use reqwest::{Method, RequestBuilder, Response, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fmt, io, io::Write, time::Duration};

/// The API Core saves through: Cloudroom's website, or any server with the same five calls (core/docs/setup.md).
#[derive(Clone)]
pub struct Api {
    http: reqwest::Client,
    base: String,
    token: String,
    store: String,
    instance: Option<String>,
}

#[derive(Debug)]
pub enum ApiError {
    Status(u16, String),
    Network(String),
    /// A saved file holds different records than this journal: never overwritten, never acknowledged.
    Conflict,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Status(status, message) => write!(f, "HTTP {status}: {message}"),
            Self::Network(message) => write!(f, "unreachable: {message}"),
            Self::Conflict => f.write_str("conflicting history record"),
        }
    }
}

impl Api {
    fn new(config: &Config) -> io::Result<Option<Self>> {
        let Some(base) = config.api_url.clone() else {
            return Ok(None);
        };
        // Never follow a redirect: it could carry the token somewhere else.
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(io::Error::other)?;
        Ok(Some(Self {
            http,
            base,
            token: config.token.clone(),
            store: config.store.clone(),
            instance: config.instance.clone(),
        }))
    }

    fn call(&self, method: Method, path: &str) -> RequestBuilder {
        self.http
            .request(method, format!("{}/{path}", self.base))
            .bearer_auth(&self.token)
            .header("x-cloudroom-store", &self.store)
            .header(
                "x-cloudroom-instance",
                self.instance.as_deref().unwrap_or(""),
            )
    }

    async fn send(request: RequestBuilder) -> Result<Response, ApiError> {
        let response = request
            .send()
            .await
            .map_err(|e| ApiError::Network(e.without_url().to_string()))?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let message = body["error"]
            .as_str()
            .unwrap_or("request failed")
            .to_owned();
        Err(ApiError::Status(status, message))
    }

    pub async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, ApiError> {
        Self::send(self.call(Method::GET, path).query(query))
            .await?
            .json()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, ApiError> {
        Self::send(self.call(Method::POST, path).json(body))
            .await?
            .json()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))
    }

    /// A call that may wake another sandbox first, which can use the website's whole 60-second limit.
    pub async fn post_waking(&self, path: &str, body: &Value) -> Result<Value, ApiError> {
        let request = self
            .call(Method::POST, path)
            .timeout(Duration::from_secs(70));
        Self::send(request.json(body))
            .await?
            .json()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))
    }
}

pub struct History {
    pub(crate) api: Option<Api>,
}

#[derive(Deserialize)]
struct Page {
    records: Vec<Record>,
    more: bool,
}

impl History {
    pub fn new(config: &Config) -> io::Result<Self> {
        Ok(Self {
            api: Api::new(config)?,
        })
    }

    pub fn saves_externally(&self) -> bool {
        self.api.is_some()
    }

    /// One batch: a file per session, each written straight to its own link. A file that already exists is fine only
    /// if it holds the same records (a retry after a lost reply); anything else is a conflict.
    pub async fn upload(&self, records: &[Record]) -> Result<(), ApiError> {
        let Some(api) = &self.api else {
            return Ok(());
        };
        let mut sessions: BTreeMap<&str, Vec<&Record>> = BTreeMap::new();
        for record in records {
            sessions.entry(&record.session_id).or_default().push(record);
        }
        let files: Vec<Value> = sessions
            .iter()
            .map(|(session, list)| json!({"session": session, "first": list[0].sequence, "last": list[list.len() - 1].sequence}))
            .collect();
        let links = api.post("uploads", &json!({ "chunks": files })).await?;
        let urls: Vec<&str> = links["uploads"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|link| link["url"].as_str())
            .collect();
        if urls.len() != sessions.len() {
            return Err(ApiError::Network(
                "the API returned the wrong number of upload links".into(),
            ));
        }
        for ((session, list), url) in sessions.iter().zip(urls) {
            let lines = list
                .iter()
                .map(|record| for_database(record))
                .collect::<serde_json::Result<Vec<_>>>()
                .map_err(|e| ApiError::Network(e.to_string()))?;
            let response = api
                .http
                .put(url)
                .header("if-none-match", "*")
                .header("content-type", "application/gzip")
                .timeout(Duration::from_secs(120))
                .body(gzip(&lines))
                .send()
                .await
                .map_err(|e| ApiError::Network(e.without_url().to_string()))?;
            match response.status() {
                status if status.is_success() => {}
                StatusCode::PRECONDITION_FAILED => self.same(session, list, &lines).await?,
                status => {
                    return Err(ApiError::Status(
                        status.as_u16(),
                        "file storage refused the upload".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    /// Whether the saved copy of these records matches ours, record for record.
    async fn same(
        &self,
        session: &str,
        list: &[&Record],
        lines: &[String],
    ) -> Result<(), ApiError> {
        let ours: BTreeMap<u64, Value> = list
            .iter()
            .zip(lines)
            .filter_map(|(record, line)| Some((record.sequence, serde_json::from_str(line).ok()?)))
            .collect();
        let (mut after, last) = (list[0].sequence - 1, list[list.len() - 1].sequence);
        let mut found = 0;
        loop {
            let (records, more) = self.page(session, after, 1000).await?;
            for record in &records {
                // A record too big for one API response comes back without its body: nothing to compare.
                if ours.contains_key(&record.sequence)
                    && record.data.get("oversized_bytes").is_some()
                {
                    found += 1;
                    continue;
                }
                if let Some(expected) = ours.get(&record.sequence) {
                    let saved = serde_json::to_value(record)
                        .map_err(|e| ApiError::Network(e.to_string()))?;
                    if &saved != expected {
                        return Err(ApiError::Conflict);
                    }
                    found += 1;
                }
            }
            after = records.last().map_or(last, |r| r.sequence);
            if !more || after >= last {
                break;
            }
        }
        if found == ours.len() {
            Ok(())
        } else {
            Err(ApiError::Conflict)
        }
    }

    async fn page(
        &self,
        session: &str,
        after: u64,
        limit: usize,
    ) -> Result<(Vec<Record>, bool), ApiError> {
        let Some(api) = &self.api else {
            return Ok((Vec::new(), false));
        };
        let request = api.call(Method::GET, "records").query(&[
            ("session", session.to_owned()),
            ("after", after.to_string()),
            ("limit", limit.to_string()),
        ]);
        let page: Page = Api::send(request)
            .await?
            .json()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;
        Ok((page.records, page.more))
    }

    /// Sends a cloud agent's Cloudroom feedback to David (ADR 0158).
    pub async fn report(&self, message: &str, context: &Value) -> Result<(), ApiError> {
        let Some(api) = &self.api else {
            return Err(ApiError::Status(
                409,
                "Feedback needs a Cloudroom account (CLOUDROOM_API_URL)".into(),
            ));
        };
        api.post("report", &json!({"message": message, "context": context}))
            .await
            .map(drop)
    }

    pub async fn summary(
        &self,
        id: &str,
        request: Option<&str>,
    ) -> Result<(Option<Session>, Option<Receipt>), ApiError> {
        let mut receipt = None; // Decode only the latest matching receipt, not superseded versions.
        let mut session = Session {
            session_id: id.into(),
            state: "saved_history_only".into(),
            ..Session::default()
        };
        let decode = |e: serde_json::Error| ApiError::Network(format!("saved history: {e}"));
        // Every page: replay's page limit must not truncate identity or status.
        let mut after = 0;
        loop {
            let (records, more) = self.page(id, after, 1000).await?;
            // An empty page can't move the cursor: stop rather than ask for it again forever.
            let done = !more || records.is_empty();
            for record in records {
                after = record.sequence;
                session.last_sequence = record.sequence;
                if session.native_id.is_none() && record.kind == "native_identity" {
                    session.native_id = record.data["id"].as_str().map(str::to_owned);
                }
                if record.kind == "receipt" && record.data["command"] == "start" {
                    session.workspace = record
                        .data
                        .get("workspace")
                        .filter(|w| !w.is_null())
                        .map(|w| serde_json::from_value(w.clone()))
                        .transpose()
                        .map_err(decode)?;
                    session.harness = serde_json::from_value(
                        record.data["input"]
                            .get("harness")
                            .cloned()
                            .unwrap_or(json!("codex")),
                    )
                    .map_err(decode)?;
                }
                if record.kind == "workspace" {
                    session.workspace =
                        Some(serde_json::from_value(record.data.clone()).map_err(decode)?);
                }
                if record.kind == "receipt"
                    && request.is_some_and(|id| record.data["request_id"] == id)
                {
                    receipt = Some(record.data);
                }
            }
            if done {
                break;
            }
        }
        let receipt = receipt
            .map(serde_json::from_value)
            .transpose()
            .map_err(decode)?;
        Ok(((session.last_sequence > 0).then_some(session), receipt))
    }

    pub async fn read(&self, session: &str, after: u64) -> Result<Vec<Record>, ApiError> {
        Ok(self.page(session, after, 256).await?.0)
    }
}

fn gzip(lines: &[String]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    for line in lines {
        encoder
            .write_all(line.as_bytes())
            .and_then(|()| encoder.write_all(b"\n"))
            .expect("in-memory gzip");
    }
    encoder.finish().expect("in-memory gzip")
}

/// What saved history keeps of a record (ADR 0203). The sandbox's journal keeps every native line, but saved history
/// drops those nobody reads from it: copied session-file lines (the harness's own file stays on disk), and Claude's
/// raw output, which Core already turns into the records the app shows. Codex and Pi keep theirs.
fn for_database(record: &Record) -> serde_json::Result<String> {
    if record.native.is_none()
        || (record.kind != "native_record" && record.data["harness"] != "claude-code")
    {
        return serde_json::to_string(record);
    }
    serde_json::to_string(&Record {
        native: None,
        ..record.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn saved_history_drops_unread_native_lines_and_still_matches_older_rows() {
        let record = |kind: &str, data, native: &str| Record {
            sequence: 7,
            session_id: "cr_a".into(),
            kind: kind.into(),
            timestamp_ms: Some(1),
            data,
            native: Some(native.into()),
        };
        let claude = record(
            "text_delta",
            json!({"harness":"claude-code","delta":"hi"}),
            r#"{"type":"stream_event"}"#,
        );
        let file = record(
            "native_record",
            json!({"offset":0}),
            "{\"type\":\"user\"}\n",
        );
        let codex = record(
            "text_delta",
            json!({"method":"item/agentMessage/delta"}),
            "{}",
        );
        for kept in [&claude, &file] {
            let (full, saved) = (
                serde_json::to_string(kept).unwrap(),
                for_database(kept).unwrap(),
            );
            assert!(!saved.contains("\"native\""));
            // Copied old rows are this one plus its native line.
            assert!(full.starts_with(&format!("{},\"native\":", &saved[..saved.len() - 1])));
        }
        assert_eq!(
            for_database(&codex).unwrap(),
            serde_json::to_string(&codex).unwrap()
        );
    }

    #[test]
    fn gzip_files_are_jsonl_and_the_same_records_give_the_same_bytes() {
        let lines = vec![
            r#"{"sequence":1}"#.to_owned(),
            r#"{"sequence":2}"#.to_owned(),
        ];
        let mut text = String::new();
        io::Read::read_to_string(
            &mut flate2::read::GzDecoder::new(&gzip(&lines)[..]),
            &mut text,
        )
        .unwrap();
        assert_eq!(text, "{\"sequence\":1}\n{\"sequence\":2}\n");
        assert_eq!(gzip(&lines), gzip(&lines));
    }
}
