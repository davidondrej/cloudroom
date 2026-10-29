//! Cursor's `--list-models` catalog as model families with reasoning levels, named like the GUI picker.
use super::{Kind, Model, command as child_command};
use crate::{config::Config, workspace::storage::Guard};
use std::{collections::BTreeMap, io, time::Duration};

const EFFORTS: [(&str, &str); 7] = [
    ("extra-high", "xhigh"),
    ("medium", "medium"),
    ("xhigh", "xhigh"),
    ("high", "high"),
    ("low", "low"),
    ("max", "max"),
    ("none", "none"),
];
const LEVELS: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];

#[derive(Default)]
struct Slot {
    normal: Option<(String, &'static str)>,
    fast: Option<(String, &'static str)>,
}
type Families = BTreeMap<String, BTreeMap<usize, Slot>>;

fn strip(value: &mut String, suffix: &str) -> bool {
    let found = value.ends_with(suffix);
    if found {
        value.truncate(value.len() - suffix.len());
    }
    found
}

/// Family, effort, fast and thinking parts of one variant ID, e.g. `gpt-5.6-sol-xhigh-fast`.
fn split(id: &str) -> (String, &'static str, bool, bool) {
    let mut rest = id.to_owned();
    let fast = strip(&mut rest, "-fast");
    let thinking = strip(&mut rest, "-thinking") || rest.contains("-thinking-");
    rest = rest.replacen("-thinking-", "-", 1);
    for (token, effort) in EFFORTS {
        if let Some(family) = rest.strip_suffix(&format!("-{token}")) {
            return (family.to_owned(), effort, fast, thinking);
        }
    }
    (rest, "medium", fast, thinking)
}

/// The GUI names `auto` "default" and drops Cursor's `cursor-` prefix.
fn family_name(family: &str) -> String {
    if family == "auto" {
        return "default".into();
    }
    family.strip_prefix("cursor-").unwrap_or(family).to_owned()
}

fn families<'a>(ids: impl IntoIterator<Item = &'a str>) -> Families {
    let mut members: BTreeMap<String, Vec<(&str, &'static str, bool, bool)>> = BTreeMap::new();
    for id in ids {
        let (family, effort, fast, thinking) = split(id);
        members
            .entry(family_name(&family))
            .or_default()
            .push((id, effort, fast, thinking));
    }
    members
        .into_iter()
        .map(|(name, members)| {
            let has_thinking = members.iter().any(|member| member.3);
            let mut levels: BTreeMap<usize, Slot> = BTreeMap::new();
            for (id, effort, fast, thinking) in members {
                // Families with thinking variants treat their non-thinking variants as "none".
                let level = if thinking || !has_thinking {
                    effort
                } else {
                    "none"
                };
                let Some(index) = LEVELS.iter().position(|known| *known == level) else {
                    continue;
                };
                let slot = levels.entry(index).or_default();
                let current = if fast {
                    &mut slot.fast
                } else {
                    &mut slot.normal
                };
                let upgrade = level == "none"
                    && effort == "medium"
                    && current.as_ref().is_some_and(|(_, rep)| *rep != "medium");
                if current.is_none() || upgrade {
                    *current = Some((id.to_owned(), effort));
                }
            }
            (name, levels)
        })
        .collect()
}

pub(crate) fn models<'a>(ids: impl IntoIterator<Item = &'a str>) -> Vec<Model> {
    families(ids)
        .into_iter()
        .map(|(model, levels)| Model {
            model,
            reasoning_levels: levels
                .keys()
                .map(|index| LEVELS[*index].to_owned())
                .collect(),
        })
        .collect()
}

/// The exact Cursor variant for a GUI model family and reasoning level.
pub(crate) fn resolve<'a>(
    ids: impl IntoIterator<Item = &'a str>,
    model: &str,
    reasoning: Option<&str>,
) -> Option<String> {
    let families = families(ids);
    let levels = families.get(model)?;
    let index = match reasoning {
        Some(level) => LEVELS.iter().position(|known| *known == level)?,
        None => [2, 1, 3, 4, 5, 0]
            .into_iter()
            .find(|index| levels.contains_key(index))?,
    };
    let slot = levels.get(&index)?;
    slot.normal
        .as_ref()
        .or(slot.fast.as_ref())
        .map(|(id, _)| id.clone())
}

pub(crate) fn parse(stdout: &str) -> Vec<&str> {
    stdout
        .lines()
        .filter_map(|line| line.trim().split_once(" - "))
        .map(|(id, _)| id)
        .filter(|id| !id.is_empty() && !id.contains(char::is_whitespace))
        .collect()
}

pub(crate) async fn list(config: &Config, storage: &Guard) -> io::Result<Vec<Model>> {
    let profile = config
        .harnesses
        .get(&Kind::Cursor)
        .ok_or_else(|| io::Error::other("Cursor is not configured"))?;
    let mut command = child_command(&profile.binary, config);
    super::cursor_auth::apply_key(&mut command, config)?;
    command
        .current_dir(&config.account_home)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .args(["--disable-auto-update", "--list-models"]);
    let (child, _workload) = storage.spawn_writer(&mut command)?;
    let output = tokio::time::timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| io::Error::other("Cursor model list timed out"))??;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let models = models(parse(&stdout));
    if !output.status.success() || models.is_empty() {
        return Err(io::Error::other("Cursor model list unavailable"));
    }
    Ok(models)
}
