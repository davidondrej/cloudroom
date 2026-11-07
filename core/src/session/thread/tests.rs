use super::*;
use crate::{
    config::{Config, HarnessConfig},
    runtime::Kind,
};
use std::{fs, path::PathBuf};
use tokio::{net::TcpListener, sync::Barrier, task::JoinHandle};

const CATALOG: &str = "The remote state changed: model catalog unavailable. Reload and try again.";
const MODEL: &str = "The remote state changed: invalid model. Reload and try again.";
const REASONING: &str = "The remote state changed: invalid reasoning effort. Reload and try again.";

#[test]
fn catalog_conflicts_include_fixed_discovery_details_but_not_validation_errors() {
    for message in [
        "model catalog unavailable",
        "model catalog unavailable (agent timed out listing models)",
        "model catalog unavailable (agent could not start)",
        "model catalog unavailable (agent exited while starting; try again)",
        "model catalog unavailable (agent sent an invalid model list)",
    ] {
        assert!(catalog_unavailable(message), "{message}");
        assert!(catalog_unavailable(&format!(
            "The remote state changed: {message}. Reload and try again."
        )));
    }
    for message in [
        "invalid model",
        "invalid provider",
        "invalid reasoning effort",
        "invalid model: model catalog unavailable",
        "model catalog unavailable-but-invalid",
    ] {
        assert!(!catalog_unavailable(message), "{message}");
        assert!(!catalog_unavailable(&format!(
            "The remote state changed: {message}. Reload and try again."
        )));
    }
}

struct Website {
    first_error: Option<&'static str>,
    next_error: Option<&'static str>,
    refresh: Barrier,
    calls: Mutex<HashMap<String, Vec<Value>>>,
    manager: Arc<Manager>,
}

async fn launch_reply(
    State(site): State<Arc<Website>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let key = body["request_id"].as_str().unwrap().to_owned();
    let model = body["model"].as_str().unwrap().to_owned();
    let reasoning = body["reasoning"].as_str().unwrap().to_owned();
    let first = {
        let mut calls = site.calls.lock().unwrap();
        let attempts = calls.entry(key.clone()).or_default();
        attempts.push(body);
        attempts.len() == 1
    };
    if first {
        // Start validation together while the provider's catalog refresh is failing.
        site.refresh.wait().await;
    }
    let error = if site.first_error.is_some() {
        if first {
            site.first_error
        } else {
            site.next_error
        }
        .map(str::to_owned)
    } else {
        match site
            .manager
            .execution_supported(Kind::Codex, Some(&model), &reasoning)
            .await
        {
            Ok(()) => None,
            // Stand in for the website's remote-conflict wrapper, using the real Core discovery error.
            Err(crate::session::Error::Conflict(message)) => Some(format!(
                "The remote state changed: {message}. Reload and try again."
            )),
            Err(error) => panic!("unexpected validation error: {error:?}"),
        }
    };
    match error {
        Some(message) => fail(StatusCode::CONFLICT, &message),
        None => (StatusCode::OK, Json(json!({"id":format!("thr_{key}")}))),
    }
}

struct Fixture {
    manager: Arc<Manager>,
    site: Arc<Website>,
    server: JoinHandle<()>,
    directory: PathBuf,
}

impl Fixture {
    async fn new(
        first_error: Option<&'static str>,
        next_error: Option<&'static str>,
        concurrent: usize,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let directory =
            std::env::temp_dir().join(format!("cloudroom-launch-{}", random_key().unwrap()));
        fs::create_dir(&directory).unwrap();
        fs::create_dir(directory.join(".codex")).unwrap();
        let manager = Manager::open(Config {
            listen: "127.0.0.1:0".parse().unwrap(),
            token: "fixture".into(),
            state_dir: directory.join("state"),
            repository: directory.clone(),
            api_url: Some(url),
            store: "fixture".into(),
            instance: None,
            account_home: directory.clone(),
            default_harness: Kind::Codex,
            harnesses: [(
                Kind::Codex,
                HarnessConfig {
                    binary: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/core_fixture.py"),
                    home: directory.join(".codex"),
                    model: "old-model".into(),
                    provider: None,
                },
            )]
            .into(),
            storage: None,
            rpc_timeout: Duration::from_secs(1),
            diagnostic_upload: Duration::from_secs(3600),
        })
        .unwrap();
        let site = Arc::new(Website {
            first_error,
            next_error,
            refresh: Barrier::new(concurrent),
            calls: Mutex::default(),
            manager: manager.clone(),
        });
        let app = Router::new()
            .route("/launch", post(launch_reply))
            .with_state(site.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            manager,
            site,
            server,
            directory,
        }
    }

    async fn change_catalog(&self, failures: usize) {
        let catalog = |model, failures| {
            json!({"models":[{
            "model":model, "supportedReasoningEfforts":[{"reasoningEffort":"high"}],
        }], "failures":failures})
            .to_string()
        };
        let path = self.directory.join("model-catalog.json");
        fs::write(&path, catalog("old-model", 0)).unwrap();
        assert_eq!(
            self.manager.model_catalog(Kind::Codex).await.unwrap()[0].model,
            "old-model"
        );
        fs::write(&path, catalog("gpt-6.1-sol", failures)).unwrap();
        // Expire the successful snapshot without a wall-clock wait. Every failed refresh must leave
        // it intact and let the next request attempt discovery again.
        self.manager.codex_models.lock().await.as_mut().unwrap().0 =
            Instant::now() - Duration::from_secs(61);
    }

    async fn launch(&self, key: &str) -> Result<Json<Value>, Failure> {
        let input = serde_json::from_value(json!({
            "provider":"codex", "model":"gpt-6.1-sol", "reasoning":"high",
            "prompt":"fixture prompt", "title":"fixture title", "top_level":true,
        }))
        .unwrap();
        launch(&self.manager, "cr_parent", key.into(), input).await
    }

    fn attempts(&self, key: &str, expected: usize) {
        let calls = self.site.calls.lock().unwrap();
        let attempts = &calls[key];
        assert_eq!(attempts.len(), expected);
        assert!(
            attempts.iter().all(|body| body == &attempts[0]),
            "retry changed the launch payload"
        );
        assert_eq!(attempts[0]["session"], "cr_parent");
        assert_eq!(attempts[0]["model"], "gpt-6.1-sol");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[tokio::test]
async fn top_level_launch_rechecks_catalog_after_provider_change() {
    let fixture = Fixture::new(None, None, 1).await;
    fixture.change_catalog(1).await;
    let answer = fixture.launch("changed").await.unwrap().0;
    assert_eq!(answer["id"], "thr_changed");
    fixture.attempts("changed", 2);
    assert_eq!(
        fs::read_to_string(fixture.directory.join("model-catalog.calls"))
            .unwrap()
            .lines()
            .count(),
        3
    );
    fixture.manager.shutdown().await;
}

#[tokio::test]
async fn top_level_launch_also_retries_unwrapped_catalog_conflict() {
    for message in [
        "model catalog unavailable",
        "model catalog unavailable (agent could not start)",
    ] {
        let fixture = Fixture::new(Some(message), None, 1).await;
        assert_eq!(fixture.launch("raw").await.unwrap().0["id"], "thr_raw");
        fixture.attempts("raw", 2);
        fixture.manager.shutdown().await;
    }
}

#[tokio::test]
async fn concurrent_top_level_launches_recheck_during_catalog_refresh() {
    let fixture = Fixture::new(None, None, 4).await;
    fixture.change_catalog(4).await;
    let results = tokio::join!(
        fixture.launch("a"),
        fixture.launch("b"),
        fixture.launch("c"),
        fixture.launch("d")
    );
    for (key, result) in ["a", "b", "c", "d"]
        .into_iter()
        .zip([results.0, results.1, results.2, results.3])
    {
        assert_eq!(result.unwrap().0["id"], format!("thr_{key}"));
        fixture.attempts(key, 2);
    }
    // One warm catalog, four failed discoveries, then one successful refresh shared by all retries.
    assert_eq!(
        fs::read_to_string(fixture.directory.join("model-catalog.calls"))
            .unwrap()
            .lines()
            .count(),
        6
    );
    fixture.manager.shutdown().await;
}

#[tokio::test]
async fn top_level_launch_does_not_retry_validation_errors() {
    for message in [
        MODEL,
        REASONING,
        "The remote state changed: invalid provider. Reload and try again.",
    ] {
        let fixture = Fixture::new(Some(message), None, 1).await;
        let (status, body) = fixture.launch("invalid").await.unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body.0["error"], message);
        fixture.attempts("invalid", 1);
        fixture.manager.shutdown().await;
    }
}

#[tokio::test]
async fn top_level_launch_retries_catalog_only_once_and_preserves_next_error() {
    for message in [CATALOG, MODEL, REASONING] {
        let fixture = Fixture::new(Some(CATALOG), Some(message), 1).await;
        let (status, body) = fixture.launch("still-rejected").await.unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body.0["error"], message);
        fixture.attempts("still-rejected", 2);
        fixture.manager.shutdown().await;
    }
}
