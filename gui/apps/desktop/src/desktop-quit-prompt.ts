import { app, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import { localServerFetch } from "./local-caller-auth.js";

// Asks before a quit while agents are working, so an accidental Cmd+Q never stops them.
let allowed = false;
let checking = false;

// The system is shutting down, restarting, or logging out: never hold it up.
export function allowQuitWithoutAsking(): void {
  allowed = true;
}

// True when the quit can go ahead now. Otherwise asks the server what is
// running, asks the user if anything is, and calls `retry` to quit.
export function canQuitNow(serverUrl: string | null, retry: () => void): boolean {
  if (allowed) return true;
  if (!checking) {
    checking = true;
    // A slow or unproven server must never trap the user: after 3 s, just quit.
    const giveUp = new Promise<number>((resolve) => setTimeout(() => resolve(0), 3_000));
    void Promise.race([countWorkingAgents(serverUrl), giveUp])
      .catch(() => 0)
      .then((count) => count === 0 || askToQuit(count))
      .catch(() => true)
      .then((quit) => {
        checking = false;
        if (!quit) return;
        allowed = true;
        retry();
      });
  }
  return false;
}

// Starting or active threads in every project, Local and Cloud.
async function countWorkingAgents(serverUrl: string | null): Promise<number> {
  if (serverUrl === null) return 0;
  const response = await localServerFetch(
    `${serverUrl.replace(/\/$/u, "")}/api/v1/threads/running`,
    { signal: AbortSignal.timeout(2_000) },
  );
  const running: unknown = response.ok ? await response.json() : [];
  return Array.isArray(running) ? running.length : 0;
}

async function askToQuit(count: number): Promise<boolean> {
  // Quit from the Dock leaves another app in front; bring the box to the user.
  if (process.platform === "darwin") app.focus({ steal: true });
  const options: MessageBoxOptions = {
    buttons: ["Quit", "Cancel"],
    cancelId: 1,
    defaultId: 1,
    detail: "Quitting stops Local agents. Cloud agents keep running.",
    message:
      count === 1 ? "1 agent is still working." : `${count} agents are still working.`,
    noLink: true,
    type: "warning",
  };
  const parent = BrowserWindow.getFocusedWindow();
  const { response } =
    parent === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(parent, options);
  return response === 0;
}
