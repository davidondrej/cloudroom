#!/usr/bin/env python3
"""Workflow scan extractor (docs/scopes/workflow-scan.md). Runs on the user's computer, standard library only.

Reads local agent chats (Claude Code, Codex, Pi, OpenCode, Hermes), keeps only the user's own messages
(trimmed, secrets masked), flags automated chats, and writes small text files for cloud readers.

  extract.py index OUT [--days 90]                      -> OUT/index.jsonl, OUT/stats.json
  extract.py slices OUT [--n 30] [--chars 900]          -> OUT/slices/slice-NN.txt (all kept chats, at most 100 KB each)
  extract.py groups OUT [--top 12] [--per 15] [--chars 2500] -> OUT/groups/group-NN.txt + OUT/groups/overview.txt
  extract.py sessions OUT --ids c-1a2b3c4d,x-... [--chars 6000]  -> prints those chats
  extract.py reduce OUT [--top 25]                       -> counts the tags in OUT/reports/*.txt, prints a compact digest
"""
import glob, hashlib, json, os, re, sqlite3, sys, time
from collections import Counter, defaultdict

H = os.path.expanduser("~")
SECRET = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----"
                    r"|(sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}"
                    r"|xox[abpr]-[A-Za-z0-9\-]{10,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}|\b[A-Za-z0-9_\-]{40,}\b)"
                    r"|AIza[0-9A-Za-z_\-]{35}|\b[rsp]k_(?:live|test)_[0-9A-Za-z]{16,}|\bBearer\s+[A-Za-z0-9._~+/\-]{12,}=*")
URL_PASSWORD = re.compile(r"(\b[a-z][a-z0-9+.\-]*://[^\s:/@]+:)[^\s@/]+(@)", re.I)
SECRET_VALUE = re.compile(r"(?i)(\b[\w.\-]*(?:passw(?:or)?d|pwd|secret|token|api[_\-]?key|access[_\-]?key|auth|credential)s?[\w.\-]*[\"']?\s*[:=]\s*[\"']?)"
                          r"(?!\[masked\])[^\s\"'&,;]{6,}")
NOISE = re.compile(r"\[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT\]\s*Automatic Cloudroom note: this session has started or resumed\. Messages after this note come from the user\."
                   r"|<system-reminder>.*?</system-reminder>|<(local-)?command-[a-z-]+>.*?</(local-)?command-[a-z-]+>"
                   r"|<environment_context>.*?</environment_context>|<user_instructions>.*?</user_instructions>"
                   r"|<cloudroom_custom_instructions>.*?</cloudroom_custom_instructions>|\[Cloud workspace context\].*$", re.S)
# Chats an agent or an automation started, not the user: they are not habits (loops already run them).
AUTO = ["Loop note", "room-cli loop report", "<webhook_events>", "[Local fork]", "You are a subagent", "Cloudroom messages you when", "This is an automated", "automation run",
        "# AGENTS.md instructions", "<INSTRUCTIONS>"]


def clean(text):
    text = NOISE.sub(" ", text or "")
    text = SECRET.sub("[masked]", re.sub(r"\s+", " ", text))
    return SECRET_VALUE.sub(r"\1[masked]", URL_PASSWORD.sub(r"\1[masked]\2", text)).strip()


def cut(text, n):
    return text if len(text) <= n else text[: n - 1] + "…"


def lines(path, keep=None, skip=None):
    with open(path, "rb") as f:
        for raw in f:
            if keep and not any(k in raw for k in keep):
                continue
            if skip and any(k in raw for k in skip):
                continue
            try:
                yield json.loads(raw)
            except Exception:
                pass


def iso(ts):
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def parse_ts(value):
    if isinstance(value, (int, float)):
        return value / 1000 if value > 1e11 else value
    try:
        return time.mktime(time.strptime(str(value)[:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        return None


def repo_of(cwd):
    if not cwd or cwd.rstrip("/") == H:
        return "~"
    return os.path.basename(cwd.rstrip("/")) or "~"


def record(agent, sid, path, start, cwd, title, users, reply):
    # Notes from Cloudroom or other agents (child results, relayed messages) are not the user's words.
    users = [u for u in (clean(u) for u in users) if u and not u.startswith("[MESSAGE FROM NON-USER SOURCE")]
    deduped = [u for i, u in enumerate(users) if i == 0 or u != users[i - 1]]
    if not deduped or start is None:
        return None
    first = deduped[0]
    why = next((m for m in AUTO if m.lower() in first[:3000].lower()), None)
    return {"id": f"{agent[0]}-{hashlib.sha1(sid.encode()).hexdigest()[:8]}", "agent": agent, "sid": sid, "path": path,
            "start": iso(start), "ts": start, "repo": repo_of(cwd), "title": cut(clean(title or first), 120),
            "n_user": len(deduped), "user": [cut(u, 600) for u in deduped[:20]], "first": cut(first, 1500),
            "reply": cut(clean(reply or ""), 600), "auto": bool(why), "why": why}


def claude(cutoff):
    for path in glob.glob(f"{H}/.claude/projects/*/*.jsonl"):
        if os.path.basename(path).startswith("agent-") or os.path.getmtime(path) < cutoff:
            continue
        users, reply, cwd, start, title = [], None, None, None, None
        for l in lines(path, keep=[b'"user"', b'"assistant"', b'"summary"'], skip=[b'"tool_result"', b'"tool_use"']):
            start = start or parse_ts(l.get("timestamp"))
            cwd = cwd or l.get("cwd")
            if l.get("type") == "summary" and l.get("summary"):
                title = l["summary"]
            if l.get("isSidechain"):
                continue
            m = l.get("message") or {}
            c = m.get("content") if isinstance(m, dict) else None
            if l.get("type") == "user" and not l.get("isMeta") and (l.get("origin") or {}).get("kind", "human") == "human":
                t = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text") if isinstance(c, list) else ""
                command = re.search(r"<command-name>(/?[^<]+)</command-name>", t)
                if command:  # a slash command or skill the user ran: a strong habit signal
                    args = re.search(r"<command-args>(.*?)</command-args>", t, re.S)
                    users.append(f"{command.group(1)} {args.group(1) if args else ''}")
                elif "User request:" in t and "Skill: /" in t:  # Cloudroom's selected-skills wrapper
                    skills = " ".join(re.findall(r"Skill: (/[\w\-:]+)", t))
                    users.append(f"[{skills}] " + t.split("User request:", 1)[1])
                elif t.strip() and not t.lstrip().startswith(("<local-command", "Base directory for this skill:")):
                    users.append(t)
            elif l.get("type") == "assistant" and isinstance(c, list):
                t = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
                if t.strip():
                    reply = t
        r = record("claude-code", os.path.basename(path)[:-6], path, start, cwd, title, users, reply)
        if r and r["ts"] >= cutoff:
            yield r


def codex(cutoff):
    files = glob.glob(f"{H}/.codex/sessions/**/rollout-*.jsonl", recursive=True) + glob.glob(f"{H}/.codex/archived_sessions/**/rollout-*.jsonl", recursive=True)
    for path in files:
        if os.path.getmtime(path) < cutoff:
            continue
        users, reply, cwd, start, sid, origin = [], None, None, None, None, None
        for l in lines(path, keep=[b"session_meta", b"user_message", b"agent_message", b"UserMessage", b"AgentMessage"]):
            p = l.get("payload") or {}
            if l.get("type") == "session_meta":
                sid, cwd, origin = p.get("id"), p.get("cwd"), p.get("originator")
                start = parse_ts(p.get("timestamp") or l.get("timestamp"))
                continue
            if l.get("type") != "event_msg":
                continue
            item = p.get("item") if p.get("type") == "item_completed" else None
            if p.get("type") == "user_message":
                users.append(p.get("message") or "")
            elif item and item.get("type") == "UserMessage" and isinstance(item.get("content"), list):
                users.append(" ".join(x.get("text", "") for x in item["content"] if isinstance(x, dict)))
            elif p.get("type") == "agent_message":
                reply = p.get("message") or reply
            elif item and item.get("type") == "AgentMessage" and isinstance(item.get("content"), list):
                reply = " ".join(x.get("text", "") for x in item["content"] if isinstance(x, dict)) or reply
        r = record("codex", sid or os.path.basename(path), path, start, cwd, None, users, reply)
        if r and r["ts"] >= cutoff:
            if origin in ("codex_exec",):
                r["auto"], r["why"] = True, "codex exec"
            yield r


def text_of(content):
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except Exception:
            return content
    if isinstance(content, list):
        return " ".join(x.get("text", "") if isinstance(x, dict) else str(x) for x in content)
    return content if isinstance(content, str) else ""


def pi(cutoff):
    for path in glob.glob(f"{H}/.pi/agent/sessions/**/*.jsonl", recursive=True):
        if os.path.getmtime(path) < cutoff:
            continue
        users, reply, cwd, start, sid, title = [], None, None, None, None, None
        for l in lines(path):
            if l.get("type") == "session":
                sid, cwd, start = l.get("id"), l.get("cwd"), parse_ts(l.get("timestamp"))
            elif l.get("type") == "session_info" and l.get("name"):
                title = l["name"]
            elif l.get("type") == "message":
                m = l.get("message") or {}
                if m.get("role") == "user":
                    users.append(text_of(m.get("content")))
                elif m.get("role") == "assistant":
                    reply = text_of(m.get("content")) or reply
        r = record("pi", sid or path, path, start or os.path.getmtime(path), cwd, title, users, reply)
        if r and r["ts"] >= cutoff:
            yield r


def opencode(cutoff):
    path = f"{H}/.local/share/opencode/opencode.db"
    if not os.path.exists(path):
        return
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    for sid, cwd, title, created in db.execute("select id, directory, title, time_created from session where parent_id is null and time_created >= ?", (cutoff * 1000,)):
        users, reply = [], None
        for mid, data in db.execute("select id, data from message where session_id = ? order by time_created", (sid,)):
            role = (json.loads(data or "{}") or {}).get("role")
            parts = [json.loads(d or "{}") for (d,) in db.execute("select data from part where message_id = ? order by time_created", (mid,))]
            t = " ".join(p.get("text", "") for p in parts if p.get("type") == "text" and not p.get("synthetic"))
            if role == "user" and t.strip():
                users.append(t)
            elif role == "assistant" and t.strip():
                reply = t
        r = record("opencode", sid, path, parse_ts(created), cwd, title, users, reply)
        if r:
            yield r


def hermes(cutoff):
    path = f"{H}/.hermes/state.db"
    if not os.path.exists(path):
        return
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    cols = {r[1] for r in db.execute("PRAGMA table_info(sessions)")}
    opt = lambda c: f"s.{c}" if c in cols else "NULL"
    for sid, title, cwd in db.execute(f"select s.id, {opt('title')}, {opt('cwd')} from sessions s where s.source not in ('acp','cron','subagent','delegate')"):
        rows = list(db.execute("select role, content, timestamp from messages where session_id = ? and role in ('user','assistant') order by timestamp, id", (sid,)))
        if not rows or rows[0][2] < cutoff:
            continue
        users = [text_of(c) for role, c, _ in rows if role == "user"]
        reply = next((text_of(c) for role, c, _ in reversed(rows) if role == "assistant"), None)
        r = record("hermes", sid, path, rows[0][2], cwd, title, users, reply)
        if r:
            yield r


def load(out):
    with open(os.path.join(out, "index.jsonl")) as f:
        return [json.loads(l) for l in f]


def kept(chats):
    return [c for c in chats if not c["auto"] and len(" ".join(c["user"])) >= 15]


def chat_block(c, chars, full=False):
    head = f"### {c['id']} · {c['start']} · {c['agent']} · repo: {c['repo']} · {c['n_user']} msgs\ntitle: {c['title']}\n"
    budget, body = chars, []
    for i, u in enumerate(c["user"]):
        piece = cut(u, max(80, budget // 2) if i == 0 else min(300, budget))
        if budget <= 40:
            break
        body.append("> " + piece)
        budget -= len(piece)
    reply = f"\nlast agent reply: {cut(c['reply'], 400)}" if full and c["reply"] else ""
    return head + "\n".join(body) + reply + "\n"


def cmd_index(out, days=90):
    cutoff = time.time() - days * 86400
    os.makedirs(out, exist_ok=True)
    chats, counts, t0 = [], Counter(), time.time()
    for source in (claude, codex, pi, opencode, hermes):
        try:
            for r in source(cutoff):
                chats.append(r)
                counts[r["agent"]] += 1
        except Exception as e:
            counts[f"{source.__name__} error: {type(e).__name__}"] += 1
    templates = Counter(re.sub(r"\W+", " ", c["first"][:200].lower()) for c in chats if len(c["first"]) >= 300)
    for c in chats:
        key = re.sub(r"\W+", " ", c["first"][:200].lower())
        if not c["auto"] and len(c["first"]) >= 300 and templates[key] >= 3:
            c["auto"], c["why"] = True, "repeated template prompt"
    with open(os.path.join(out, "index.jsonl"), "w") as f:
        for c in sorted(chats, key=lambda c: c["ts"]):
            f.write(json.dumps(c) + "\n")
    keep = kept(chats)
    repeated = Counter(cut(c["first"], 100) for c in chats if c["auto"] and c["why"] == "repeated template prompt")
    stats = {"days": days, "seconds": round(time.time() - t0, 1), "chats": len(chats), "kept": len(keep), "by_agent": dict(counts),
             "auto": Counter(c["why"] for c in chats if c["auto"]), "kept_chars": sum(len(" ".join(c["user"])) for c in keep),
             "first": min((c["start"] for c in chats), default=None), "last": max((c["start"] for c in chats), default=None),
             "already_automated": repeated.most_common(15)}
    json.dump(stats, open(os.path.join(out, "stats.json"), "w"), indent=1)
    print(json.dumps(stats, indent=1))


def cmd_slices(out, n=30, chars=900, max_bytes=100_000):
    keep = sorted(kept(load(out)), key=lambda c: (c["repo"], c["ts"]))
    os.makedirs(os.path.join(out, "slices"), exist_ok=True)
    blocks = [chat_block(c, chars).encode() for c in keep]
    target = min(max_bytes, -(-sum(map(len, blocks)) // n))
    slices, current = [], b""
    for block in blocks:
        if current and len(current) + len(block) > target:
            slices.append(current)
            current = b""
        current += block
    slices += [current] if current else []
    for i, data in enumerate(slices, 1):
        with open(os.path.join(out, "slices", f"slice-{i:02d}.txt"), "wb") as f:
            f.write(data)
    print(f"{len(slices)} slices, {len(keep)} chats, {sum(map(len, slices))} bytes, largest {max(map(len, slices), default=0)}")


STOP = set("""the and for that this with you your are was have from not but all can will just what when how then they them there
here its it's into out about also some more make sure please need want let lets use using used like get got one two now new
should would could does did done want into over any each very really thing things file files code this that need also ok okay yes
dont don't can't cant im i'm i've ive we're were we've weve it you're youre thats that's whats what's
answer short shorter plain english concise verbose simple simpler format markdown readable newlines attached image images
first local other going create analyze check think look know everything something right still actually maybe without before
after these those which where their every while again today current currently working work works latest great good better best
help start started find found give make made take show tell said says able there's lot lots much many sure""".split())


def features(c):
    text = c["first"][:300]  # the task statement; later messages are mostly follow-ups and style
    low = text.lower()
    words = [w for w in re.findall(r"[a-z][a-z0-9\-]{2,}", low) if w not in STOP]
    feats = {f"cmd:{m}" for m in re.findall(r"(?<![\w/])/[a-z][a-z0-9\-]{2,}(?![\w/.\-])", low)}
    feats |= {f"{a} {b}" for a, b in zip(words, words[1:])}
    feats |= {w for w in words if len(w) >= 5}
    return feats


def cmd_groups(out, top=12, per=15, chars=2500):
    keep = kept(load(out))
    feats = {c["id"]: features(c) for c in keep}
    df, weeks = Counter(), defaultdict(set)
    for c in keep:
        for f in feats[c["id"]]:
            df[f] += 1
            weeks[f].add(time.strftime("%Y-%W", time.localtime(c["ts"])))
    cap = max(20, len(keep) // 25)  # phrases in more chats than this are style ("answer short"), not tasks
    score = {f: df[f] * len(weeks[f]) * (3 if f.startswith("cmd:") else 2 if " " in f else 0.7)
             for f in df if 6 <= df[f] <= cap and len(weeks[f]) >= 3}
    left, groups = {c["id"]: c for c in keep}, []
    for f in sorted(score, key=score.get, reverse=True):
        members = [c for c in left.values() if f in feats[c["id"]]]
        if len(members) >= 6:
            groups.append((f, members))
            for c in members:
                left.pop(c["id"])
        if len(groups) == top:
            break
    os.makedirs(os.path.join(out, "groups"), exist_ok=True)
    lines_out = []
    for i, (f, members) in enumerate(groups, 1):
        members.sort(key=lambda c: c["ts"])
        step = max(1, len(members) / per)
        sample = [members[int(k * step)] for k in range(min(per, len(members)))]
        wk = len({time.strftime("%Y-%W", time.localtime(c["ts"])) for c in members})
        repos = Counter(c["repo"] for c in members).most_common(3)
        head = f"group {i:02d} · key: {f} · {len(members)} chats over {wk} weeks · {members[0]['start']} to {members[-1]['start']} · repos: {repos}\n"
        lines_out.append(head.strip())
        with open(os.path.join(out, "groups", f"group-{i:02d}.txt"), "w") as fh:
            fh.write(head + f"all chat ids: {', '.join(c['id'] for c in members)}\n\n" + "\n".join(chat_block(c, chars, full=True) for c in sample))
    open(os.path.join(out, "groups", "overview.txt"), "w").write("\n".join(lines_out) + "\n")
    print("\n".join(lines_out))
    print(f"{len(keep) - len(left)} of {len(keep)} kept chats fall in these groups")


def cmd_sessions(out, ids, chars=6000):
    want = set(ids.split(","))
    for c in load(out):
        if c["id"] in want:
            print(chat_block(c, chars, full=True))


def cmd_reduce(out, top=25):
    index = {c["id"]: c for c in load(out)}
    tags, abouts = defaultdict(list), {}
    for path in sorted(glob.glob(os.path.join(out, "reports", "*.txt"))):
        for line in open(path, errors="ignore"):
            parts = [x.strip() for x in line.split("|")]
            if len(parts) >= 3 and parts[0] in index:
                abouts[parts[0]] = parts[1]
                for t in re.split(r"[,;]\s*", parts[2].lower()):
                    if t:
                        tags[t.strip()].append(parts[0])
    print(f"{len(abouts)} chats reported, {len(tags)} distinct tags")
    for t, ids in sorted(tags.items(), key=lambda kv: -len(kv[1]))[:top]:
        chats = sorted((index[i] for i in ids), key=lambda c: c["ts"])
        wk = len({time.strftime("%Y-%W", time.localtime(c["ts"])) for c in chats})
        repos = Counter(c["repo"] for c in chats).most_common(3)
        step = max(1, len(chats) / 6)
        examples = [chats[int(k * step)] for k in range(min(6, len(chats)))]
        print(f"\n## {t} · {len(chats)} chats · {wk} weeks · {chats[0]['start']} to {chats[-1]['start']} · repos {repos}")
        for c in examples:
            print(f"- {c['id']} {c['start']} {c['repo']}: {abouts[c['id']]}")
        print(f"  all ids: {','.join(c['id'] for c in chats)}")


if __name__ == "__main__":
    a = sys.argv[1:]
    opts = {a[i][2:]: a[i + 1] for i in range(2, len(a) - 1, 2) if a[i].startswith("--")}
    num = lambda k, d: int(opts.get(k, d))
    if a[0] == "index":
        cmd_index(a[1], num("days", 90))
    elif a[0] == "slices":
        cmd_slices(a[1], num("n", 30), num("chars", 900))
    elif a[0] == "groups":
        cmd_groups(a[1], num("top", 12), num("per", 15), num("chars", 2500))
    elif a[0] == "sessions":
        cmd_sessions(a[1], opts["ids"], num("chars", 6000))
    elif a[0] == "reduce":
        cmd_reduce(a[1], num("top", 25))
