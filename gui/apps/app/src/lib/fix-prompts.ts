import { COMPUTER } from "@cloudroom/domain";

const CLI_PATH =
  "/Applications/Cloudroom.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/room-cli";
const RELEASES_URL = "https://github.com/davidondrej/cloudroom-gui/releases";

const said = (text?: string | null) =>
  text?.trim() ? `: "${text.trim().replace(/\s+/g, " ").slice(0, 400)}".` : ".";

const fixPrompt = (problem: string, look: string) =>
  `${problem} ${look} Find the root cause and fix it without losing any work, then tell me what was wrong. If \`room-cli\` is not on your PATH, use ${CLI_PATH}.`;

export const cloudThreadFixPrompt = (threadId: string, agent: string, error?: string | null) =>
  fixPrompt(
    `My Cloudroom Cloud thread ${threadId} (${agent}) failed${said(error)}`,
    `Investigate with \`room-cli thread show ${threadId}\` and \`room-cli vm run '<command>'\` on my cloud VM.`,
  );

export const syncFixPrompt = (state: string, issue?: string | null) =>
  fixPrompt(
    `Cloudroom's automatic sync between this computer and my cloud VM is not working (state: ${state})${said(issue)}`,
    "Check `room-cli cloud status --json`, ~/.gui-cloudroom/cloudroom-sync/, and the logs in ~/.gui-cloudroom/logs/.",
  );

export const projectFilesFixPrompt = (threadId: string, error?: string | null) =>
  fixPrompt(
    `Cloudroom could not move my work to the cloud for thread ${threadId}${said(error)}`,
    `Check \`room-cli thread show ${threadId}\` and \`room-cli cloud thread-workspace ${threadId}\`, then copy any missing project files with \`room-cli vm push\`.`,
  );

export const cloudUnavailableFixPrompt = (error?: string | null) =>
  fixPrompt(
    `My Cloudroom desktop app cannot reach my cloud VM${said(error)}`,
    "Check `room-cli cloud status --json`, then run `room-cli vm run 'systemctl status cloudroom --no-pager; df -h'` if the VM answers.",
  );

export const crashFixPrompt = (error: string) =>
  fixPrompt(
    `The Cloudroom desktop app crashed${said(error)}`,
    "Check the logs in ~/.gui-cloudroom/logs/ and `room-cli status --json`.",
  );

export const phoneCrashFixPrompt = (error: string, host: string, page: string, macOff: boolean) =>
  `The Cloudroom phone app (${host}) crashed on ${page} while my ${COMPUTER} was ${macOff ? "off" : "on"}${said(error)} Tell me what most likely went wrong and how to get it working again. If my ${COMPUTER} is on, check \`room-cli status --json\` there.`;

export const appUpdateFixPrompt = (current: string, latest: string | null) =>
  `Update my Cloudroom desktop app from version ${current} to ${latest ?? "the newest version"}. Download the newest release for this computer from ${RELEASES_URL}, quit Cloudroom, replace the old app (on macOS: /Applications/Cloudroom.app), and reopen it. Do not delete ~/.gui-cloudroom; it holds my data. Confirm the new version when you are done.`;
