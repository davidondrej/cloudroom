#!/usr/bin/env python3
"""Cyber scan report: renders DIR/report.json as an inline visual and prints the directive line to paste in the reply.

  report.py DIR

report.json:
  {"scope": "Your Mac and 6 repos",
   "findings": [{"severity": "CRITICAL|HIGH|MEDIUM|LOW", "score": 9.8, "id": "CVE-2026-1234", "title": "...",
                 "where": "owner/repo · npm seroval 1.5.4", "fix": "Update to 1.6.2"}],
   "loops": [{"name": "...", "schedule": "Every hour", "why": "..."}]}
"score" and "id" are optional: only use IDs and scores from findings.json, never invent them.
"""
import html, json, os, sys, time

COLOR = {"CRITICAL": "var(--destructive-text)", "HIGH": "var(--warning-text)", "MEDIUM": "var(--attention, var(--foreground))",
         "LOW": "var(--muted-foreground)"}
RANK = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
CSS = """
.cs{font:inherit;color:var(--foreground)}
.cs .head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin:2px 0 12px}
.cs .count{font-size:22px;font-weight:650;letter-spacing:-.02em}
.cs .muted{color:var(--muted-foreground);font-size:12px}
.cs .list{display:grid;gap:8px}
.cs .f{display:grid;grid-template-columns:76px minmax(0,1fr);gap:12px;align-items:start;padding:12px 14px;
  background:var(--surface-raised);border:1px solid var(--border);border-radius:var(--radius)}
.cs .sev{font-family:var(--font-mono);line-height:1.1}
.cs .sev b{display:block;font-size:20px}
.cs .sev span{font-size:10px;font-weight:700;letter-spacing:.06em}
.cs .id{font-family:var(--font-mono);font-size:12px;color:var(--muted-foreground)}
.cs .t{font-weight:600;margin:1px 0 3px}
.cs .where{font-family:var(--font-mono);font-size:12px;color:var(--muted-foreground);overflow-wrap:anywhere}
.cs .fix{font-size:12px;margin-top:5px}
.cs .fix:before{content:"Fix  ";color:var(--primary);font-weight:700}
.cs h4{margin:18px 0 8px;font-size:13px;font-weight:650}
.cs .loops{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:8px}
.cs .loop{padding:12px 14px;border:1px solid var(--primary);border-radius:var(--radius);background:var(--surface-selected, transparent)}
.cs .loop .muted{margin-top:2px}
.cs .why{font-size:12px;margin-top:6px}
"""


def esc(value):
    return html.escape(str(value or ""))


def render(data):
    findings = sorted(data.get("findings") or [], key=lambda f: (RANK.get(str(f.get("severity")).upper(), 4), -(f.get("score") or 0)))
    counts = {s: sum(str(f.get("severity")).upper() == s for f in findings) for s in RANK}
    head = " · ".join(f'<span style="color:{COLOR[s]}">{n} {s.lower()}</span>' for s, n in counts.items() if n) or "No serious problems found"
    rows = []
    for f in findings:
        sev = str(f.get("severity") or "LOW").upper()
        score = f'<b>{float(f["score"]):.1f}</b>' if isinstance(f.get("score"), (int, float)) else ""
        vid = f'<div class="id">{esc(f["id"])}</div>' if f.get("id") else ""
        fix = f'<div class="fix">{esc(f["fix"])}</div>' if f.get("fix") else ""
        rows.append(f'<div class="f"><div class="sev" style="color:{COLOR.get(sev, COLOR["LOW"])}">{score}<span>{esc(sev)}</span></div>'
                    f'<div>{vid}<div class="t">{esc(f.get("title"))}</div><div class="where">{esc(f.get("where"))}</div>{fix}</div></div>')
    loops = "".join(f'<div class="loop"><div class="t">{esc(l.get("name"))}</div><div class="muted">{esc(l.get("schedule"))}</div>'
                    f'<div class="why">{esc(l.get("why"))}</div></div>' for l in data.get("loops") or [])
    return (f'<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head><body><div class="cs">'
            f'<div class="head"><span class="count">{head}</span><span class="muted">{esc(data.get("scope"))}</span></div>'
            f'<div class="list">{"".join(rows)}</div>'
            + (f'<h4>Loops that stop this coming back</h4><div class="loops">{loops}</div>' if loops else "")
            + '</div></body></html>')


def main(d):
    data = json.load(open(os.path.join(d, "report.json"), encoding="utf-8"))
    name = f"cyber-scan/report-{time.strftime('%Y%m%d-%H%M%S')}.html"
    storage = os.environ.get("BB_THREAD_STORAGE")
    path = os.path.join(storage or d, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w", encoding="utf-8").write(render(data))
    print(f'::inline-vis{{source="thread-storage" file="{name}"}}' if storage else f"Saved {path} (no thread storage here)")


if __name__ == "__main__":
    main(sys.argv[1])
