import { join } from "node:path";
import {
  app,
  clipboard,
  Menu,
  type ContextMenuParams,
  type DownloadItem,
  type Event,
  type MenuItemConstructorOptions,
  type Session,
} from "electron";
import { BB_DESKTOP_ADD_IMAGE_TO_CHAT_CHANNEL } from "./desktop-window-command-ipc.js";

export interface DesktopContextMenuWebContents {
  on(
    eventName: "context-menu",
    listener: (event: Event, params: ContextMenuParams) => void,
  ): void;
  copyImageAt(x: number, y: number): void;
  downloadURL(url: string): void;
  replaceMisspelling(text: string): void;
  send(channel: string, payload: unknown): void;
  session: Pick<
    Session,
    "addWordToSpellCheckerDictionary" | "setSpellCheckerEnabled"
  > & {
    once(
      eventName: "will-download",
      listener: (event: Event, item: DownloadItem) => void,
    ): unknown;
  };
}

interface DesktopContextMenuSpellcheckContext {
  dictionarySuggestions: string[];
  misspelledWord: string;
}

interface BuildDesktopContextMenuTemplateArgs {
  params: ContextMenuParams;
  webContents: Pick<
    DesktopContextMenuWebContents,
    "copyImageAt" | "downloadURL" | "replaceMisspelling" | "send" | "session"
  >;
}

interface RegisterDesktopContextMenuArgs {
  webContents: DesktopContextMenuWebContents;
}

function pushSeparatorIfNeeded(template: MenuItemConstructorOptions[]): void {
  if (template.length === 0) {
    return;
  }
  if (template.at(-1)?.type === "separator") {
    return;
  }
  template.push({ type: "separator" });
}

function trimTrailingSeparator(
  template: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  if (template.at(-1)?.type !== "separator") {
    return template;
  }
  return template.slice(0, -1);
}

function imageFileName(srcURL: string, fallback: string): string {
  try {
    const url = new URL(srcURL);
    const name = (
      url.searchParams.get("path") ?? decodeURIComponent(url.pathname)
    )
      .split(/[/\\]/u)
      .at(-1);
    if (name !== undefined && /^[\p{L}\p{N} ._()-]+\.\w+$/u.test(name)) {
      return name;
    }
  } catch {}
  return fallback;
}

function getSpellcheckContextFromParams(
  params: ContextMenuParams,
): DesktopContextMenuSpellcheckContext | null {
  if (!params.isEditable || params.misspelledWord.length === 0) {
    return null;
  }
  return {
    dictionarySuggestions: params.dictionarySuggestions,
    misspelledWord: params.misspelledWord,
  };
}

export function buildDesktopContextMenuTemplate({
  params,
  webContents,
}: BuildDesktopContextMenuTemplateArgs): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const spellcheckContext = getSpellcheckContextFromParams(params);

  if (spellcheckContext !== null) {
    if (spellcheckContext.dictionarySuggestions.length > 0) {
      for (const suggestion of spellcheckContext.dictionarySuggestions) {
        template.push({
          label: suggestion,
          click: () => {
            webContents.replaceMisspelling(suggestion);
          },
        });
      }
    } else {
      template.push({
        label: "No Spelling Suggestions",
        enabled: false,
      });
    }
    template.push({
      label: `Add "${spellcheckContext.misspelledWord}" to Dictionary`,
      click: () => {
        webContents.session.addWordToSpellCheckerDictionary(
          spellcheckContext.misspelledWord,
        );
      },
    });
    pushSeparatorIfNeeded(template);
  }

  if (params.linkURL.length > 0) {
    template.push({
      label: "Copy Link",
      click: () => {
        clipboard.writeText(params.linkURL);
      },
    });
    pushSeparatorIfNeeded(template);
  }

  if (params.mediaType === "image" && params.hasImageContents) {
    template.push(
      {
        label: "Add to Chat",
        click: () => {
          webContents.send(BB_DESKTOP_ADD_IMAGE_TO_CHAT_CHANNEL, params.srcURL);
        },
      },
      {
        label: "Copy Image",
        click: () => {
          webContents.copyImageAt(params.x, params.y);
        },
      },
      {
        label: "Save Image As…",
        click: () => {
          webContents.session.once("will-download", (_event, item) => {
            item.setSaveDialogOptions({
              defaultPath: join(
                app.getPath("downloads"),
                imageFileName(params.srcURL, item.getFilename()),
              ),
            });
          });
          webContents.downloadURL(params.srcURL);
        },
      },
    );
    return template;
  }

  if (params.isEditable) {
    const { editFlags } = params;
    template.push(
      { role: "undo", enabled: editFlags.canUndo },
      { role: "redo", enabled: editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: editFlags.canCut },
      { role: "copy", enabled: editFlags.canCopy },
      { role: "paste", enabled: editFlags.canPaste },
      { role: "delete", enabled: editFlags.canDelete },
      { type: "separator" },
      { role: "selectAll", enabled: editFlags.canSelectAll },
    );
    return trimTrailingSeparator(template);
  }

  if (params.selectionText.length > 0 && params.editFlags.canCopy) {
    template.push({ role: "copy", enabled: true });
  }
  if (params.editFlags.canSelectAll) {
    template.push({ role: "selectAll", enabled: true });
  }

  return trimTrailingSeparator(template);
}

function showDesktopContextMenu({
  params,
  webContents,
}: RegisterDesktopContextMenuArgs & {
  params: ContextMenuParams;
}): void {
  const template = buildDesktopContextMenuTemplate({
    params,
    webContents,
  });
  if (template.length === 0) {
    return;
  }
  Menu.buildFromTemplate(template).popup();
}

export function registerDesktopContextMenu({
  webContents,
}: RegisterDesktopContextMenuArgs): void {
  webContents.session.setSpellCheckerEnabled(true);
  webContents.on("context-menu", (_event, params) => {
    showDesktopContextMenu({ params, webContents });
  });
}
