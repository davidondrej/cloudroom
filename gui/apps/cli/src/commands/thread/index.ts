import { registerContextCommand } from "./context.js";
import { Command } from "commander";
import { registerActionsCommands } from "./actions.js";
import { registerChatCommand } from "./chat.js";
import { registerCountCommand } from "./count.js";
import { registerInteractionCommands } from "./interactions.js";
import { registerListCommand } from "./list.js";
import { registerOpenCommand } from "./open.js";
import { registerPaneCommand } from "./pane.js";
import { registerOrganizationCommands } from "./organization.js";
import { registerShowCommand } from "./show.js";
import { registerSpawnCommand } from "./spawn.js";
import { registerForkCommand } from "./fork.js";
import { registerWorktreeCommand } from "./worktree.js";
import { registerWaitCommand } from "./wait.js";

export function registerThreadCommands(
  program: Command,
  getUrl: () => string,
): void {
  const thread = program
    .command("thread")
    .description("Manage Local and Cloud threads");
  thread.addHelpText(
    "after",
    "\nCloud messages queue automatically. Check `room-cli cloud status --json` for core/harness support for steering, attachments, compaction, message editing, and queue changes. Forks, child launches, and scheduling are not enabled. Verify actual output; idle alone does not prove queued work completed.",
  );
  registerWaitCommand(thread, getUrl);
  registerSpawnCommand(thread, getUrl);
  registerForkCommand(thread, getUrl);
  registerWorktreeCommand(thread, getUrl);
  registerListCommand(thread, getUrl);
  registerCountCommand(thread, getUrl);
  registerContextCommand(thread, getUrl);
  registerShowCommand(thread, getUrl);
  registerOpenCommand(thread, getUrl);
  registerPaneCommand(thread, getUrl);
  registerOrganizationCommands(thread, getUrl);
  registerActionsCommands(thread, getUrl);
  registerChatCommand(thread, getUrl);
  registerInteractionCommands(thread, getUrl);
}
