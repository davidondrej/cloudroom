#!/usr/bin/env python3
"""Workflow scan readers: one hidden cloud child of the lead per slice. Hidden children never wake their parent;
the sidebar shows them as one progress grid under the lead,
and each spawn and wait saves progress for the scan's progress card (room-cli loop scan-progress).

  readers.py spawn DIR PROVIDER MODEL  -> starts a reader per DIR/slices/slice-NN.txt, saving DIR/readers.json after each;
                                          run it again after a failure to start only the missing readers
  readers.py wait DIR [--max 540]      -> blocks until every reader is done or --max seconds pass; restarts a failed
                                          or archived reader once; prints "done" (and writes DIR/lines.txt) or "running N/M"
  readers.py archive DIR               -> archives every reader thread
"""
import glob, hashlib, json, os, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.environ.get("ROOM_PROJECT_ID") or "proj_personal"
WIN = sys.platform == "win32"
CLI = (shutil.which("room-cli") if WIN else None) or "room-cli"


def cli(*args, check=False):
    # Windows: subprocess can't start room-cli.cmd by bare name, and cmd.exe would re-parse its arguments
    # (cutting a prompt at its first newline). room-cli reads them from ROOM_CLI_ARGV instead, like room-cli.ps1 passes them.
    env = {**os.environ, "ROOM_CLI_ARGV": json.dumps(args)} if WIN else None
    return subprocess.run([CLI] if WIN else [CLI, *args], env=env, check=check, capture_output=True, encoding="utf-8", errors="replace")


def room(*args):
    return json.loads(cli(*args, "--json", check=True).stdout)


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
    prompt = open(os.path.join(HERE, "reader.md"), encoding="utf-8").read() + open(os.path.join(d, "slices", f"slice-{n}.txt"), encoding="utf-8").read()
    prompt_args = ["--prompt", prompt]
    if WIN:  # too long for ROOM_CLI_ARGV (32K); room-cli reads the file back as UTF-8
        prompt_args = ["--prompt-file", os.path.join(d, "slices", f"prompt-{n}.txt")]
        with open(prompt_args[1], "wb") as f:
            f.write(prompt.encode())
    parent = ["--parent-self"] if os.environ.get("ROOM_THREAD_ID") else []
    tries = state["readers"].get(n, {}).get("tries", 0) + 1
    request = f"scan-{hashlib.sha1(os.path.abspath(d).encode()).hexdigest()[:12]}-{n}-{tries}"
    thread = room("thread", "spawn", *parent, "--request-id", request, "--visibility", "hidden", "--project", PROJECT, "--machine", "cloud", "--provider", state["provider"],
                  "--model", state["model"], "--reasoning-level", "low", "--title", f"Workflow scan · reader {n}", *prompt_args)
    state["readers"][n] = {"id": thread["id"], "tries": tries}
    state["all"].append(thread["id"])


def spawn(d, provider, model):
    started = os.path.exists(os.path.join(d, "readers.json"))
    state = load(d) if started else {"provider": provider, "model": model, "readers": {}, "all": []}
    for path in sorted(glob.glob(os.path.join(d, "slices", "slice-*.txt"))):
        n = os.path.basename(path)[6:-4]
        if n not in state["readers"]:
            start(d, state, n)
            save(d, state)
    report(d, state, "reading")
    print(f"{len(state['readers'])} readers started")


def wait(d, limit=540):
    state, end = load(d), time.time() + limit
    while True:
        status = {t["id"]: t["status"] for t in room("thread", "list", "--project", PROJECT, "--include-hidden")}
        for n, r in list(state["readers"].items()):
            now = status.get(r["id"], "error")
            if "output" in r or now not in ("idle", "error"):
                continue
            output = (room("thread", "output", r["id"]).get("output") or "").strip() if now == "idle" else ""
            if " | " in output or r["tries"] >= 2:
                r["output"] = output
            else:
                cli("thread", "archive", r["id"])
                start(d, state, n)
        save(d, state)
        done = sum("output" in r for r in state["readers"].values())
        report(d, state, "patterns" if done == len(state["readers"]) else "reading")
        if done == len(state["readers"]):
            with open(os.path.join(d, "lines.txt"), "w", encoding="utf-8") as f:
                f.write("\n\n".join(r["output"] for r in state["readers"].values() if r["output"]))
            failed = [n for n, r in state["readers"].items() if not r["output"]]
            return print("done" + (f", no output from readers {', '.join(failed)}" if failed else ""))
        if time.time() > end:
            return print(f"running {done}/{len(state['readers'])}")
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
