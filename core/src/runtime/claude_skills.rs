use super::{Handle, files, process::MAX_LINE};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

fn byte_offset(text: &str, units: u64) -> io::Result<usize> {
    let mut offset = 0;
    for (byte, ch) in text.char_indices() {
        if offset == units {
            return Ok(byte);
        }
        offset += ch.len_utf16() as u64;
    }
    if offset == units {
        Ok(text.len())
    } else {
        Err(invalid("Invalid selected skill range"))
    }
}

fn roots(handle: &Handle, origin: &str) -> io::Result<Vec<PathBuf>> {
    match origin {
        "user" => Ok(vec![handle.profile.home.join("skills")]),
        "project" => {
            let mut roots = Vec::new();
            for directory in handle.repository.ancestors() {
                roots.push(directory.join(".claude/skills"));
                if directory.join(".git").exists() {
                    return Ok(roots);
                }
            }
            roots.truncate(1);
            Ok(roots)
        }
        _ => Err(invalid(
            "Selected skill must come from user or project skills on this machine",
        )),
    }
}

fn body(content: &str, name: &str) -> io::Result<String> {
    let content = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut body = content.as_str();
    if content.starts_with("---\n") {
        let end = content[3..]
            .find("\n---\n")
            .map(|offset| offset + 3)
            .or_else(|| content.ends_with("\n---").then(|| content.len() - 4))
            .ok_or_else(|| invalid(format!("Skill /{name} has invalid frontmatter")))?;
        let rest = &content[end + 4..];
        let header = &content[4..end.max(4)];
        let native = [
            "allowed-tools",
            "disallowed-tools",
            "model",
            "effort",
            "context",
            "agent",
            "background",
            "hooks",
            "shell",
            "arguments",
            "user-invocable",
        ];
        if header.trim_start().starts_with(['{', '['])
            || header.lines().any(|line| {
                line.split_once(':')
                    .is_some_and(|(key, _)| native.contains(&key.trim().trim_matches(['\'', '"'])))
            })
        {
            return Err(invalid(format!(
                "Skill /{name} uses native Claude settings. Use its native invocation instead of a Cloudroom skill tag."
            )));
        }
        body = rest.trim_start();
    }
    if body.contains("!`") || body.contains("$ARGUMENTS") || body.contains("${CLAUDE_") {
        return Err(invalid(format!(
            "Skill /{name} requires native Claude expansion; use its native invocation instead of a Cloudroom skill tag."
        )));
    }
    if body.trim().is_empty() {
        return Err(invalid(format!("Skill /{name} is empty")));
    }
    Ok(body.into())
}

fn load(handle: &Handle, name: &str, origin: &str) -> io::Result<(PathBuf, String)> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_'))
    {
        return Err(invalid(
            "Only installed user/project skill names are supported; use native invocation for namespaced skills",
        ));
    }
    let mut candidates = HashSet::new();
    for root in roots(handle, origin)? {
        match root.join(name).canonicalize() {
            Ok(directory) => match fs::symlink_metadata(directory.join("SKILL.md")) {
                Ok(_) => {
                    candidates.insert(directory);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    if candidates.len() != 1 {
        return Err(invalid(format!(
            "Skill /{name} is {} on this machine. Check its installation and select it again.",
            if candidates.is_empty() {
                "missing"
            } else {
                "ambiguous"
            }
        )));
    }
    let directory = candidates.into_iter().next().unwrap();
    let file = files::open(&directory, Path::new("SKILL.md"), handle.file_identity)?;
    if file.metadata()?.len() > MAX_LINE as u64 {
        return Err(invalid("Skill exceeds the Claude input limit"));
    }
    let mut content = String::new();
    file.take(MAX_LINE as u64 + 1)
        .read_to_string(&mut content)?;
    if content.len() > MAX_LINE {
        return Err(invalid("Skill exceeds the Claude input limit"));
    }
    Ok((directory, body(&content, name)?))
}

/// Returns the prompt text and a warning for each selected skill that could not load.
/// A missing skill never fails the turn: the agent gets a short note instead.
pub(super) fn expand(handle: &Handle, input: &Value) -> io::Result<(String, Vec<Value>)> {
    let original = input["text"].as_str().unwrap_or_default();
    let Some(parts) = input["content"].as_array() else {
        return Ok((original.into(), Vec::new()));
    };
    let mut texts = Vec::new();
    let mut originals = Vec::new();
    let mut instructions = Vec::new();
    let mut missing = Vec::new();
    let mut warnings = Vec::new();
    let mut loaded = HashSet::new();
    let mut selections = HashSet::new();
    let mut remaining = MAX_LINE.saturating_sub(original.len());
    for part in parts.iter().filter(|part| part["type"] == "text") {
        let text = part["text"]
            .as_str()
            .ok_or_else(|| invalid("Invalid prompt text"))?;
        originals.push(text);
        let mut mentions: Vec<_> = part["mentions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|mention| {
                mention["resource"]["kind"] == "command" && mention["resource"]["source"] == "skill"
            })
            .collect();
        mentions.sort_by_key(|mention| mention["start"].as_u64());
        let mut rendered = String::new();
        let mut cursor = 0;
        for mention in mentions {
            let name = mention["resource"]["name"]
                .as_str()
                .ok_or_else(|| invalid("Invalid selected skill name"))?;
            let origin = mention["resource"]["origin"]
                .as_str()
                .ok_or_else(|| invalid("Invalid selected skill origin"))?;
            let start = byte_offset(
                text,
                mention["start"]
                    .as_u64()
                    .ok_or_else(|| invalid("Invalid selected skill range"))?,
            )?;
            let end = byte_offset(
                text,
                mention["end"]
                    .as_u64()
                    .ok_or_else(|| invalid("Invalid selected skill range"))?,
            )?;
            if start < cursor || start >= end || text.get(start..end) != Some(&format!("/{name}")) {
                return Err(invalid(
                    "Invalid selected skill tag; remove it and select the skill again",
                ));
            }
            if selections.insert((name, origin)) {
                match load(handle, name, origin) {
                    Ok((directory, body)) if loaded.insert(directory.clone()) => {
                        let block = format!(
                            "Skill: /{name}\nBase directory: {}\n\n{body}",
                            directory.display()
                        );
                        remaining = remaining.checked_sub(block.len()).ok_or_else(|| {
                            invalid(
                                "Selected skills exceed the Claude input limit; select fewer skills",
                            )
                        })?;
                        instructions.push(block);
                    }
                    Ok(_) => {}
                    Err(error) => {
                        missing.push(format!("/{name}"));
                        warnings.push(json!({"message":format!("Skill /{name} was not loaded. The agent will look for it."),"detail":error.to_string()}));
                    }
                }
            }
            rendered.push_str(&text[cursor..start]);
            rendered.push_str(name);
            cursor = end;
        }
        rendered.push_str(&text[cursor..]);
        texts.push(rendered);
    }
    if instructions.is_empty() && missing.is_empty() {
        return Ok((original.into(), warnings));
    }
    if originals.join("\n") != original {
        return Err(invalid(
            "Selected skill content does not match the prompt text",
        ));
    }
    let mut sections = Vec::new();
    if !instructions.is_empty() {
        sections.push(format!(
            "The user explicitly selected these skills. Their instructions are already loaded below; do not invoke them again with the Skill tool. Resolve relative paths from each skill's base directory.\n\n{}",
            instructions.join("\n\n")
        ));
    }
    if !missing.is_empty() {
        sections.push(format!(
            "The user selected {}, but Cloudroom could not load it on this machine. If the project is still being copied here, wait briefly, then read its SKILL.md from .claude/skills/. Otherwise the skill is probably only on the user's computer: tell the user and ask before copying it over. Answer the request either way.",
            missing.join(", ")
        ));
    }
    let expanded = format!(
        "{}\n\nUser request:\n{}",
        sections.join("\n\n"),
        texts.join("\n")
    );
    if expanded.len() > MAX_LINE {
        return Err(invalid(
            "Selected skills exceed the Claude input limit; select fewer skills",
        ));
    }
    Ok((expanded, warnings))
}
