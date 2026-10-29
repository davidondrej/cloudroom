import readline from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "commander";
import { formatPendingInteractionSummary } from "@cloudroom/core-ui";
import {
  isApprovalPendingInteractionPayload,
  type PendingInteraction,
  type ThreadStatus,
} from "@cloudroom/domain";
import { formatThreadTimelineText } from "@cloudroom/thread-view";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { createHerdrReporter } from "../../herdr.js";
import { getErrorMessage } from "../helpers.js";
import { describeThreadTellOutcome, postThreadMessage } from "./actions.js";
import { resolveBinaryInteraction } from "./interactions.js";

const POLL_INTERVAL_MS = 700;
const BUSY_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "pending",
  "starting",
  "active",
  "stopping",
]);
const HELP =
  "Type a message and press Enter. /approve or /deny answers an approval, /stop stops the agent, /exit or Ctrl+C leaves while the agent keeps running.";

export function registerChatCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("chat <id>")
    .description(
      "Chat with a Local or Cloud thread in this terminal, with live output",
    )
    .action(
      action(async (threadId: string) => {
        await runChat(threadId, getUrl);
      }),
    );
}

function isTopLevelHeader(line: string): boolean {
  return line.replace(/\x1b\[[0-9;]*m/g, "").startsWith("── ");
}

function splitSections(text: string): string[] {
  const sections: string[] = [];
  for (const line of text.split("\n")) {
    if (isTopLevelHeader(line) || sections.length === 0) {
      sections.push(line);
    } else {
      sections[sections.length - 1] += `\n${line}`;
    }
  }
  return sections.map((section) => section.trimEnd());
}

function canApproveOrDeny(interaction: PendingInteraction): boolean {
  return (
    isApprovalPendingInteractionPayload(interaction.payload) &&
    interaction.payload.subject.kind !== "permission_grant"
  );
}

async function runChat(threadId: string, getUrl: () => string): Promise<void> {
  const sdk = createCliBbSdk(getUrl());
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const herdr = createHerdrReporter({
    sessionId: threadId,
    resumeArgv: ["room-cli", "thread", "chat", threadId],
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "› ",
  });
  const write = (text: string) => {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`${text}\n`);
    rl.prompt(true);
  };

  let segmentId: string | null = null;
  let printedSections = 0;
  const printTimeline = async (settled: boolean) => {
    const { rows } = await sdk.threads.timeline({
      threadId,
      segmentLimit: "1",
    });
    if ((rows[0]?.id ?? null) !== segmentId) {
      segmentId = rows[0]?.id ?? null;
      printedSections = 0;
    }
    const sections = splitSections(formatThreadTimelineText(rows, { color }));
    const end = settled ? sections.length : sections.length - 1;
    for (; printedSections < end; printedSections++) {
      write(`\n${sections[printedSections]}`);
    }
  };

  const thread = await sdk.threads.get({ threadId });
  const where = thread.executionTarget === "cloud" ? "Cloud" : "Local";
  console.log(
    `${thread.title ?? thread.titleFallback ?? threadId} (${where}, ${thread.providerId})\n${HELP}`,
  );
  let busy = BUSY_STATUSES.has(thread.status);
  await printTimeline(!busy);

  let closed = false;
  let approvalId: string | null = null;
  const showPrompt = () => {
    const prompt = busy ? "(working) › " : "› ";
    if (prompt === rl.getPrompt()) return;
    rl.setPrompt(prompt);
    rl.prompt(true);
  };

  const handleLine = async (text: string) => {
    if (text === "") return rl.prompt();
    if (text === "/exit") return rl.close();
    if (text === "/stop") {
      await sdk.threads.stop({ threadId });
      return write("Stopped.");
    }
    if (text === "/approve" || text === "/deny") {
      if (approvalId === null) return write("Nothing is waiting for approval.");
      await resolveBinaryInteraction({
        action: text === "/approve" ? "approve" : "deny",
        getUrl,
        interactionId: approvalId,
        threadId,
      });
      return rl.prompt(true);
    }
    const response = await postThreadMessage({ getUrl, threadId, message: text });
    if (response.delivery === "queued") {
      write(describeThreadTellOutcome(threadId, response));
    }
    rl.prompt(true);
  };
  rl.on("close", () => {
    closed = true;
  });
  rl.on("SIGINT", () => rl.close());
  rl.on("line", (line) => {
    void handleLine(line.trim()).catch((error: unknown) =>
      write(`Error: ${getErrorMessage(error)}`),
    );
  });

  const announced = new Set<string>();
  let lastError = "";
  const tick = async () => {
    const { status } = await sdk.threads.get({ threadId });
    const wasBusy = busy;
    busy = BUSY_STATUSES.has(status);
    if (busy || wasBusy) await printTimeline(!busy);
    const pending = busy
      ? (await sdk.threads.interactions.list({ threadId })).filter(
          (interaction) => interaction.status === "pending",
        )
      : [];
    for (const interaction of pending) {
      if (announced.has(interaction.id)) continue;
      announced.add(interaction.id);
      const hint = canApproveOrDeny(interaction)
        ? "Reply /approve or /deny."
        : `Answer it in the Cloudroom app or with \`room-cli thread interactions list ${threadId}\`.`;
      write(
        `\nWaiting for you: ${formatPendingInteractionSummary({ interaction })}\n${hint}`,
      );
    }
    approvalId = pending.find(canApproveOrDeny)?.id ?? null;
    const summary = pending[0]
      ? formatPendingInteractionSummary({ interaction: pending[0] })
      : undefined;
    herdr?.report(
      summary ? "blocked" : busy ? "working" : "idle",
      summary,
    );
    showPrompt();
  };

  showPrompt();
  while (!closed) {
    try {
      await tick();
      lastError = "";
    } catch (error) {
      const message = `Cloudroom unreachable, retrying: ${getErrorMessage(error)}`;
      if (message !== lastError) write(message);
      lastError = message;
    }
    if (!closed) await sleep(POLL_INTERVAL_MS);
  }
  await herdr?.release();
  process.stdout.write("\n");
}
