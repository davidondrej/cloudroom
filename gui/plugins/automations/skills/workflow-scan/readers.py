#!/usr/bin/env python3
"""Workflow scan readers: one hidden cloud child of the lead per slice. Hidden children never wake their parent;
the sidebar shows them as one progress grid under the lead,
and each spawn and wait saves progress for the scan's progress card (room-cli loop scan-progress).

  readers.py spawn DIR PROVIDER MODEL  -> starts a reader per DIR/slices/slice-NN.txt, saving DIR/readers.json after each;
                                          run it again after a failure to start only the missing readers
  readers.py wait DIR [--max 540]      -> blocks until every reader is done or --max seconds pass; restarts a failed
                                          or archived reader once; prints "done" (and writes DIR/lines.txt, without chat IDs
                                          that are not in a reader's slice) or "running N/M"; a failed room-cli read is
                                          retried until --max, then it exits with the error
  readers.py archive DIR               -> archives every reader thread

Other scans reuse it (the Cyber scan): SCAN_READER_PROMPT, SCAN_TITLE and SCAN_READER_REASONING, set on spawn, replace
this folder's reader.md, "Workflow scan" and "low". They are saved in readers.json, so wait restarts readers the same way.
"""
import glob, hashlib, json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.environ.get("ROOM_PROJECT_ID") or "proj_personal"
WIN = sys.platform == "win32"
CLI = (shutil.which("room-cli") if WIN else None) or "room-cli"
ID = re.compile(r"(?<![A-Za-z0-9-])([a-z]-[0-9a-f]{8})(?![A-Za-z0-9])(?:, *| +)?")  # a chat ID as extract.py writes it, plus the separator after it
LEAD = re.compile(r"[\s#|*_`>\[(\d.)+-]*")  # markup before a chat line's own ID: headings, tables, lists, bold, code


def cli(*args, check=False):
    # Windows: subprocess can't start room-cli.cmd by bare name, and cmd.exe would re-parse its arguments
    # (cutting a prompt at its first newline). room-cli reads them from ROOM_CLI_ARGV instead, like room-cli.ps1 passes them.
    env = {**os.environ, "ROOM_CLI_ARGV": json.dumps(args)} if WIN else None
    return subprocess.run([CLI] if WIN else [CLI, *args], env=env, check=check, capture_output=True, encoding="utf-8", errors="replace")


def room(*args):
    return json.loads(cli(*args, "--json", check=True).stdout)


def read(errors, *args):
    """wait()'s room-cli reads. A failed one (a timeout, a busy app) returns None and adds to errors: the next pass tries
    again, and it never counts as a failed reader, so it never restarts or archives one (#2157)."""
    try:
        return room(*args)
    except (subprocess.CalledProcessError, ValueError) as e:
        errors.append(((getattr(e, "stderr", None) or "").strip() or str(e)).splitlines()[-1])


def load(d):
    return json.load(open(os.path.join(d, "readers.json")))


def save(d, state):
    path = os.path.join(d, "readers.json")
    with open(path + ".tmp", "w") as f:
        json.dump(state, f, indent=1)
    os.replace(path + ".tmp", path)


def report(d, state, stage):
    if not os.environ.get("ROOM_THREAD_ID"):
        return
    try:
        progress = json.load(open(os.path.join(d, "slices", "progress.json")))
    except (OSError, ValueError):
        return
    finished = [n for n, r in state["readers"].items() if "output" in r]
    read = [0] * len(progress["days"])
    for n in finished:
        for day, count in progress["slices"].get(n, {}).items():
            read[int(day)] += count
    data = {"stage": stage, "chats": progress["chats"], "days": progress["days"], "read": read,
            "readers": len(state["readers"]), "readersDone": len(finished), "secrets": progress["secrets"]}
    cli("loop", "scan-progress", "--data=" + json.dumps(data))


def start(d, state, n):
    prompt = open(state.get("prompt") or os.path.join(HERE, "reader.md"), encoding="utf-8").read() + open(os.path.join(d, "slices", f"slice-{n}.txt"), encoding="utf-8").read()
    prompt_args = ["--prompt", prompt]
    if WIN:  # too long for ROOM_CLI_ARGV (32K); room-cli reads the file back as UTF-8
        prompt_args = ["--prompt-file", os.path.join(d, "slices", f"prompt-{n}.txt")]
        with open(prompt_args[1], "wb") as f:
            f.write(prompt.encode())
    parent = ["--parent-self"] if os.environ.get("ROOM_THREAD_ID") else []
    tries = state["readers"].get(n, {}).get("tries", 0) + 1
    request = f"scan-{hashlib.sha1(os.path.abspath(d).encode()).hexdigest()[:12]}-{n}-{tries}"
    thread = room("thread", "spawn", *parent, "--request-id", request, "--visibility", "hidden", "--project", PROJECT, "--machine", "cloud", "--provider", state["provider"],
                  "--model", state["model"], "--reasoning-level", state.get("reasoning") or "low", "--title", f"{state.get('title') or 'Workflow scan'} · reader {n}", *prompt_args)
    state["readers"][n] = {"id": thread["id"], "tries": tries}
    state["all"].append(thread["id"])


def spawn(d, provider, model):
    started = os.path.exists(os.path.join(d, "readers.json"))
    state = load(d) if started else {"provider": provider, "model": model, "readers": {}, "all": [],
                                     "prompt": os.environ.get("SCAN_READER_PROMPT"), "title": os.environ.get("SCAN_TITLE"),
                                     "reasoning": os.environ.get("SCAN_READER_REASONING")}
    for path in sorted(glob.glob(os.path.join(d, "slices", "slice-*.txt"))):
        n = os.path.basename(path)[6:-4]
        if n not in state["readers"]:
            start(d, state, n)
            save(d, state)
    report(d, state, "reading")
    print(f"{len(state['readers'])} readers started")


def slice_ids(d, n):
    try:
        return set(re.findall(r"^### ([a-z]-[0-9a-f]{8}) ", open(os.path.join(d, "slices", f"slice-{n}.txt"), encoding="utf-8").read(), re.M))
    except (OSError, ValueError):
        return set()


def drop_invented(output, ids):
    """Removes chat IDs that are not in the reader's slice, and lines about such a chat (the IDs it starts with, after
    markup only, are all invented); changes nothing else."""
    if not ids:
        return output, 0
    kept, invented = [], set()
    for line in output.split("\n"):
        found = list(ID.finditer(line))
        bad = {m[1] for m in found if m[1] not in ids}
        invented |= bad
        if not bad:
            kept.append(line)
            continue
        own = found[:1]  # the IDs the line starts with: a real chat among them keeps the line
        for m in found[1:]:
            if m.start() != own[-1].end():
                break
            own.append(m)
        if not (LEAD.fullmatch(line, 0, found[0].start()) and all(m[1] in bad for m in own)):
            kept.append(ID.sub(lambda m: m[0] if m[1] in ids else "", line).rstrip(", "))
    return "\n".join(kept).strip(), len(invented)


def heading(d, state, n):
    """Other scans' answers name what they read (their slice's first line), so the lead knows which repo a finding is
    from. Workflow scan lines already carry chat IDs, so they get none."""
    if not state.get("title"):
        return ""
    try:
        return "### " + open(os.path.join(d, "slices", f"slice-{n}.txt"), encoding="utf-8").readline().strip() + "\n"
    except OSError:
        return f"### reader {n}\n"


def wait(d, limit=540):
    state, end = load(d), time.time() + limit
    while True:
        errors = []
        threads = read(errors, "thread", "list", "--project", PROJECT, "--include-hidden")
        status = {t["id"]: t["status"] for t in threads or []}
        for n, r in list(state["readers"].items()):
            if errors or time.time() > end:  # a stalled app makes every read wait out its 45 s timeout: end the pass
                break
            now = status.get(r["id"], "error")
            if "output" in r or now not in ("idle", "error"):
                continue
            got = read(errors, "thread", "output", r["id"]) if now == "idle" else {}
            if got is None:
                continue
            output = (got.get("output") or "").strip()
            if " | " in output or r["tries"] >= 2:
                r["output"], r["invented"] = drop_invented(output, slice_ids(d, n))
            else:
                cli("thread", "archive", r["id"])
                start(d, state, n)
        save(d, state)
        done = sum("output" in r for r in state["readers"].values())
        if not errors:  # its own retries would add ~50 s to a stalled pass
            report(d, state, "patterns" if done == len(state["readers"]) else "reading")
        if done == len(state["readers"]):
            with open(os.path.join(d, "lines.txt"), "w", encoding="utf-8") as f:
                f.write("\n\n".join(heading(d, state, n) + r["output"] for n, r in state["readers"].items() if r["output"]))
            failed = [n for n, r in state["readers"].items() if not r["output"]]
            invented = [f"{n} ({r['invented']})" for n, r in state["readers"].items() if r.get("invented")]
            return print("done" + (f", no output from readers {', '.join(failed)}" if failed else "")
                         + (f", dropped invented chat IDs from readers {', '.join(invented)}" if invented else ""))
        if time.time() + 20 > end:  # the next pass would start past --max
            running = f"running {done}/{len(state['readers'])}"
            if errors:
                sys.exit(f"{running}. room-cli could not read the readers ({errors[-1]}). They keep working: run wait again.")
            return print(running)
        time.sleep(20)


def archive(d):
    for thread_id in load(d)["all"]:
        cli("thread", "archive", thread_id)


if __name__ == "__main__":
    cmd, d, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
    if cmd == "spawn":
        spawn(d, *rest)
    elif cmd == "wait":
        wait(d, int(rest[1]) if rest[:1] == ["--max"] else 540)
    else:
        archive(d)
