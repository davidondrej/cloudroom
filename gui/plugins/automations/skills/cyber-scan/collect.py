#!/usr/bin/env python3
"""Cyber scan collector: read-only facts about this computer and its active repos, for the cyber-scan lead.

  collect.py DIR [--days 30] [--max-repos 60] [--max-github 10] [--max-readers 8]
    -> DIR/summary.md                what the lead reads
       DIR/findings.json             everything, structured
       DIR/slices/slice-NN.txt       one per GitHub repo, for the cloud readers (readers.py)
       DIR/slices/progress.json      for the progress card

Reads metadata only: never prints or saves a secret value. Only advisory lookups leave this computer: package names
and versions go to OSV (api.osv.dev), and the threat lists come from CISA's list on GitHub and GitHub's advisories.
"""
import base64, calendar, concurrent.futures, glob, json, math, os, platform, plistlib, re, shutil, subprocess, sys, time
import urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "workflow-scan"))
from readers import cli  # room-cli that also starts on Windows (room-cli.cmd, arguments in ROOM_CLI_ARGV)

HOME = os.path.expanduser("~")
UA = {"User-Agent": "cloudroom-cyber-scan"}
ROOTS = ["code", "Code", "Developer", "Documents/code", "Documents/GitHub", "GitHub", "projects", "Projects", "src", "dev",
         "work", "repos", "source/repos"]
SKIP_DIRS = {"node_modules", "Library", ".cache", "vendor", "target", "dist", "build", ".venv", "venv", ".Trash"}


def run(args, timeout=30, env=None):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout, errors="replace",
                           env={**os.environ, **(env or {})})
        return (p.stdout + p.stderr).strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def fetch(url, data=None, timeout=30):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers={**UA, **({"Content-Type": "application/json"} if body else {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def mode(path):
    try:
        return oct(os.stat(path).st_mode & 0o777)[2:]
    except OSError:
        return None


# ---------- this computer ----------

def mac():
    f = {"os": platform.platform(), "arch": platform.machine()}
    if sys.platform != "darwin":
        return f
    f["macos"] = f"{run(['sw_vers', '-productVersion'])} ({run(['sw_vers', '-buildVersion'])})"
    f["filevault"] = run(["fdesetup", "status"]).splitlines()[:1]
    fw = "/usr/libexec/ApplicationFirewall/socketfilterfw"
    f["firewall"] = run([fw, "--getglobalstate"])
    f["stealth"] = run([fw, "--getstealthmode"])
    f["gatekeeper"] = run(["spctl", "--status"])
    f["sip"] = run(["csrutil", "status"])
    try:
        su = plistlib.load(open("/Library/Preferences/com.apple.SoftwareUpdate.plist", "rb"))
        f["auto_updates"] = {k: su.get(k) for k in ("AutomaticCheckEnabled", "AutomaticDownload", "AutomaticallyInstallMacOSUpdates",
                                                    "CriticalUpdateInstall", "ConfigDataInstall")}
    except (OSError, plistlib.InvalidFileException, ValueError):
        f["auto_updates"] = None
    f["pending_updates"] = [l.strip("* ").strip() for l in run(["softwareupdate", "--list"], timeout=150).splitlines()
                            if "Label:" in l or "Title:" in l][:12]
    f["apps"] = apps()
    f["exposed_ports"], f["loopback_ports"] = listening()
    f["startup_items"] = startup_items()
    f["secret_files"] = secret_files()
    f["brew_outdated"] = brew()
    return f


def apps():
    found = []
    for path in sorted(glob.glob("/Applications/*.app") + glob.glob(os.path.join(HOME, "Applications/*.app"))):
        try:
            info = plistlib.load(open(os.path.join(path, "Contents/Info.plist"), "rb"))
        except (OSError, plistlib.InvalidFileException, ValueError):
            continue
        found.append(f"{os.path.basename(path)[:-4]} {info.get('CFBundleShortVersionString') or info.get('CFBundleVersion') or '?'}")
    return found


APPLE_DAEMONS = {"rapportd", "sharingd", "ControlCe", "ControlCenter", "AirPlayXPCHelper", "identityservicesd", "remoted"}


def listening():
    exposed, loopback, cmd = set(), 0, ""
    for line in run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "cn"]).splitlines():
        if line.startswith("c"):
            cmd = line[1:]
        elif line.startswith("n"):
            host = line[1:].rsplit(":", 1)[0]
            if host in ("127.0.0.1", "[::1]", "localhost") or host.startswith("127."):
                loopback += 1
            elif cmd not in APPLE_DAEMONS:
                exposed.add(f"{cmd} on {line[1:]}")
    return sorted(exposed)[:30], loopback


def startup_items():
    items = []
    for folder in (os.path.join(HOME, "Library/LaunchAgents"), "/Library/LaunchAgents", "/Library/LaunchDaemons"):
        for path in sorted(glob.glob(os.path.join(folder, "*.plist"))):
            if os.path.basename(path).startswith("com.apple."):
                continue
            try:
                p = plistlib.load(open(path, "rb"))
                program = p.get("Program") or (p.get("ProgramArguments") or ["?"])[0]
            except (OSError, plistlib.InvalidFileException, ValueError):
                program = "unreadable"
            items.append(f"{path.replace(HOME, '~')} -> {program}")
    return items[:60]


def ssh_key_encrypted(path):
    """True/False from the key's header only; the key itself is never printed or saved."""
    try:
        text = open(path, encoding="utf-8", errors="replace").read(65536)
    except OSError:
        return None
    if "BEGIN OPENSSH PRIVATE KEY" in text:
        body = "".join(l for l in text.splitlines() if l and not l.startswith("-----"))
        try:
            raw = base64.b64decode(body[:200] + "=" * (-len(body[:200]) % 4))
            n = int.from_bytes(raw[15:19], "big")
            return raw[19:19 + n] != b"none"
        except (ValueError, IndexError):
            return None
    if "PRIVATE KEY-----" in text:
        return "ENCRYPTED" in text[:400]
    return None


def secret_files():
    out = []
    for rel in (".aws/credentials", ".netrc", ".git-credentials", ".npmrc", ".pypirc", ".docker/config.json", ".kube/config",
                ".config/gh/hosts.yml"):
        path = os.path.join(HOME, rel)
        if not os.path.isfile(path):
            continue
        m = mode(path)
        notes = []
        if m and m[1:] != "00":
            notes.append(f"readable by others ({m})")
        if rel in (".npmrc", ".git-credentials", ".netrc", ".pypirc"):
            try:
                text = open(path, encoding="utf-8", errors="replace").read(65536)
                if re.search(r"_authToken|password|https://[^:\s]+:[^@\s]+@", text):
                    notes.append("plain-text token or password")
            except OSError:
                pass
        out.append(f"~/{rel}" + (": " + ", ".join(notes) if notes else ": ok"))
    for path in sorted(glob.glob(os.path.join(HOME, ".ssh/*"))):
        name = os.path.basename(path)
        if name.endswith(".pub") or name in ("known_hosts", "known_hosts.old", "config", "authorized_keys") or not os.path.isfile(path):
            continue
        enc = ssh_key_encrypted(path)
        if enc is None:
            continue
        m = mode(path)
        notes = ([] if enc else ["no passphrase"]) + ([f"readable by others ({m})"] if m and m[1:] != "00" else [])
        out.append(f"~/.ssh/{name}" + (": " + ", ".join(notes) if notes else ": ok"))
    return out


def brew():
    if not shutil.which("brew"):
        return None
    try:
        data = json.loads(run(["brew", "outdated", "--json=v2"], timeout=120, env={"HOMEBREW_NO_AUTO_UPDATE": "1"}) or "{}")
    except ValueError:
        return None
    items = [f"{x['name']} {','.join(x.get('installed_versions', []))} -> {x.get('current_version')}"
             for kind in ("formulae", "casks") for x in data.get(kind, [])]
    return {"count": len(items), "items": items[:40]}


# ---------- repos ----------

def git(repo, *args, timeout=30):
    return run(["git", "-C", repo, *args], timeout=timeout)


def github_name(url):
    m = re.search(r"github\.com[:/]([^/\s]+/[^/\s]+?)(?:\.git)?/?$", url or "")
    return m.group(1) if m else None


def local_repos():
    paths, seen = set(), set()
    for root in [os.path.join(HOME, r) for r in ROOTS]:
        try:  # macOS folders are case-insensitive: ~/Code and ~/code can be the same folder
            key = (os.stat(root).st_dev, os.stat(root).st_ino)
        except OSError:
            continue
        if key in seen or not os.path.isdir(root):
            continue
        seen.add(key)
        for top, dirs, _ in os.walk(root):
            if os.path.exists(os.path.join(top, ".git")):  # keep walking: a repo can hold other repos
                paths.add(os.path.realpath(top))
            if top.count(os.sep) - root.count(os.sep) >= 3:
                dirs[:] = []
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
    error = None
    try:  # Cloudroom's own projects are the user's repos too; a failed lookup is not an empty list (#2345)
        out = cli("project", "list", "--json", timeout=30)
        if out.returncode:
            raise OSError(((out.stderr or "").strip() or f"exit code {out.returncode}").splitlines()[-1])
        for p in json.loads(out.stdout):
            for src in p.get("sources") or [] if isinstance(p, dict) else []:
                path = src.get("type") == "local_path" and src.get("path")
                if path and os.path.exists(os.path.join(path, ".git")):  # only folders on this computer
                    paths.add(os.path.realpath(path))
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, AttributeError) as e:
        error = f"Cloudroom's project list: failed to load ({e}), so project repos outside the usual code folders were not checked"
    return sorted(paths), error


def active_repos(days, limit, limit_github):
    cutoff = time.time() - days * 86400
    repos = {}
    paths, error = local_repos()
    for path in paths:
        last = git(path, "for-each-ref", "--sort=-committerdate", "--count=1", "--format=%(committerdate:unix)", "refs/heads")
        if not last.isdigit() or int(last) < cutoff:
            continue
        name = github_name(git(path, "remote", "get-url", "origin"))
        if name in repos and os.path.isfile(os.path.join(path, ".git")):  # keep the main checkout, not a worktree
            continue
        repos[name or path] = {"name": name or os.path.basename(path), "github": name, "path": path, "last": int(last)}
    if shutil.which("gh"):
        try:
            for r in json.loads(run(["gh", "api", "user/repos?sort=pushed&per_page=50&affiliation=owner,collaborator,organization_member"]) or "[]"):
                pushed = calendar.timegm(time.strptime(r["pushed_at"], "%Y-%m-%dT%H:%M:%SZ"))
                if pushed >= cutoff and r["full_name"] not in repos and not r.get("archived"):
                    repos[r["full_name"]] = {"name": r["full_name"], "github": r["full_name"], "path": None, "last": int(pushed),
                                             "private": r.get("private")}
        except (ValueError, KeyError, TypeError):
            pass
    # Every local repo active in the window; GitHub-only repos are capped (most recently pushed first).
    local = sorted((r for r in repos.values() if r["path"]), key=lambda r: -r["last"])
    remote = sorted((r for r in repos.values() if not r["path"]), key=lambda r: -r["last"])
    kept = local[:limit] + remote[:limit_github]
    return kept, len(repos) - len(kept), error


def commit_days(repo):
    first = time.mktime(time.strptime(time.strftime("%Y-%m-%d"), "%Y-%m-%d")) - 90 * 86400
    days = [0] * 91
    stamps = git(repo["path"], "log", "--all", "--since=91.days", "--format=%ct").split() if repo["path"] else [str(repo["last"])]
    for ts in stamps[:20000]:
        i = int((int(ts) - first) // 86400) if ts.isdigit() else -1
        if 0 <= i < 91:
            days[i] += 1
    return days


# ---------- packages ----------

MAX_ADVISORIES = 1000
LOCKFILES = {"package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "Cargo.lock", "go.sum",
             "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock"}


def parse_lockfile(name, text):
    out = []
    if name in ("package-lock.json", "npm-shrinkwrap.json"):
        data = json.loads(text)
        for key, v in (data.get("packages") or {}).items():
            if key and isinstance(v, dict) and v.get("version") and not v.get("link"):
                out.append(("npm", v.get("name") or key.split("node_modules/")[-1], v["version"]))
        if not data.get("packages"):
            stack = [data.get("dependencies") or {}]
            while stack:
                for n, v in stack.pop().items():
                    out.append(("npm", n, v.get("version", "")))
                    stack.append(v.get("dependencies") or {})
    elif name == "pnpm-lock.yaml":
        section = ""
        for line in text.splitlines():
            if line and not line[0].isspace():
                section = line.rstrip(":")
            elif section in ("packages", "snapshots"):
                m = re.match(r"^  ['\"]?/?(@?[^@/\s'\"]+(?:/[^@/\s'\"]+)?)[@/](\d[^\s:'\"(_]*)", line)
                if m:
                    out.append(("npm", m.group(1), m.group(2)))
    elif name == "yarn.lock":
        header = None
        for line in text.splitlines():
            if line and not line[0].isspace() and line.endswith(":") and not line.startswith(("#", "__metadata")):
                first = line.rstrip(":").split(",")[0].strip().strip('"')
                header = first[:first.index("@", 1)] if "@" in first[1:] else None
                if "@workspace:" in line or "@patch:" in line or "@link:" in line:
                    header = None
            m = header and re.match(r'^\s+version:?\s+"?([^"\s]+)"?', line)
            if m:
                out.append(("npm", header, m.group(1)))
                header = None
    elif name == "bun.lock":
        for m in re.finditer(r'^\s*"[^"]+":\s*\["((?:@[^@"/]+/)?[^@"]+)@([^"]+)"', text, re.M):
            if re.match(r"\d", m.group(2)):
                out.append(("npm", m.group(1), m.group(2)))
    elif name in ("Cargo.lock", "poetry.lock", "uv.lock"):
        eco = "crates.io" if name == "Cargo.lock" else "PyPI"
        for block in text.split("[[package]]")[1:]:
            n, v = re.search(r'^name = "([^"]+)"', block, re.M), re.search(r'^version = "([^"]+)"', block, re.M)
            local = re.search(r"^source = \{ (?:editable|virtual|path)", block, re.M) or (eco == "crates.io" and "\nsource = " not in block)
            if n and v and not local:
                out.append((eco, n.group(1), v.group(1)))
    elif name == "go.sum":
        for line in text.splitlines():
            parts = line.split()
            if len(parts) >= 2 and not parts[1].endswith("/go.mod"):
                out.append(("Go", parts[0], parts[1].lstrip("v").split("+")[0]))
    elif name == "Gemfile.lock":
        for m in re.finditer(r"^    (\S+) \(([^)\s]+)\)$", text, re.M):
            out.append(("RubyGems", m.group(1), m.group(2).split("-")[0]))
    elif name == "composer.lock":
        data = json.loads(text)
        for p in (data.get("packages") or []) + (data.get("packages-dev") or []):
            out.append(("Packagist", p["name"], str(p.get("version", "")).lstrip("v")))
    return out


REGISTRY_VERSION = re.compile(r"^\d[0-9A-Za-z.+_~-]{0,63}$")
NOT_REGISTRY = re.compile(r"://|^(git\+|file:|link:|workspace:|github:|npm:)|\s|@.*:")


def registry_package(pkg):
    """True for a package from a public registry, as plain name and version. URLs and git or file sources
    never leave this computer: they can hold tokens."""
    eco, name, version = pkg
    return bool(REGISTRY_VERSION.match(version)) and not NOT_REGISTRY.search(name) and len(name) < 215


def requirements(text):
    return [("PyPI", m.group(1), m.group(2)) for m in re.finditer(r"^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?==([^\s;#]+)", text, re.M)]


def repo_packages(path):
    found = set()
    for rel in git(path, "ls-files").splitlines():
        base = os.path.basename(rel)
        if re.search(r"(^|/)(node_modules|vendor|fixtures?|testdata|__fixtures__)/", rel):
            continue
        is_req = re.match(r"requirements[\w.\-]*\.txt$", base)
        if base not in LOCKFILES and not is_req:
            continue
        try:
            text = open(os.path.join(path, rel), encoding="utf-8", errors="replace").read()
            found.update((e, n, v) for e, n, v in (requirements(text) if is_req else parse_lockfile(base, text)) if n and v)
        except (OSError, ValueError, KeyError, AttributeError):
            continue
    return sorted(found)[:8000]


# ---------- advisories ----------

def roundup(x):
    i = round(x * 100000)
    return i / 100000.0 if i % 10000 == 0 else (math.floor(i / 10000) + 1) / 10.0


def cvss3(vector):
    m = dict(p.split(":", 1) for p in vector.split("/")[1:] if ":" in p)
    try:
        changed = m["S"] == "C"
        av = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}[m["AV"]]
        ac = {"L": 0.77, "H": 0.44}[m["AC"]]
        pr = ({"N": 0.85, "L": 0.68, "H": 0.5} if changed else {"N": 0.85, "L": 0.62, "H": 0.27})[m["PR"]]
        ui = {"N": 0.85, "R": 0.62}[m["UI"]]
        cia = [{"H": 0.56, "L": 0.22, "N": 0}[m[k]] for k in ("C", "I", "A")]
    except KeyError:
        return None
    iss = 1 - (1 - cia[0]) * (1 - cia[1]) * (1 - cia[2])
    impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 if changed else 6.42 * iss
    if impact <= 0:
        return 0.0
    expl = 8.22 * av * ac * pr * ui
    return roundup(min((1.08 if changed else 1) * (impact + expl), 10))


def label(score):
    return None if score is None else "CRITICAL" if score >= 9 else "HIGH" if score >= 7 else "MEDIUM" if score >= 4 else "LOW"


def vuln_details(vid):
    try:
        v = retry(lambda: fetch(f"https://api.osv.dev/v1/vulns/{vid}"))
    except (OSError, ValueError):
        return {"id": vid, "failed": True}
    if v.get("withdrawn"):
        return None
    score = None
    for s in v.get("severity") or []:
        if s.get("type") == "CVSS_V3" and score is None:
            score = cvss3(s.get("score", ""))
    sev = label(score) or {"MODERATE": "MEDIUM"}.get(str((v.get("database_specific") or {}).get("severity", "")).upper(),
                                                      str((v.get("database_specific") or {}).get("severity", "")).upper() or None)
    ranges = {}
    for a in v.get("affected") or []:
        name = (a.get("package") or {}).get("name")
        for r in a.get("ranges") or []:
            if r.get("type") == "GIT":
                continue
            start = None
            for e in r.get("events") or []:
                if "introduced" in e:
                    start = e["introduced"]
                elif "fixed" in e or "last_affected" in e:
                    ranges.setdefault(name, []).append((start or "0", e.get("fixed")))
                    start = None
            if start is not None:
                ranges.setdefault(name, []).append((start, None))
    cve = next((x for x in v.get("aliases") or [] if x.startswith("CVE-")), vid if vid.startswith("CVE-") else None)
    return {"id": vid, "cve": cve, "score": score, "severity": sev, "summary": (v.get("summary") or v.get("details") or "")[:160],
            "ranges": ranges}


def version_key(version):
    m = re.match(r"v?(\d+(?:\.\d+)*)", str(version or ""))
    if not m:
        return None
    parts = [int(x) for x in m.group(1).split(".")[:4]]
    return tuple(parts + [0] * (4 - len(parts)))


def fix_for(ranges, version):
    """The fixed version of the range the installed version falls in; else the lowest fix above it; else None."""
    have = version_key(version)
    if have is None:
        return None
    fixes = [(version_key(fixed), fixed) for start, fixed in ranges if fixed and version_key(fixed)]
    for start, fixed in ranges:
        low, high = version_key(start) or (0, 0, 0, 0), version_key(fixed) if fixed else None
        if low <= have and (high is None or have < high):
            return fixed if high else None
    above = sorted(f for f in fixes if f[0] > have)
    return above[0][1] if above else None


def retry(call):
    try:
        return call()
    except (OSError, ValueError):
        time.sleep(2)
        return call()


def osv(packages):
    """packages: [(eco, name, version)] -> ({(eco, name, version): [vuln ids]}, packages not checked)"""
    hits, failed = {}, 0
    for i in range(0, len(packages), 1000):
        chunk = packages[i:i + 1000]
        try:
            res = retry(lambda: fetch("https://api.osv.dev/v1/querybatch", {"queries": [
                {"package": {"ecosystem": e, "name": n}, "version": v} for e, n, v in chunk]}, timeout=60))
        except (OSError, ValueError):
            failed += len(chunk)
            continue
        for pkg, r in zip(chunk, res.get("results") or []):
            ids = [x["id"] for x in r.get("vulns") or []]
            if ids:
                hits[pkg] = ids
    return hits, failed


# ---------- secrets in repos ----------

SECRET_PATTERNS = [
    ("AWS access key", r"AKIA[0-9A-Z]{16}"),
    ("GitHub token", r"(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})"),
    ("Anthropic key", r"sk-ant-[A-Za-z0-9_-]{20,}"),
    ("OpenAI key", r"sk-(proj-)?[A-Za-z0-9_-]{40,}"),
    ("Stripe live key", r"[sr]k_live_[A-Za-z0-9]{20,}"),
    ("Slack token", r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    ("Google API key", r"AIza[0-9A-Za-z_-]{35}"),
    ("Private key", r"-----BEGIN ([A-Z]+ )?PRIVATE KEY-----"),
    ("Database URL with password", r"postgres(ql)?://[^:/ \"']+:[^@/ \"']{6,}@"),
]


def real_secret(kind, pattern, text):
    """A match not glued to a longer word; API keys also need the digits and capitals of a real key, not a slug."""
    for m in re.finditer(r"(?<![A-Za-z0-9_])" + pattern, text):
        token = m.group(0)
        if kind == "Slack token":  # real ones carry long numeric IDs; docs use xoxb-your-token
            if len(re.findall(r"\d", token)) >= 4:
                return True
        elif kind not in ("OpenAI key", "Anthropic key") or (re.search(r"\d.*\d", token) and re.search(r"[A-Z]", token)):
            return True
    return False


def repo_secrets(path):
    found = []
    args = ["grep", "-I", "-n", "-E"] + [x for _, p in SECRET_PATTERNS for x in ("-e", p)]
    for line in git(path, *args, timeout=60).splitlines():
        parts = line.split(":", 2)
        if len(parts) < 3 or re.search(r"(^|/)(node_modules|vendor)/|\.(lock|snap)$", parts[0]):
            continue
        kind = next((k for k, p in SECRET_PATTERNS if real_secret(k, p, parts[2])), None)
        if kind == "Database URL with password" and (re.search(r"(^|/)tests?/|test[_.-]|\.test\.|spec", parts[0])
                                                     or re.search(r"://[^:]+:[^@]*[${][^@]*@|@(localhost|127\.0\.0\.1|0\.0\.0\.0)\b", parts[2])):
            continue
        if kind and not re.search(r"example|placeholder|xxxx|your[_-]?key|dummy|fake", parts[2], re.I):
            found.append(f"{parts[0]}:{parts[1]} {kind}")
    for rel in git(path, "ls-files").splitlines():
        if re.match(r"\.env(\.[\w-]+)?$", os.path.basename(rel)) and not re.search(r"example|sample|template", rel, re.I):
            found.append(f"{rel} tracked .env file")
    return found[:20]


# ---------- recent threats ----------

def threats():
    out = {"kev": [], "github_critical": []}
    try:
        kev = fetch("https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json", timeout=60)
        for v in sorted(kev.get("vulnerabilities", []), key=lambda v: v.get("dateAdded", ""), reverse=True)[:30]:
            out["kev"].append({k: v.get(k) for k in ("cveID", "vendorProject", "product", "vulnerabilityName", "dateAdded")})
    except (OSError, ValueError):
        pass
    try:
        raw = run(["gh", "api", "advisories?type=reviewed&severity=critical&per_page=30&sort=published"]) if shutil.which("gh") else ""
        adv = json.loads(raw) if raw.startswith("[") else fetch("https://api.github.com/advisories?type=reviewed&severity=critical&per_page=30&sort=published")
        for a in adv[:30]:
            pkgs = sorted({f"{(x.get('package') or {}).get('ecosystem')}:{(x.get('package') or {}).get('name')}" for x in a.get("vulnerabilities") or []})
            out["github_critical"].append({"id": a.get("cve_id") or a.get("ghsa_id"), "summary": (a.get("summary") or "")[:120],
                                           "published": (a.get("published_at") or "")[:10], "packages": pkgs[:3]})
    except (OSError, ValueError, TypeError):
        pass
    return out


def kev_matches(kev, app_list):
    names = " | ".join(app_list).lower()
    hits = []
    for v in kev:
        words = [w for w in re.split(r"[^a-z0-9]+", f"{v.get('product', '')}".lower()) if len(w) > 3]
        if words and all(w in names for w in words[:2]):
            hits.append(f"{v['cveID']} {v.get('vendorProject')} {v.get('product')}: {v.get('vulnerabilityName')}")
    return hits


# ---------- main ----------

def progress(data):
    if os.environ.get("ROOM_THREAD_ID"):
        try:
            cli("loop", "scan-progress", "--data=" + json.dumps(data), timeout=30)
        except (OSError, subprocess.SubprocessError):
            pass  # the progress card misses an update; the scan goes on


def main(out, days=30, max_repos=60, max_github=10, max_readers=8):
    os.makedirs(os.path.join(out, "slices"), exist_ok=True)
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        computer_f, threats_f = pool.submit(mac), pool.submit(threats)
        repos, skipped, projects_error = active_repos(days, max_repos, max_github)
        for r in repos:
            r["packages"] = repo_packages(r["path"]) if r["path"] else []
            r["secrets"] = repo_secrets(r["path"]) if r["path"] else []
            r["days"] = commit_days(r)
            r["commits"] = sum(r["days"][-days:])
        repos.sort(key=lambda r: (-r["commits"], -r["last"]))  # busiest first: they get the cloud readers
        packages = sorted({p for r in repos for p in r["packages"]})
        checkable = [p for p in packages if registry_package(p)]
        hits, osv_failed = osv(checkable)
        all_ids = sorted({i for v in hits.values() for i in v})
        results = [d for d in pool.map(vuln_details, all_ids[:MAX_ADVISORIES]) if d]
        details = {d["id"]: d for d in results if not d.get("failed")}
        computer, recent = computer_f.result(), threats_f.result()
    counts = ((len(packages) - len(checkable), "packages from git, file or URL sources (never sent out)"),
              (osv_failed, "packages: the OSV lookup failed"),
              (sum(1 for d in results if d.get("failed")), "advisories: their details failed to load"),
              (max(0, len(all_ids) - MAX_ADVISORIES), f"advisories past the first {MAX_ADVISORIES}"))
    unchecked = [f"{n} {text}" for n, text in counts if n] + ([projects_error] if projects_error else [])
    remote = [r["name"] for r in repos if not r["path"]]  # no copy on this computer: no lockfiles to read (#2445)
    if remote:
        unchecked.append(f"{len(remote)} GitHub-only repos (no copy on this computer), so their packages were not checked: "
                         + ", ".join(remote))
    unchecked += [f"{name}: failed to load" for name, ok in (("CISA's exploited list", recent["kev"]),
                                                              ("GitHub's critical advisories", recent["github_critical"])) if not ok]
    if sys.platform != "darwin":  # mac() reads macOS only: missing computer facts must not look clean
        unchecked.append(f"this computer ({platform.system()}): disk encryption, firewall, pending updates, ports open to the network, "
                         "startup items, key and token files, and installed app versions: these checks run on macOS only")
    for r in repos:
        vulns = []
        for pkg in r["packages"]:
            for vid in hits.get(pkg, []):
                d = details.get(vid)
                if d:
                    vulns.append({**{k: x for k, x in d.items() if k != "ranges"}, "package": f"{pkg[0]}:{pkg[1]}",
                                  "version": pkg[2], "fixed": fix_for(d["ranges"].get(pkg[1], []), pkg[2])})
        seen, r["vulns"] = set(), []
        for v in sorted(vulns, key=lambda v: -(v["score"] or {"CRITICAL": 9, "HIGH": 7, "MEDIUM": 4}.get(v["severity"], 0))):
            key = (v["cve"] or v["id"], v["package"])
            if key not in seen:
                seen.add(key)
                r["vulns"].append(v)
        r["package_count"] = len(r.pop("packages")) if r["path"] else None  # None: not checked, unlike 0 packages
    computer["kev_matches"] = kev_matches(recent["kev"], computer.get("apps") or [])
    critical = sum(v["severity"] == "CRITICAL" for r in repos for v in r["vulns"])
    json.dump({"computer": computer, "repos": repos, "skipped_repos": skipped, "not_checked": unchecked, "threats": recent}, open(os.path.join(out, "findings.json"), "w"), indent=1)

    # Readers: one per GitHub repo, most active first.
    per_slice, heat = {}, [0] * 91
    for r in repos:
        heat = [a + b for a, b in zip(heat, r["days"])]
    for n, r in enumerate([r for r in repos if r["github"]][:max_readers], 1):
        key = f"{n:02d}"
        known = [f"{v['cve'] or v['id']} {v['package']} {v['version']}" for v in r["vulns"][:15]] + r["secrets"]
        open(os.path.join(out, "slices", f"slice-{key}.txt"), "w").write(
            f"Repo: {r['github']}\nLocal copy: {'yes' if r['path'] else 'no'}\n"
            f"Already found by the package and secret checks (don't repeat these):\n" + ("\n".join(known) or "nothing") + "\n")
        per_slice[key] = {str(i): c for i, c in enumerate(r["days"]) if c}
    json.dump({"chats": len(repos), "days": heat, "secrets": sum(len(r["secrets"]) for r in repos), "slices": per_slice},
              open(os.path.join(out, "slices", "progress.json"), "w"))
    progress({"chats": len(repos), "days": heat, "critical": critical})

    lines = [f"# Cyber scan facts ({time.strftime('%Y-%m-%d %H:%M')}, {round(time.time() - started)}s)", ""]
    if unchecked:
        lines += ["## Not fully checked", *[f"- {u}" for u in unchecked], ""]
    lines += ["## This computer"]
    for k, v in computer.items():
        if k == "apps":
            lines.append(f"- apps ({len(v)}): " + ", ".join(v))
        elif v not in (None, [], "", {}):
            lines.append(f"- {k}: {json.dumps(v) if isinstance(v, (dict, list)) else v}")
    lines += ["", f"## Repos active in the last {days} days ({len(repos)} checked, {skipped} more skipped)"]
    for r in repos:
        count = "packages not checked" if r["package_count"] is None else f"{r['package_count']} packages"
        lines.append(f"### {r['name']}" + (f" ({r['path'].replace(HOME, '~')})" if r["path"] else " (GitHub only)")
                     + f" · {count} · last active {time.strftime('%Y-%m-%d', time.localtime(r['last']))}")
        for v in r["vulns"][:12]:
            lines.append(f"- {v['cve'] or v['id']} · {(str(v['score']) + ' ') if v['score'] else ''}{v['severity'] or '?'} · {v['package']} {v['version']}"
                         f" -> {v['fixed'] or 'see advisory'} · {v['summary']}")
        if len(r["vulns"]) > 12:
            lines.append(f"- … {len(r['vulns']) - 12} more in findings.json")
        lines += [f"- secret: {s}" for s in r["secrets"]]
    lines += ["", "## Recent threats", "CISA actively exploited (newest first):"]
    lines += [f"- {v['cveID']} {v['vendorProject']} {v['product']} ({v['dateAdded']}): {v['vulnerabilityName']}" for v in recent["kev"]]
    lines += ["GitHub critical advisories:"]
    lines += [f"- {a['id']} ({a['published']}) {', '.join(a['packages'])}: {a['summary']}" for a in recent["github_critical"]]
    open(os.path.join(out, "summary.md"), "w").write("\n".join(lines) + "\n")
    print(f"{len(repos)} repos, {sum(r['package_count'] or 0 for r in repos)} packages, "
          f"{sum(len(r['vulns']) for r in repos)} advisories ({critical} critical), "
          f"{sum(len(r['secrets']) for r in repos)} secret findings, {len(per_slice)} reader slices"
          + (f", not fully checked: {'; '.join(unchecked)}" if unchecked else ""))

if __name__ == "__main__":
    a = sys.argv[1:]
    opt = lambda name, default: int(a[a.index(name) + 1]) if name in a else default
    main(a[0], opt("--days", 30), opt("--max-repos", 60), opt("--max-github", 10), opt("--max-readers", 8))
