#!/usr/bin/env python3
"""Workflow scan readers: one cloud thread per slice, never linked to the lead, so finished readers don't wake it.

  readers.py spawn DIR PROVIDER MODEL  -> starts a reader per DIR/slices/slice-NN.txt, saves DIR/readers.json
  readers.py wait DIR [--max 540]      -> blocks until every reader is done or --max seconds pass; restarts a failed
                                          or archived reader once; prints "done" (and writes DIR/lines.txt) or "running N/M"
  readers.py archive DIR               -> archives every reader thread
"""
import glob, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.environ.get("ROOM_PROJECT_ID") or "proj_personal"


def room(*args):
    return json.loads(subprocess.run(["room-cli", *args, "--json"], check=True, capture_output=True, text=True).stdout)


def load(d):
    return json.load(open(os.path.join(d, "readers.json")))


def save(d, state):
    json.dump(state, open(os.path.join(d, "readers.json"), "w"), indent=1)


def start(d, state, n):
    prompt = open(os.path.join(HERE, "reader.md")).read() + open(os.path.join(d, "slices", f"slice-{n}.txt")).read()
    thread = room("thread", "spawn", "--project", PROJECT, "--machine", "cloud", "--provider", state["provider"],
                  "--model", state["model"], "--reasoning-level", "low", "--title", f"Workflow scan · reader {n}", "--prompt", prompt)
    state["readers"][n] = {"id": thread["id"], "tries": state["readers"].get(n, {}).get("tries", 0) + 1}
    state["all"].append(thread["id"])


def spawn(d, provider, model):
    state = {"provider": provider, "model": model, "readers": {}, "all": []}
    for path in sorted(glob.glob(os.path.join(d, "slices", "slice-*.txt"))):
        start(d, state, os.path.basename(path)[6:-4])
    save(d, state)
    print(f"{len(state['readers'])} readers started")


def wait(d, limit=540):
    state, end = load(d), time.time() + limit
    while True:
        status = {t["id"]: t["status"] for t in room("thread", "list", "--project", PROJECT)}
        for n, r in list(state["readers"].items()):
            now = status.get(r["id"], "error")
            if "output" in r or now not in ("idle", "error"):
                continue
            output = (room("thread", "output", r["id"]).get("output") or "").strip() if now == "idle" else ""
            if " | " in output or r["tries"] >= 2:
                r["output"] = output
            else:
                start(d, state, n)
        save(d, state)
        done = sum("output" in r for r in state["readers"].values())
        if done == len(state["readers"]):
            with open(os.path.join(d, "lines.txt"), "w") as f:
                f.write("\n\n".join(r["output"] for r in state["readers"].values() if r["output"]))
            failed = [n for n, r in state["readers"].items() if not r["output"]]
            return print("done" + (f", no output from readers {', '.join(failed)}" if failed else ""))
        if time.time() > end:
            return print(f"running {done}/{len(state['readers'])}")
        time.sleep(20)


def archive(d):
    for thread_id in load(d)["all"]:
        subprocess.run(["room-cli", "thread", "archive", thread_id], capture_output=True)


if __name__ == "__main__":
    cmd, d, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
    if cmd == "spawn":
        spawn(d, *rest)
    elif cmd == "wait":
        wait(d, int(rest[1]) if rest[:1] == ["--max"] else 540)
    else:
        archive(d)
