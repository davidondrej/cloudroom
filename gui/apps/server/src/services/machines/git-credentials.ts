import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HostDaemonContributedEnvEntry } from "@cloudroom/host-daemon-contract";
import { z } from "zod";

const exec = promisify(execFile);

const githubCredentialHelper =
  '!f() { test "$1" = get || exit 0; protocol=; host=; while IFS= read -r line && test -n "$line"; do case "$line" in protocol=*) protocol=${line#protocol=} ;; host=*) host=${line#host=} ;; esac; done; if test "$protocol" = https && test "$host" = github.com && test -n "$GH_TOKEN"; then printf "username=x-access-token\\npassword=%s\\n" "$GH_TOKEN"; fi; }; f';

const gitConfig = [
  ["credential.helper", ""],
  ["credential.helper", githubCredentialHelper],
  ["url.https://github.com/.insteadOf", "git@github.com:"],
  ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
] as const;

const aiCoAuthorPattern =
  "^co-authored-by:.*(claude|anthropic|cursor|codex|openai|chatgpt|copilot|gemini|aider\\.chat|devin-ai|windsurf|codeium)";
const stripAiCoAuthorsHook = `cloudroom_strip_ai_co_authors() { grep -viE '${aiCoAuthorPattern}' "$1" > "$1.cloudroom"; [ $? -le 1 ] && mv "$1.cloudroom" "$1" || rm -f "$1.cloudroom"; }; cloudroom_strip_ai_co_authors`;
const stripAiCoAuthorsConfig = [
  ["hook.cloudroom-strip-ai-co-authors.command", stripAiCoAuthorsHook],
  ["hook.cloudroom-strip-ai-co-authors.event", "prepare-commit-msg"],
  ["hook.cloudroom-strip-ai-co-authors.event", "commit-msg"],
] as const;
const identitySchema = z.object({
  login: z.string().regex(/^[a-zA-Z0-9-]+$/u),
  id: z.number().int().positive(),
  email: z.email().nullable(),
});

async function runGh(args: string[]): Promise<string> {
  const { stdout } = await exec("gh", args, {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function gitConfigEnvironment(
  pairs: ReadonlyArray<readonly [string, string]>,
  reason: string,
  existing: readonly HostDaemonContributedEnvEntry[] = [],
): HostDaemonContributedEnvEntry[] {
  const offset = Number(
    existing.find((entry) => entry.name === "GIT_CONFIG_COUNT")?.value ?? 0,
  );
  const configEnv: Record<string, string> = {
    GIT_CONFIG_COUNT: String(offset + pairs.length),
  };
  pairs.forEach(([key, value], index) => {
    configEnv[`GIT_CONFIG_KEY_${offset + index}`] = key;
    configEnv[`GIT_CONFIG_VALUE_${offset + index}`] = value;
  });
  return [
    ...existing.filter((entry) => entry.name !== "GIT_CONFIG_COUNT"),
    ...Object.entries(configEnv).map<HostDaemonContributedEnvEntry>(
      ([name, value]) => ({
        name,
        value,
        source: { core: "machine-git" },
        reason,
      }),
    ),
  ];
}

export function githubGitConfiguration(): HostDaemonContributedEnvEntry[] {
  return gitConfigEnvironment(gitConfig, "GitHub HTTPS authentication");
}

export function withAiCoAuthorStripping(
  entries: readonly HostDaemonContributedEnvEntry[],
): HostDaemonContributedEnvEntry[] {
  return gitConfigEnvironment(
    stripAiCoAuthorsConfig,
    "Remove AI co-author lines from commits",
    entries,
  );
}

export async function resolveGitCredentials(
  run = runGh,
): Promise<HostDaemonContributedEnvEntry[]> {
  try {
    const token = z
      .string()
      .trim()
      .min(1)
      .regex(/^[^\s\x00]+$/u)
      .parse(await run(["auth", "token", "--hostname", "github.com"]));
    const user = identitySchema.parse(
      JSON.parse(await run(["api", "--hostname", "github.com", "user"])),
    );
    const email =
      user.email ?? `${user.id}+${user.login}@users.noreply.github.com`;
    return [
      ...githubGitConfiguration(),
      ...Object.entries({
        GH_TOKEN: token,
        GIT_AUTHOR_NAME: user.login,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: user.login,
        GIT_COMMITTER_EMAIL: email,
      }).map<HostDaemonContributedEnvEntry>(([name, value]) => ({
        name,
        value,
        source: { core: "machine-git" },
        reason: "GitHub credentials from the server gh login",
      })),
    ];
  } catch {
    return [];
  }
}

export async function machineGitHealth(run = runGh) {
  const entries = await resolveGitCredentials(run);
  return {
    status: entries.length ? ("ready" as const) : ("not configured" as const),
    statusMessage: entries.length
      ? "Generated using gh auth token --hostname github.com."
      : "gh is not logged in on the server",
  };
}
