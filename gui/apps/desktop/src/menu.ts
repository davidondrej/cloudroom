import {
  app,
  Menu,
  type BaseWindow,
  type MenuItemConstructorOptions,
} from "electron";
import type { ApplicationMenuAccelerators } from "./desktop-menu-shortcuts.js";
import type { ComputersFailure } from "./computers.js";

const SERVER_DAEMON_LOGS_MENU_LABEL =
  process.platform === "linux"
    ? "Server && Daemon Logs"
    : "Server & Daemon Logs";
const OPEN_NEW_TAB_MENU_LABEL = "New Tab";
const REOPEN_CLOSED_TAB_MENU_LABEL = "Reopen Closed Tab";
const NEW_THREAD_MENU_LABEL = "New Thread";
const NEW_WINDOW_MENU_LABEL = "New Window";
const ARCHIVE_THREAD_MENU_LABEL = "Archive Thread";
const CLOSE_WINDOW_MENU_LABEL = "Close Window";
const OPEN_SETTINGS_MENU_LABEL = "Settings…";
const TOGGLE_DEVELOPER_TOOLS_MENU_LABEL = "Toggle Developer Tools";
const TOGGLE_DEVELOPER_TOOLS_ACCELERATOR = "Command+Option+I";
const RELOAD_ACCELERATOR = "CommandOrControl+R";
const FORCE_RELOAD_ACCELERATOR = "CommandOrControl+Shift+R";
// Electron gives each zoom role one key. On Linux, Ctrl+=, numpad −, and
// numpad 0 don't match it, so add them as hidden duplicates.
const LINUX_EXTRA_ZOOM_ITEMS: MenuItemConstructorOptions[] = [
  { role: "zoomIn", accelerator: "CommandOrControl+=", visible: false },
  { role: "zoomIn", accelerator: "CommandOrControl+numadd", visible: false },
  { role: "zoomOut", accelerator: "CommandOrControl+numsub", visible: false },
  { role: "resetZoom", accelerator: "CommandOrControl+num0", visible: false },
];
const SERVER_MENU_LABEL = "Server";
const SERVER_MENU_ITEM_ID = "bb-server-menu";
export const SET_SERVER_URL_MENU_LABEL = "Set Server URL…";
const OTHER_COMPUTERS = process.platform === "darwin" ? "Macs" : "computers";
export const CONNECT_SERVERS_SKIPPED_MENU_LABELS: Record<
  ComputersFailure,
  string
> = {
  "no-credential": `No other ${OTHER_COMPUTERS} — sign in to Cloudroom`,
  offline: `No other ${OTHER_COMPUTERS} — could not reach Cloudroom Connect`,
  unauthorized: `No other ${OTHER_COMPUTERS} — sign in to Cloudroom again`,
  unavailable: `No other ${OTHER_COMPUTERS} — could not reach Cloudroom Connect`,
};

interface ApplicationMenuServerItem {
  checked: boolean;
  id: string;
  name: string;
}

export interface InstallApplicationMenuArgs {
  accelerators: ApplicationMenuAccelerators;
  isLinux: boolean;
  isMac: boolean;
  openAbout(): void;
  openNewTab(): void;
  openNewThread(): void;
  openSettings(): void;
  reopenClosedTab(): void;
  reloadWindow(
    browserWindow: BaseWindow | undefined,
    ignoreCache: boolean,
  ): void;
  archiveThread(): void;
  closeWindowOrSideTab(browserWindow: BaseWindow | undefined): void;
  createNewWindow(): void;
  openServerDaemonLogs(): void;
  selectServer(serverId: string): void;
  setServerUrl(): void;
  onServerMenuWillShow?: () => void;
  serverDaemonLogsMenuEnabled: boolean;
  servers: ApplicationMenuServerItem[];
  connectServersSkipReason: ComputersFailure | null;
}

function createServerDaemonLogsMenuItems(
  args: InstallApplicationMenuArgs,
): MenuItemConstructorOptions[] {
  return [
    { type: "separator" },
    {
      enabled: args.serverDaemonLogsMenuEnabled,
      label: SERVER_DAEMON_LOGS_MENU_LABEL,
      click() {
        args.openServerDaemonLogs();
      },
    },
  ];
}

function createServerMenuItems(
  args: InstallApplicationMenuArgs,
): MenuItemConstructorOptions[] {
  const serverItems: MenuItemConstructorOptions[] = args.servers.map(
    (server) => ({
      checked: server.checked,
      click() {
        args.selectServer(server.id);
      },
      id: server.id,
      label: server.name,
      type: "radio" as const,
    }),
  );
  const skipReason = args.connectServersSkipReason;
  return [
    ...serverItems,
    ...(skipReason === null
      ? []
      : [
          {
            enabled: false,
            label: CONNECT_SERVERS_SKIPPED_MENU_LABELS[skipReason],
          },
        ]),
    { type: "separator" },
    {
      label: SET_SERVER_URL_MENU_LABEL,
      click() {
        args.setServerUrl();
      },
    },
  ];
}

export function buildApplicationMenuTemplate(
  args: InstallApplicationMenuArgs,
): MenuItemConstructorOptions[] {
  return [
    {
      label: app.name,
      submenu: [
        {
          label: `About ${app.name}`,
          click() {
            args.openAbout();
          },
        },
        { type: "separator" },
        {
          accelerator: args.accelerators.openSettings,
          click() {
            args.openSettings();
          },
          label: OPEN_SETTINGS_MENU_LABEL,
        },
        { type: "separator" },
        ...(args.isMac
          ? [
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
            ]
          : []),
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          accelerator: args.accelerators.openNewTab,
          click() {
            args.openNewTab();
          },
          label: OPEN_NEW_TAB_MENU_LABEL,
        },
        {
          accelerator: args.accelerators.reopenClosedTab,
          click() {
            args.reopenClosedTab();
          },
          label: REOPEN_CLOSED_TAB_MENU_LABEL,
        },
        {
          accelerator: args.accelerators.openNewThread,
          click() {
            args.openNewThread();
          },
          label: NEW_THREAD_MENU_LABEL,
        },
        {
          accelerator: args.accelerators.createNewWindow,
          click() {
            args.createNewWindow();
          },
          label: NEW_WINDOW_MENU_LABEL,
        },
        { type: "separator" },
        {
          accelerator: args.accelerators.archiveThread,
          click() {
            args.archiveThread();
          },
          label: ARCHIVE_THREAD_MENU_LABEL,
        },
        {
          accelerator: args.accelerators.closeWindowOrSideTab,
          click(_menuItem, browserWindow) {
            if (browserWindow === null) {
              if (args.isMac) {
                Menu.sendActionToFirstResponder("performClose:");
              }
              return;
            }
            args.closeWindowOrSideTab(browserWindow);
          },
          label: CLOSE_WINDOW_MENU_LABEL,
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          accelerator: RELOAD_ACCELERATOR,
          label: "Reload",
          registerAccelerator: false,
          click(_menuItem, browserWindow) {
            args.reloadWindow(browserWindow, false);
          },
        },
        {
          accelerator: FORCE_RELOAD_ACCELERATOR,
          label: "Force Reload",
          registerAccelerator: false,
          click(_menuItem, browserWindow) {
            args.reloadWindow(browserWindow, true);
          },
        },
        {
          accelerator: args.isMac
            ? TOGGLE_DEVELOPER_TOOLS_ACCELERATOR
            : "Control+Shift+I",
          label: TOGGLE_DEVELOPER_TOOLS_MENU_LABEL,
          role: "toggleDevTools",
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        ...(args.isLinux ? LINUX_EXTRA_ZOOM_ITEMS : []),
        ...(args.isMac || args.isLinux
          ? []
          : [
              { type: "separator" as const },
              { role: "togglefullscreen" as const },
            ]),
        ...createServerDaemonLogsMenuItems(args),
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(args.isMac ? [{ role: "zoom" as const }] : []),
        { type: "separator" },
        {
          id: SERVER_MENU_ITEM_ID,
          label: SERVER_MENU_LABEL,
          submenu: createServerMenuItems(args),
        },
        ...(args.isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : []),
      ],
    },
  ];
}

// On Linux the menu bar lives in the window, and every rebuild redraws it. Skip identical ones.
let installedMenuKey: string | null = null;

export function installApplicationMenu(args: InstallApplicationMenuArgs): void {
  const template = buildApplicationMenuTemplate(args);
  const key = JSON.stringify(template);
  if (key === installedMenuKey) return;
  installedMenuKey = key;
  const menu = Menu.buildFromTemplate(template);
  const onServerMenuWillShow = args.onServerMenuWillShow;
  if (onServerMenuWillShow !== undefined) {
    menu
      .getMenuItemById(SERVER_MENU_ITEM_ID)
      ?.submenu?.on("menu-will-show", () => {
        onServerMenuWillShow();
      });
  }
  Menu.setApplicationMenu(menu);
}
