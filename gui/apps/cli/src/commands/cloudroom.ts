import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, copyFile, link, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import type { AutoDeleteDays, CloudEnvironmentChange } from "@cloudroom/sdk";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { resolveContextThreadId } from "../context-env.js";
import { resolveLocalHostId } from "../daemon.js";
import { outputJson, type JsonOutputOptions } from "./helpers.js";

/** VM paths may start with ~ (the agent home); everything else stays literal. */
function quote(path: string): string {
  const [prefix, rest] = path === "~" ? ['"$HOME"', ""] : path.startsWith("~/") ? ['"$HOME"/', path.slice(2)] : ["", path];
  return rest ? prefix + literal(rest) : prefix;
}

function literal(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function lastLine(output: Buffer): string {
  return output.toString().trim().split("\n").pop() ?? "";
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const AUTO_DELETE_CHOICES = ["30", "90", "180", "365", "never"];

type VmTarget = { thread?: string };
const THREAD_OPTION = ["--thread <id>", "Cloud thread whose sandbox to use; required unless you have a cloud VM"] as const;

/** Runs on the VM or sandbox and fails with its error output unless the command succeeds. */
async function runOnVm(url: string, target: VmTarget, command: string, stdin = Buffer.alloc(0)): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const result = await createCliBbSdk(url).cloudroom.runOnVm({ command, stdin: stdin.toString("hex"), threadId: target.thread });
  if (result.truncated) throw new Error("Transfer exceeded the 16 MiB limit.");
  if (result.code !== 0) throw new Error(Buffer.from(result.stderr, "hex").toString().trimEnd() || `VM command failed (${result.code})`);
  return { stdout: Buffer.from(result.stdout, "hex"), stderr: Buffer.from(result.stderr, "hex") };
}

// Under the app's 16 MiB stdin limit; the app splits each piece again for the sandbox proxy.
const PUSH_PIECE = 12 * 1024 * 1024;

/** Appends `file` to `remote` on the VM piece by piece, so big pushes never sit in memory (feedback #490).
 *  Each piece first truncates to its offset, so a retry never duplicates data. */
async function uploadFile(url: string, target: VmTarget, file: string, remote: string): Promise<void> {
  const handle = await open(file);
  try {
    const { size } = await handle.stat();
    for (let offset = 0; offset < size; offset += PUSH_PIECE) {
      const length = Math.min(PUSH_PIECE, size - offset);
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, offset);
      const piece = buffer.subarray(0, bytesRead);
      for (let attempt = 1; ; attempt++) {
        try { await runOnVm(url, target, `mkdir -p ~/.cache/cloudroom && truncate -s ${offset} ${remote} && cat >> ${remote}`, piece); break; }
        catch (error) { if (attempt === 3) throw error; }
      }
      if (size > PUSH_PIECE) process.stderr.write(`Sent ${Math.round((offset + bytesRead) / 2 ** 20)} of ${Math.round(size / 2 ** 20)} MiB\n`);
    }
  } finally {
    await handle.close();
  }
}

export function registerVmCommands(program: Command, getUrl: () => string): void {
  const vm = program.command("vm").description("Run commands and copy files on your cloud VM or a Cloud thread's sandbox, as its agent account");
  vm.command("run <command>").description("Run a shell command on the VM or sandbox (quote it). Exits with its code.")
    .option(...THREAD_OPTION)
    .option("--cwd <dir>", "Folder, relative to the agent home")
    .option("--stdin", "Forward standard input")
    .action(action(async (command: string, options: VmTarget & { cwd?: string; stdin?: boolean }) => {
      const stdin = options.stdin ? await readStdin() : Buffer.alloc(0);
      const result = await createCliBbSdk(getUrl()).cloudroom.runOnVm({ command, stdin: stdin.toString("hex"), cwd: options.cwd, threadId: options.thread });
      process.stdout.write(Buffer.from(result.stdout, "hex"));
      process.stderr.write(Buffer.from(result.stderr, "hex"));
      if (result.truncated) process.stderr.write("Output exceeded 16 MiB and was truncated.\n");
      process.exitCode = result.code ?? 1;
    }));
  vm.command("pull <vm-path> [local-path]").description("Copy a VM or sandbox file or folder to this Mac, like cp: into an existing folder or a path ending in / (default: current folder), else under that new name, which must not exist yet.")
    .option(...THREAD_OPTION)
    .action(action(async (source: string, target = ".", options: VmTarget = {}) => {
      const inside = target.endsWith("/") || await stat(target).then((s) => s.isDirectory(), () => false);
      const taken = new Error(`${target} already exists; nothing was copied.`);
      if (!inside && await lstat(target).then(() => true, () => false)) throw taken;
      const { stdout: archive, stderr } = await runOnVm(getUrl(), options, `p=${quote(source)}; case $p in */) [ -L "\${p%/}" ] && p=$p.;; esac; case $(basename -- "$p") in .|..) p=$(cd -P -- "$p" >/dev/null && pwd -P) || exit 1;; esac; `
        + `n=$(basename -- "$p"); cd -- "$(dirname -- "$p")" && tar -czf - -- "$n" && printf '%s\\n' "$n" >&2`);
      await mkdir(inside ? target : dirname(target), { recursive: true });
      const folder = inside ? target : await mkdtemp(join(await realpath(dirname(target)), ".cloudroom-"));
      try {
        await new Promise<void>((resolve, reject) => {
          const tar = spawn("tar", ["-xzf", "-", "-C", folder], { stdio: ["pipe", "inherit", "inherit"] });
          tar.on("error", reject).on("close", (code) => code === 0 ? resolve() : reject(new Error("Could not unpack the copied files.")));
          tar.stdin.end(archive);
        });
        if (!inside) {
          const [entry, ...rest] = await readdir(folder);
          if (!entry || rest.length) throw new Error("Could not unpack the copied files.");
          const copy = join(folder, entry);
          const kind = await lstat(copy);
          const placed = kind.isDirectory() ? mkdir(target).then(() => rename(copy, target).catch(async (error) => { await rmdir(target).catch(() => {}); throw error; }))
            : kind.isSymbolicLink() ? readlink(copy).then((path) => symlink(path, target))
            : link(copy, target).catch((error: NodeJS.ErrnoException) => { if (error.code === "EEXIST") throw error; return copyFile(copy, target, constants.COPYFILE_EXCL); });
          await placed.catch((error: NodeJS.ErrnoException) => { throw error.code === "EEXIST" ? taken : error; });
        }
      } finally {
        if (!inside) await rm(folder, { recursive: true, force: true });
      }
      console.log(JSON.stringify({ copied: source, to: inside ? join(await realpath(target), lastLine(stderr)) : target }));
    }));
  vm.command("push <local-path> [vm-path]").description("Copy a file or folder from this Mac to the VM or sandbox, like cp: into an existing folder or a path ending in / (default: agent home), else under that new name, which must not exist yet.")
    .option(...THREAD_OPTION)
    .action(action(async (source: string, target = "~", options: VmTarget = {}) => {
      const linked = source.endsWith("/") && await lstat(source.replace(/\/+$/, "")).then((s) => s.isSymbolicLink(), () => false);
      const from = linked || [".", ".."].includes(basename(source)) ? await realpath(source) : source;
      const local = await mkdtemp(join(tmpdir(), "room-push-"));
      const archive = join(local, "push.tgz");
      const remote = `~/.cache/cloudroom/push-${randomUUID()}.tgz`;
      let to: string;
      try {
        await promisify(execFile)("tar", ["--no-xattrs", "-czf", archive, "-C", dirname(from), "--", basename(from)], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
        await uploadFile(getUrl(), options, archive, remote);
        to = lastLine((await runOnVm(getUrl(), options, `f=${remote}; d=${quote(target)}; n=${literal(basename(from))}; p=$(dirname -- "$d"); mkdir -p -- "${target.endsWith("/") ? "$d" : "$p"}" || exit 1; `
          + `used() { [ -e "$d" ] || [ -L "$d" ] && printf 'VM path %s already exists; nothing was copied.\\n' "$d" >&2; }; `
          + `if [ -d "$d" ]; then x=$d; to=\${d%/}/$n; else used && exit 1; x=$(mktemp -d "$p/.cloudroom.XXXXXX"); trap 'rm -rf "$x"; exit 1' 1 2 15; to=$d; fi; `
          + `tar -xzf "$f" -C "$x"; s=$?; [ "$x" = "$d" ] || { [ $s = 0 ] && ! used && mv -- "$x/$n" "$d" || s=1; rm -rf "$x"; }; `
          + `rm -f -- "$f"; [ $s != 0 ] || printf '%s\\n' "$to"; exit $s`)).stdout);
      } catch (error) {
        await runOnVm(getUrl(), options, `rm -f -- ${remote}`).catch(() => {});
        throw error;
      } finally {
        await rm(local, { recursive: true, force: true });
      }
      console.log(JSON.stringify({ copied: source, to }));
    }));
}

export function registerImportCommands(program: Command, getUrl: () => string): void {
  const group = program.command("import").description("Bring work over from other agent apps");
  group.command("bb").description("Copy open BB threads into idle Local threads with full history. Sends no prompts; BB is never changed.")
    .option("--json", "Print JSON")
    .action(action(async (options: JsonOutputOptions) => {
      const result = await createCliBbSdk(getUrl()).cloudroom.importBb(await resolveLocalHostId());
      if (outputJson(options, result)) return;
      for (const thread of result.imported) console.log(`Imported  ${thread.title} → ${thread.threadId}`);
      for (const thread of result.skipped) console.log(`Skipped   ${thread.title}: ${thread.reason}`);
      if (!result.imported.length && !result.skipped.length) console.log("No open BB threads found.");
    }));
  for (const [command, harness, app] of [["claude-code", "claude-code", "Claude Code"], ["codex", "codex", "Codex"], ["pi", "pi", "Pi"], ["hermes", "acp-hermes-agent", "Hermes Agent"], ["t3code", "t3code", "T3 Code"]] as const) {
    group.command(command).description(`Copy recent ${app} chats from this Mac into idle Local threads with their messages.${harness === "acp-hermes-agent" ? " Text only: the agent reads the old messages instead of resuming the session." : harness === "t3code" ? " Claude Code and Codex chats keep their memory; chats from other agents come over as text." : ""} Sends no prompts; ${app} is never changed.`)
      .option("--days <days>", "Only chats active in the last N days", "30")
      .option("--dry-run", "List the chats without importing them")
      .option("--json", "Print JSON")
      .action(action(async (options: JsonOutputOptions & { days: string; dryRun?: boolean }) => {
        const sdk = createCliBbSdk(getUrl()).cloudroom;
        const since = Date.now() - Number(options.days) * 86_400_000;
        const sessions = (await sdk.nativeSessions()).sessions.filter((session) => session.harness === harness && session.updatedAt >= since);
        if (options.dryRun || !sessions.length) {
          if (outputJson(options, { sessions })) return;
          for (const session of sessions) console.log(`${session.title}  (${session.cwd})`);
          if (!sessions.length) console.log(`No new ${app} chats from the last ${options.days} days.`);
          return;
        }
        const result = await sdk.importSessions(await resolveLocalHostId(), sessions.map(({ harness, id }) => ({ harness, id })));
        if (outputJson(options, result)) return;
        for (const thread of result.imported) console.log(`Imported  ${thread.title} → ${thread.threadId}`);
        for (const thread of result.skipped) console.log(`Skipped   ${thread.title}: ${thread.reason}`);
      }));
  }
  group.command("share <link>").description("Copy a thread someone shared with you (a cloudroom.dev/s/... link) into a new Local thread. Its agent starts by reading it and summing up.")
    .option("--json", "Print JSON")
    .action(action(async (link: string, options: JsonOutputOptions) => {
      const result = await createCliBbSdk(getUrl()).cloudroom.continueShare(link);
      if (!outputJson(options, result)) console.log(`Copied into ${result.threadId}.`);
    }));
}

/** Agents send Cloudroom feedback straight to David (ADR 0158). `report` is the old hidden name. Prints {"sent":false} while it is off in Settings. */
export function registerFeedbackCommand(program: Command, getUrl: () => string, name: "feedback" | "report"): void {
  program.command(`${name} <message>`, { hidden: name === "report" }).description("Send David, Cloudroom's founder, a bug, friction, or idea: what happened and the exact error. No secrets or code.")
    .action(action(async (message: string) => {
      console.log(JSON.stringify(await createCliBbSdk(getUrl()).cloudroom.reportBug({ message, threadId: resolveContextThreadId() })));
    }));
}

export function registerCloudCommands(program: Command, getUrl: () => string): void {
  const group = program.command("cloud").description("Connect this app to your Cloudroom account and VM");
  group.command("status").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    const status = await createCliBbSdk(getUrl()).cloudroom.status();
    if (!outputJson(options, status)) console.log(`${status.account?.email ?? "Signed out"}\n${status.signingIn ? "Waiting for browser confirmation" : status.ready ? "Cloud connected" : status.error ?? "Cloud unavailable"}${status.signInError ? `\n${status.signInError}` : ""}${status.previews?.explained && status.previews.state === "offline" && status.previews.message ? `\nMac access and previews can't connect: ${status.previews.message}` : ""}`);
  }));
  group.command("check").description("Make Mac access and previews check their connection to Cloudroom now").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    await createCliBbSdk(getUrl()).cloudroom.checkPreviews();
    if (!outputJson(options, { ok: true })) console.log("Checking now. Run room-cli cloud status in a few seconds for the result.");
  }));
  const codex = group.command("codex").description("Connect Codex on your cloud VM");
  codex.command("status").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.codexAuth();
    if (!outputJson(options, result)) console.log(`${result.state}${result.email ? ` · ${result.email}` : ""}${result.message ? `\n${result.message}` : ""}`);
  }));
  codex.command("login").requiredOption("--request-id <id>", "Reuse this ID after an uncertain response").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions & { requestId: string }) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.codexLogin(options.requestId);
    if (!outputJson(options, result)) console.log(result.state === "waiting" ? `Open ${result.verification_url}\nEnter code: ${result.user_code}\nRun room-cli cloud codex status to verify.` : result.message ?? result.state);
  }));
  codex.command("cancel <request-id>").option("--json", "Print JSON").action(action(async (id: string, options: JsonOutputOptions) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.cancelCodexLogin(id);
    if (!outputJson(options, result)) console.log(result.message ?? result.state);
  }));
  const github = group.command("github").description("Connect GitHub for cloud sandboxes");
  github.command("status").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.githubAuth();
    if (!outputJson(options, result)) console.log(`${result.state}${result.message ? `\n${result.message}` : ""}`);
  }));
  github.command("login").requiredOption("--request-id <id>", "Reuse this ID after an uncertain response").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions & { requestId: string }) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.githubLogin(options.requestId);
    if (!outputJson(options, result)) console.log(result.state === "waiting" ? `Open ${result.verification_url}\nEnter code: ${result.user_code}\nRun room-cli cloud github status to verify.` : result.message ?? result.state);
  }));
  github.command("cancel <request-id>").option("--json", "Print JSON").action(action(async (id: string, options: JsonOutputOptions) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.cancelGithubLogin(id);
    if (!outputJson(options, result)) console.log(result.message ?? result.state);
  }));
  const cursor = group.command("cursor").description("Connect Cursor on your cloud VM");
  cursor.command("status").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.cursorAuth();
    if (!outputJson(options, result)) console.log(`${result.state}${result.email ? ` · ${result.email}` : ""}${result.verification_url ? `\nOpen ${result.verification_url}` : result.message ? `\n${result.message}` : ""}`);
  }));
  cursor.command("login").requiredOption("--request-id <id>", "Reuse this ID after an uncertain response").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions & { requestId: string }) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.cursorLogin(options.requestId);
    if (!outputJson(options, result)) console.log(result.verification_url ? `Open ${result.verification_url}` : `${result.message ?? result.state}\nRun room-cli cloud cursor status for the sign-in link.`);
  }));
  cursor.command("cancel <request-id>").option("--json", "Print JSON").action(action(async (id: string, options: JsonOutputOptions) => {
    const result = await createCliBbSdk(getUrl()).cloudroom.cancelCursorLogin(id);
    if (!outputJson(options, result)) console.log(result.message ?? result.state);
  }));
  cursor.command("key").description("Read a Cursor API key from stdin, never a command argument").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    if (process.stdin.isTTY) throw new Error("Pipe your Cursor API key into this command.");
    let key = "";
    for await (const chunk of process.stdin) { key += String(chunk); if (key.length > 4097) throw new Error("Cursor key is too long"); }
    const result = await createCliBbSdk(getUrl()).cloudroom.cursorApiKey(crypto.randomUUID(), key.trim());
    if (!outputJson(options, result)) console.log(result.message ?? result.state);
  }));
  const pi = group.command("pi").description("Connect Pi providers on your cloud VM");
  pi.command("key <provider>").description("Read a provider API key from stdin, never a command argument").option("--json", "Print JSON").action(action(async (provider: string, options: JsonOutputOptions) => {
    if (process.stdin.isTTY) throw new Error(`Pipe your ${provider} API key into this command.`);
    const result = await createCliBbSdk(getUrl()).cloudroom.piApiKey(provider, (await readStdin()).toString().trim());
    if (!outputJson(options, result)) console.log(`Saved. Pi on your VM has logins for: ${result.providers.join(", ")}`);
  }));
  const change = async (update: CloudEnvironmentChange, options: JsonOutputOptions, done: string) => {
    const environment = await createCliBbSdk(getUrl()).cloudroom.updateEnvironment(update);
    if (!outputJson(options, environment)) console.log(done);
  };
  const piped = async (what: string) => {
    if (process.stdin.isTTY) throw new Error(`Pipe the ${what} into this command.`);
    return (await readStdin()).toString().replace(/\n$/, "");
  };
  const env = group.command("env").description("API keys every cloud thread gets as environment variables");
  env.command("list").description("Show key names (values stay hidden), GitHub repos, and the setup script").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    const { variables, repos, setup } = await createCliBbSdk(getUrl()).cloudroom.environment();
    if (outputJson(options, { variables, repos, setup })) return;
    console.log(`API keys:${variables.map(({ name, hint }) => `\n  ${name}${hint ? `  …${hint}` : ""}`).join("") || " none"}`);
    console.log(`GitHub repos:${repos.map((repo) => `\n  ${repo}`).join("") || " none"}`);
    console.log(`Setup script:${setup ? `\n${setup.replace(/^/gm, "  ")}` : " none"}`);
  }));
  env.command("set <name>").description("Read the value from stdin, never a command argument").option("--json", "Print JSON").action(action(async (name: string, options: JsonOutputOptions) => {
    await change({ action: "set", variables: { [name]: await piped(`value of ${name}`) } }, options, `Saved ${name}.`);
  }));
  env.command("unset <name>").option("--json", "Print JSON").action(action(async (name: string, options: JsonOutputOptions) => {
    await change({ action: "remove", name }, options, `Removed ${name}.`);
  }));
  const repo = group.command("repo").description("GitHub repos cloned into every cloud sandbox, next to the project");
  repo.command("add <owner/name>").option("--json", "Print JSON").action(action(async (name: string, options: JsonOutputOptions) => {
    await change({ action: "addRepo", repo: name }, options, `Added ${name}. New cloud sandboxes clone it into /repos.`);
  }));
  repo.command("remove <owner/name>").option("--json", "Print JSON").action(action(async (name: string, options: JsonOutputOptions) => {
    await change({ action: "removeRepo", repo: name }, options, `Removed ${name}.`);
  }));
  const setup = group.command("setup").description("Script that runs once in each new cloud sandbox");
  setup.command("set").description("Read the script from stdin; empty input clears it").option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
    const script = await piped("setup script");
    await change({ action: "setup", setup: script }, options, script.trim() ? "Saved. New cloud sandboxes run it once." : "Setup script cleared.");
  }));
  group.command("auto-delete [days]").description("Show or set how long unused cloud threads are kept: 30, 90, 180, 365, or never (as long as your plan allows)").option("--json", "Print JSON").action(action(async (days: string | undefined, options: JsonOutputOptions) => {
    const sdk = createCliBbSdk(getUrl()).cloudroom;
    if (days !== undefined && !AUTO_DELETE_CHOICES.includes(days)) throw new Error(`Pick one of: ${AUTO_DELETE_CHOICES.join(", ")}.`);
    const result = days === undefined ? await sdk.autoDelete() : await sdk.setAutoDelete(days === "never" ? null : Number(days) as AutoDeleteDays);
    const kept = result.kept ?? result.days;
    const limit = result.plan && kept === result.plan.days ? `${result.plan.label} (${result.plan.name} limit)` : `${kept} days`;
    if (!outputJson(options, result)) console.log(kept === null ? "Unused cloud threads are kept forever." : `Unused cloud threads are deleted after ${limit}.`);
  }));
  group.command("sign-in").option("--project <id>", "Legacy prepared-project binding (optional)")
    .option("--website-url <url>", "Loopback website for local development")
    .option("--json", "Print JSON")
    .action(action(async (options: JsonOutputOptions & { project?: string; websiteUrl?: string }) => {
      const result = await createCliBbSdk(getUrl()).cloudroom.signIn({ projectId: options.project, websiteUrl: options.websiteUrl });
      if (!outputJson(options, result)) console.log(`Open this link in your browser:\n${result.url}`);
    }));
  for (const name of ["cancel", "logout"] as const) {
    group.command(name).option("--json", "Print JSON").action(action(async (options: JsonOutputOptions) => {
      await createCliBbSdk(getUrl()).cloudroom[name]();
      if (!outputJson(options, { ok: true })) console.log(name === "logout" ? "Signed out of this app. Cloud agents keep running." : "Sign-in cancelled.");
    }));
  }
  group.command("teleport <thread-id>").description("Move a local Codex, Pi, Claude Code, or opencode thread to Cloud without changing its conversation. Checks first that Cloud can run the same model and effort. Use --to-local to bring a Cloud Codex, Pi, Claude Code, opencode, or Cursor thread back to this Mac")
    .option("--to-local", "Move a Cloud thread back to this Mac with its conversation and code changes")
    .option("--cancel", "Cancel before cloud execution starts")
    .option("--status", "Read transfer progress without changing it")
    .option("--check", "Check whether Teleport would work, without moving anything")
    .option("--model <model>", "Run in Cloud on this model instead (requires --reasoning)")
    .option("--reasoning <level>", "Reasoning level for --model")
    .option("--wait", "Wait until the transfer completes, is cancelled, or fails")
    .option("--timeout <seconds>", "Stop waiting after this many seconds (with --wait)", "600")
    .option("--json", "Print JSON")
    .action(action(async (threadId: string, options: JsonOutputOptions & { cancel?: boolean; status?: boolean; model?: string; reasoning?: string; toLocal?: boolean; wait?: boolean; timeout: string; check?: boolean }) => {
      const sdk = createCliBbSdk(getUrl());
      if (options.toLocal) {
        const moved = await sdk.cloudroom.teleportLocal(threadId);
        if (!outputJson(options, moved)) console.log(`Moved to this Mac.${moved.conflicts ? ` ${moved.conflicts} changed files were kept in both versions; cloud copies are in .cloudroom/teleport/.` : ""}`);
        return;
      }
      if (Boolean(options.model) !== Boolean(options.reasoning)) throw new Error("Use --model and --reasoning together.");
      const choice = options.model && options.reasoning ? { model: options.model, reasoning: options.reasoning } : undefined;
      if (options.check) {
        const checked = await sdk.cloudroom.teleportCheck(threadId, choice);
        if (!outputJson(options, checked)) console.log([`Ready: Cloud can run ${checked.model} at ${checked.reasoning} effort.`, ...checked.warnings].join("\n"));
        return;
      }
      const timeoutSeconds = Number(options.timeout);
      if (!(timeoutSeconds > 0)) throw new Error("--timeout must be a positive number of seconds.");
      let result = options.status ? await sdk.cloudroom.teleportStatus(threadId) : await sdk.cloudroom.teleport(threadId, options.cancel ? "cancel" : "start", choice);
      if (options.wait) result = await waitForTeleport(() => sdk.cloudroom.teleportStatus(threadId), result, timeoutSeconds * 1000, options.json === true);
      if (!outputJson(options, result)) console.log(result ? `${result.phase}: ${result.completed}/${result.total} files${result.error ? `\n${result.error}` : ""}${result.phase === "complete" ? "\nRunning in cloud. You can close your laptop." : ""}${options.wait && !TELEPORT_DONE.includes(result.phase) ? "\nStill running. Check with --status." : ""}` : "No Teleport transfer.");
      if (options.wait && result?.phase !== (options.cancel ? "cancelled" : "complete")) process.exitCode = 1;
    }));
  group.command("share <thread-id>").description("Make a read-only link to a thread's messages, or update its shared copy. Tool output and files stay private; secrets are removed.")
    .option("--status", "Show the link without changing it")
    .option("--stop", "Turn the link off and delete the shared copy")
    .option("--json", "Print JSON")
    .action(action(async (threadId: string, options: JsonOutputOptions & { status?: boolean; stop?: boolean }) => {
      const sdk = createCliBbSdk(getUrl()).cloudroom;
      if (options.stop) {
        await sdk.stopSharingThread(threadId);
        if (!outputJson(options, null)) console.log("Sharing stopped. The link no longer works.");
        return;
      }
      const share = options.status ? await sdk.threadShare(threadId) : await sdk.shareThread(threadId);
      if (!outputJson(options, share)) console.log(share ? share.url : "Not shared.");
    }));
  group.command("retry-start <thread-id>").description("Explicitly retry a rejected cloud start with its saved prompt").option("--json", "Print JSON").action(action(async (threadId: string, options: JsonOutputOptions) => {
    await createCliBbSdk(getUrl()).cloudroom.retryStart(threadId);
    if (!outputJson(options, { ok: true })) console.log("Cloud start retried with the original request ID.");
  }));
  group.command("thread-workspace <thread-id>").description("Show a cloud thread's current checkout and branch").option("--json", "Print JSON").action(action(async (threadId: string, options: JsonOutputOptions) => {
    const workspace = await createCliBbSdk(getUrl()).cloudroom.threadWorkspace(threadId);
    if (!outputJson(options, workspace)) console.log(workspace ? `${workspace.path}\n${workspace.branch ?? workspace.head ?? "No Git repository"}` : "Cloud session is not ready.");
  }));
}

const TELEPORT_DONE = ["complete", "cancelled", "error"];

async function waitForTeleport<T extends { phase: string }>(read: () => Promise<T | null>, first: T | null, timeoutMs: number, quiet: boolean): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let progress = first;
  const say = (next: T | null) => { if (!quiet && next && !TELEPORT_DONE.includes(next.phase)) console.log(`${next.phase}…`); };
  say(progress);
  while (progress && !TELEPORT_DONE.includes(progress.phase) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const next = await read();
    if (next?.phase !== progress.phase) say(next);
    progress = next;
  }
  return progress;
}
