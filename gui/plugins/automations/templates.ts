import type { ReasoningLevel } from "./src/rpc-types.js";

// Ready-made loops (docs/scopes/loops.md, Templates). People pick only the repos; everything else is preset.
// A loop made from a template keeps the template's name, which is how the Templates tab finds where it runs.

export const TEMPLATE_CATEGORIES = [
  { id: "security", label: "Security", icon: "SecurityCheck" },
  { id: "code-health", label: "Code health", icon: "Clean" },
  { id: "reviews", label: "Reviews", icon: "GitMerge" },
  { id: "ops", label: "Ops", icon: "Toolbox" },
  { id: "growth", label: "Growth", icon: "Sent" },
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]["id"];

// David's priority: how essential a template is to run on every project.
export const TEMPLATE_PRIORITIES = [
  { level: 1, label: "Essential", hint: "run these on every project" },
  { level: 2, label: "Recommended", hint: "most projects want these" },
  { level: 3, label: "Useful", hint: "depends on the project" },
  { level: 4, label: "Niche", hint: "for some projects" },
] as const;
export type TemplatePriority = (typeof TEMPLATE_PRIORITIES)[number]["level"];

export interface LoopTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  priority: TemplatePriority;
  icon: string;
  cron: string;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  prompt: string;
}

const REPORT = `
When you are done:
- If nothing needs the user, write 1-2 lines on what you checked, then archive this thread with \`room-cli thread archive --self\`.
- Otherwise leave the thread open. Explain each finding in plain English, in a few sentences, with the obvious, safe fix.`;
const READ_ONLY = "Read only: do not edit, commit, or push anything.";
const rotate = (title: string) =>
  `First rename this thread: \`room-cli thread update --self --title "${title} · <area>"\`, where <area> is the part of the code you pick. Pick the area least recently covered: skip areas named in the past runs' Loop notes below.`;

export const LOOP_TEMPLATES: readonly LoopTemplate[] = [
  {
    id: "security-sweep",
    name: "Security sweep",
    description: "Finds security holes in your code. Checks one area per run.",
    category: "security",
    priority: 1,
    icon: "SecurityCheck",
    cron: "0 */2 * * *",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "max",
    prompt: `Security sweep: a defensive review of this repo's own code. ${READ_ONLY}
${rotate("Security sweep")}
In that area, look for missing auth or access checks, data one user can see that belongs to another, secrets in code or logs, unsafe input handling, and risky defaults. Only report what you confirmed by reading the code; drop guesses.${REPORT}`,
  },
  {
    id: "dependency-sweep",
    name: "Supply-chain security sweep",
    description:
      "Checks your packages for new security alerts. Flags hacked or unsafe versions.",
    category: "security",
    priority: 1,
    icon: "PackageReceive",
    cron: "0 * * * *",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "xhigh",
    prompt: `Supply-chain security sweep. ${READ_ONLY}
Find every lockfile in this repo (package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock, Cargo.lock, go.sum, poetry.lock, uv.lock, and so on). Check the exact locked versions against recent advisories: the OSV database (https://api.osv.dev), GitHub advisories, and news of malicious or hijacked releases from the last few days. Report only advisories that hit a version this repo actually locks, with the fixed version.${REPORT}`,
  },
  {
    id: "dep-watch",
    name: "Dep watch",
    description:
      "Watches your frameworks for urgent security fixes. Tells you what to update.",
    category: "security",
    priority: 2,
    icon: "PackageReceive",
    cron: "*/30 * * * *",
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "xhigh",
    prompt: `Dep watch. ${READ_ONLY}
List the runtimes and frameworks this repo runs on, with their versions (for example Node, Python, PHP, Go, Next.js, and the base images in Dockerfiles). Search for security fixes released in the last 24 hours that affect those versions. Report only critical or high fixes we are missing, with the version to update to.${REPORT}`,
  },
  {
    id: "web-security-test",
    name: "Web security test",
    description:
      "Attacks your live site like a hacker. Reports only real holes.",
    category: "security",
    priority: 3,
    icon: "Globe",
    cron: "0 */4 * * *",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "max",
    prompt: `Web security test of this project's own live website. Find its production URL in the README, config, or deploy files; if there is none, say so and archive this thread.
Test it from outside like a careful attacker: auth and session handling, access to other users' data, exposed admin or debug routes, open redirects, missing security headers, and leaked keys in the shipped JavaScript. Stay gentle: no load testing, no destructive requests, no real user data changes. Do not edit code.${REPORT}`,
  },
  {
    id: "prove-it-bug-hunt",
    name: "Prove-it bug hunt",
    description:
      "Proves one security bug with a failing test, fixes it, and opens a PR.",
    category: "security",
    priority: 2,
    icon: "Bug",
    cron: "0 1 * * *",
    providerId: "pi",
    model: "openrouter/moonshotai/kimi-k3.1-pro",
    reasoningLevel: "high",
    prompt: `Prove-it bug hunt: find one real security bug in this repo's own code, prove it, fix it, and open a PR.
${rotate("Prove-it bug hunt")}
Work on a new branch. Never touch live systems or real user data, never print secret values, and add no new dependencies.
In that area, follow outside input to auth checks, queries, shell commands, file paths, and secrets. A bug counts only if you prove it: write a test in the repo's existing test framework that fails before your fix. Then make the smallest fix, and run that test and the nearby tests until they pass.
Before the PR, start a reviewer on a different model that is set up (\`room-cli thread spawn --parent-self --provider <harness> --prompt "..."\`): it checks the bug is real and the fix breaks nothing, and ends with SHIP or HOLD. If HOLD, fix the reason once and ask again.
When you are done:
- Proven bug and SHIP: push the branch and open a PR with \`gh pr create\`: what is wrong, who can reach it, the test that proves it, and the fix. Leave this thread open with the PR link.
- Otherwise, write 1-2 lines on what you checked, then archive this thread with \`room-cli thread archive --self\`.`,
  },
  {
    id: "fuzz-and-fix",
    name: "Fuzz-and-fix",
    description:
      "Fuzzes one input parser. Fixes any crash it finds and opens a PR.",
    category: "security",
    priority: 2,
    icon: "Zap",
    cron: "0 3 * * *",
    providerId: "pi",
    model: "openrouter/moonshotai/kimi-k3.1-pro",
    reasoningLevel: "high",
    prompt: `Fuzz-and-fix: fuzz one input parser in this repo, and if it breaks, fix it and open a PR.
First read the past runs' Loop notes below, and list open fix PRs (\`gh pr list --state open --search "Fuzz-and-fix in:title"\`).
Pick one parser: code that reads outside input, like request bodies, uploaded files, config, URLs, file paths, or CLI arguments. Skip parsers with an open Fuzz-and-fix PR. Pick in this order:
1. One changed in the last 7 days (\`git log --since="7 days ago" --name-only\`) that no run covered since the change.
2. One no run has covered yet.
3. One no run covered in the last 30 days.
If none fits, write one line and archive this thread with \`room-cli thread archive --self\`. Otherwise rename this thread: \`room-cli thread update --self --title "Fuzz-and-fix · <parser>"\`.
Work on a new branch. Never touch live systems or real user data, and add no new dependencies.
Write the fuzz harness in \`/tmp/fuzz/\`, not in the repo, and install any fuzzing tool you need. Fuzz for up to 30 minutes. Look for crashes, panics, hangs, and paths that escape their folder.
For each one: shrink the input, find the root cause, add a regression test to the existing tests, and make the smallest fix. Run that test and the nearby tests until they pass.
Before the PR, start a reviewer on a different model that is set up (\`room-cli thread spawn --parent-self --provider <harness> --prompt "..."\`): it checks the crash is real and the fix breaks nothing, and ends with SHIP or HOLD. If HOLD, fix the reason once and ask again.
When you are done:
- Fixed and SHIP: push the branch and open a PR titled "Fuzz-and-fix: <parser>: <bug>" with \`gh pr create\`: the input that broke it, the impact, the regression test, and the fix. Leave this thread open with the PR link.
- Otherwise, write 1-2 lines on the target, how many inputs ran, and for how long. Then archive this thread with \`room-cli thread archive --self\`.
Either way, your Loop note names the parser, how many inputs ran, and the result.`,
  },
  {
    id: "simplify-sweep",
    name: "Simplify sweep",
    description: "Finds dead and duplicate code. Checks one area per run.",
    category: "code-health",
    priority: 2,
    icon: "Clean",
    cron: "0 */6 * * *",
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "max",
    prompt: `Simplify sweep. Investigate only: do not edit code.
${rotate("Simplify sweep")}
In that area, find dead code, duplication, needless abstractions, and code that is far more complex than its job. Report only changes that clearly make the code smaller or simpler without changing behavior.${REPORT}`,
  },
  {
    id: "test-gap-hunt",
    name: "Test gap hunt",
    description:
      "Finds risky code with no tests. Suggests the one test to add.",
    category: "code-health",
    priority: 2,
    icon: "Beaker",
    cron: "0 */12 * * *",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "xhigh",
    prompt: `Test gap hunt. ${READ_ONLY}
${rotate("Test gap hunt")}
Find the single most important missing test in that area: code where a silent break would hurt users or money, and nothing would catch it. Then argue against it: is it already covered, or too costly to keep? Report it only if it survives, with what the test should check.${REPORT}`,
  },
  {
    id: "dependency-diet",
    name: "Dependency diet",
    description:
      "Finds packages you don't need. Replaces one with a few lines.",
    category: "code-health",
    priority: 3,
    icon: "Layers",
    cron: "0 9 * * *",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "xhigh",
    prompt: `Dependency diet. Investigate only: do not edit code.
List this repo's direct dependencies, biggest and least used first. Pick the one that is easiest to drop: a language built-in, the platform, or a few lines of our own code could replace it safely. Check every place it is used.${REPORT}`,
  },
  {
    id: "side-effects-review",
    name: "Side effects review",
    description:
      "Reviews what just landed on main. Catches bugs and security holes.",
    category: "reviews",
    priority: 1,
    icon: "GitMerge",
    cron: "0 */4 * * *",
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "max",
    prompt: `Side effects review. ${READ_ONLY}
Fetch the default branch and review the commits that landed in the last 4 hours (\`git fetch\`, then \`git log --since="4 hours ago"\` on the remote default branch). If nothing landed, archive this thread.
Hunt the unintended side effects of those changes: security holes, usage or billing bypasses, data loss, broken older clients, and edge cases the author missed. Confirm each one in the code.${REPORT}`,
  },
  {
    id: "pr-issue-triage",
    name: "PR & issue triage",
    description: "Sorts new GitHub issues and PRs. Flags the low-effort ones.",
    category: "reviews",
    priority: 3,
    icon: "GitPullRequest",
    cron: "0 */4 * * *",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "high",
    prompt: `PR & issue triage for this repo on GitHub. Use the \`gh\` CLI; if it is missing or signed out, say so and stop. Never comment, close, merge, or label anything.
List issues and pull requests opened or updated in the last 4 hours. For each, give one line: what it is, whether it is real and worth the user's time, and the next step. Be skeptical of low-effort or AI-generated contributions.${REPORT}`,
  },
  {
    id: "payments-review",
    name: "Payments review",
    description:
      "Checks your billing code for money bugs. Finds free-usage holes and double charges.",
    category: "reviews",
    priority: 4,
    icon: "Lock",
    cron: "0 */8 * * *",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "xhigh",
    prompt: `Payments review. ${READ_ONLY}
Find this repo's billing and plan code (checkout, webhooks, subscriptions, plan limits). If there is none, archive this thread. Look for ways to get paid features or usage for free, double charges, missed webhook events, refunds or cancellations that leave access on, and plan limits that are not enforced on the server.${REPORT}`,
  },
  {
    id: "database-health",
    name: "Database health",
    description:
      "Checks your database health. Read-only, so it never changes data.",
    category: "ops",
    priority: 4,
    icon: "ChartColumn",
    cron: "0 */12 * * *",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "high",
    prompt: `Database health check. Strictly read only: run only SELECT queries and never change data, schema, or settings.
Find a read-only database URL in this project's .env files. If there is none, say the loop needs one and stop. Check size and growth, the slowest queries, connection use, locks, bloat, and recent errors, and compare with the last report in this project's threads if there is one.${REPORT}`,
  },
  {
    id: "uptime-errors",
    name: "Uptime & errors",
    description:
      "Checks your site is up and error-free. Pings you only when it breaks.",
    category: "ops",
    priority: 4,
    icon: "AlertTriangle",
    cron: "*/15 * * * *",
    providerId: "claude-code",
    model: "claude-sonnet-5-5",
    reasoningLevel: "high",
    prompt: `Uptime & errors check. Do not edit code.
Find this project's production URL and health endpoints in the README, config, or deploy files. Check that they respond fast and correctly. If the project has a logs CLI or API you can read (for example Vercel, Fly, or Supabase), look for new errors in the last 15 minutes.${REPORT}`,
  },
  {
    id: "thread-cleanup",
    name: "Thread cleanup",
    description: "Archives finished threads. Keeps your sidebar clean.",
    category: "ops",
    priority: 2,
    icon: "Archive",
    cron: "0 */3 * * *",
    providerId: "claude-code",
    model: "claude-sonnet-5-5",
    reasoningLevel: "medium",
    prompt: `Thread cleanup for this project. List its open threads with \`room-cli thread list --project "$ROOM_PROJECT_ID" --json\`.
Archive a thread only when it is clearly finished: the work shipped or was abandoned, its last message is a final report, and nothing waits on the user. Never archive pinned threads, threads that are running, or threads with a question for the user. When unsure, keep it.
Then write a short list of what you archived and why, and archive this thread with \`room-cli thread archive --self\`.`,
  },
  {
    id: "tweet-scout",
    name: "Tweet scout",
    description: "Finds 3 tweets worth replying to. Never posts for you.",
    category: "growth",
    priority: 4,
    icon: "Sent",
    cron: "0 8-22/3 * * *",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "xhigh",
    prompt: `Tweet scout. Read this repo's README to learn what the project does and who it is for. Do not touch code or git.
Find the 3 best tweets on X from the last 48 hours for the user to reply to: big or rising accounts in this niche, real questions or pain this project solves, and threads where a founder's reply would add value. Never post, like, or reply. Give each tweet's link and one line on why it is worth replying to; do not draft the reply.
Leave this thread open for the user.`,
  },
  {
    id: "research-digest",
    name: "Research digest",
    description:
      "Picks the AI papers worth reading. Explains them in plain English.",
    category: "growth",
    priority: 4,
    icon: "FileText",
    cron: "0 8 */2 * *",
    providerId: "claude-code",
    model: "claude-sonnet-5-5",
    reasoningLevel: "high",
    prompt: `Research digest. Do not touch code or git.
Find the 5 most important new AI and machine learning papers from the last 2 days (arXiv, lab blogs, and what researchers are discussing). Favor ones that matter to this project; read the README to know what it does. For each, give the link and 2-3 plain-English sentences: what is new and why it matters.
Leave this thread open for the user.`,
  },
];
