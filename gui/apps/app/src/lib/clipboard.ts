import { useCallback, useEffect, useState } from "react";
import { appToast } from "@/components/ui/app-toast";

interface CopyToClipboardOptions {
  successMessage?: string | null;
  errorMessage?: string | null;
  imageUrl?: string;
  html?: string;
  chatMessage?: boolean;
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type.toLowerCase() === "image/png") {
    return blob;
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = document.createElement("img");
    image.src = objectUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("The browser cannot convert the clipboard image");
    }
    context.drawImage(image, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
          return;
        }
        reject(new Error("The browser cannot encode the clipboard image"));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function fetchClipboardImage(imageUrl: string): Promise<Blob> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(
      `The clipboard image request failed with ${response.status}`,
    );
  }
  return convertImageBlobToPng(await response.blob());
}

function copyWithEditingCommand(text: string, html?: string): boolean {
  if (
    typeof document === "undefined" ||
    document.body === null ||
    typeof document.execCommand !== "function"
  ) {
    return false;
  }

  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const selection = document.getSelection();
  const selectedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const textarea = document.createElement("textarea");
  textarea.value = html !== undefined && text.length === 0 ? " " : text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    border: "0",
    height: "1px",
    left: "0",
    opacity: "0",
    padding: "0",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: "1px",
  });
  document.body.append(textarea);

  let copied = false;
  let richCopied = false;
  const onCopy =
    html === undefined
      ? null
      : (event: ClipboardEvent) => {
          if (!event.clipboardData) return;
          event.clipboardData.setData("text/plain", text);
          event.clipboardData.setData("text/html", html);
          event.preventDefault();
          richCopied = true;
        };
  if (onCopy) {
    document.addEventListener("copy", onCopy, { once: true });
  }
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    copied = document.execCommand("copy") && (onCopy === null || richCopied);
  } catch {
    copied = false;
  } finally {
    if (onCopy) {
      document.removeEventListener("copy", onCopy);
    }
    textarea.remove();
    if (activeElement?.isConnected) {
      activeElement.focus({ preventScroll: true });
    }
    if (selection) {
      selection.removeAllRanges();
      for (const range of selectedRanges) {
        selection.addRange(range);
      }
    }
  }
  return copied;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  return copyWithEditingCommand(text);
}

async function copyTextAndHtmlToClipboard(
  text: string,
  html: string,
): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    } catch {}
  }
  if (copyWithEditingCommand(text, html)) {
    return true;
  }
  return copyTextToClipboard(text);
}

async function copyTextAndImageToClipboard(
  text: string,
  imageUrl: string,
): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    return false;
  }

  try {
    const imageBlob = fetchClipboardImage(imageUrl);
    void imageBlob.catch(() => undefined);
    const clipboardData: Record<string, Blob | Promise<Blob>> = {
      "image/png": imageBlob,
    };
    if (text.length > 0) {
      clipboardData["text/plain"] = new Blob([text], { type: "text/plain" });
    }
    await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
    return true;
  } catch {
    return false;
  }
}

export async function copyToClipboardWithToast(
  text: string,
  {
    successMessage = "Copied",
    errorMessage = "Failed to copy",
    imageUrl,
    html,
    chatMessage,
  }: CopyToClipboardOptions = {},
): Promise<boolean> {
  const copied = imageUrl
    ? await copyTextAndImageToClipboard(text, imageUrl)
    : html !== undefined
      ? await copyTextAndHtmlToClipboard(text, html)
      : await copyTextToClipboard(text);
  if (copied) {
    if (chatMessage) document.dispatchEvent(new CustomEvent("cloudroom:chat-copied", { detail: text }));
    if (successMessage) appToast.success(successMessage);
    return true;
  }
  if (errorMessage) appToast.error(errorMessage);
  return false;
}

export interface ClipboardCopyOptions
  extends Omit<CopyToClipboardOptions, "html"> {
  text: string;
  /** How long `copied` stays true. */
  resetMs?: number;
}

export function useClipboardCopy({
  text,
  successMessage = null,
  errorMessage = "Failed to copy",
  imageUrl,
  chatMessage,
  resetMs = 2000,
}: ClipboardCopyOptions) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), resetMs);
    return () => window.clearTimeout(timeoutId);
  }, [copied, resetMs]);

  const copy = useCallback(async (event?: { currentTarget: EventTarget | null }) => {
    if ((!text && !imageUrl) || copied) return;
    const success = await copyToClipboardWithToast(text, {
      successMessage,
      errorMessage,
      imageUrl,
      chatMessage: chatMessage || (event?.currentTarget instanceof Element && !!event.currentTarget.closest("[data-timeline-row-id]")),
    });
    if (success) setCopied(true);
  }, [text, imageUrl, copied, successMessage, errorMessage, chatMessage]);

  return { copied, copy };
}
