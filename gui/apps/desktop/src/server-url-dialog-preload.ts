import { ipcRenderer } from "electron";
import {
  ROOM_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL,
  ROOM_DESKTOP_SERVER_URL_DIALOG_SUBMIT_CHANNEL,
  serverUrlDialogSubmitResponseSchema,
} from "./server-url-dialog-ipc.js";

window.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form");
  const input = document.querySelector<HTMLInputElement>("input[name=url]");
  const error = document.querySelector<HTMLElement>("[data-error]");
  const cancel = document.querySelector<HTMLButtonElement>(
    "button[data-cancel]",
  );
  if (form === null || input === null || error === null || cancel === null) {
    return;
  }

  input.focus();
  input.select();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const payload: unknown = await ipcRenderer.invoke(
        ROOM_DESKTOP_SERVER_URL_DIALOG_SUBMIT_CHANNEL,
        { url: input.value },
      );
      const parsed = serverUrlDialogSubmitResponseSchema.safeParse(payload);
      if (parsed.success && !parsed.data.ok) {
        error.textContent = parsed.data.message;
      }
    })();
  });

  cancel.addEventListener("click", () => {
    ipcRenderer.send(ROOM_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      ipcRenderer.send(ROOM_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL);
    }
  });
});
