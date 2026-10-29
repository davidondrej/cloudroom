import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import type { ComposerView } from "@get-bb/plugin-sdk";
import {
  useAppCommandContext,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { appToast } from "@/components/ui/app-toast";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import {
  PluginComposerHostProvider,
  PluginComposerViewProvider,
  type PluginComposerHost,
} from "./plugin-composer-host";

interface ComposerExtensionController {
  host: PluginComposerHost | null;
  view: ComposerView;
  focus(): boolean;
}

interface UseComposerExtensionControllerOptions {
  host: PluginComposerHost | null;
  view: ComposerView;
  isFocused: boolean;
  isPrimary: boolean;
  collapseIfFocused?(): boolean;
  focusDefault(): boolean;
  attachFiles?(files: File[]): void;
}

async function fetchImageFile(imageUrl: string): Promise<File> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Image request failed with ${response.status}`);
  }
  const blob = await response.blob();
  const url = new URL(imageUrl, window.location.href);
  const name = (url.searchParams.get("path") ?? url.pathname).split("/").at(-1);
  return new File(
    [blob],
    name && /^[^%]+\.\w+$/u.test(name)
      ? name
      : `image.${blob.type.split("/")[1] ?? "png"}`,
    { type: blob.type },
  );
}

export function useComposerExtensionController({
  host,
  view,
  isFocused,
  isPrimary,
  collapseIfFocused,
  focusDefault,
  attachFiles,
}: UseComposerExtensionControllerOptions): ComposerExtensionController {
  const focus = useCallback(() => {
    if (!isFocused || !isPrimary) return false;
    if (collapseIfFocused?.()) return true;
    if (host !== null) {
      host.focus();
      return true;
    }
    return focusDefault();
  }, [collapseIfFocused, focusDefault, host, isFocused, isPrimary]);
  useAppCommandContext("promptAvailable", true);
  useAppCommandHandler("composer.focus", focus);
  useEffect(() => {
    const desktop = getBbDesktopInfo();
    if (
      !desktop?.onAddImageToChat ||
      !attachFiles ||
      !isFocused ||
      !isPrimary
    ) {
      return;
    }
    return desktop.onAddImageToChat((imageUrl) => {
      void fetchImageFile(imageUrl).then(
        (file) => {
          attachFiles([file]);
          if (host !== null) host.focus();
          else focusDefault();
        },
        () => appToast.error("Could not add the image to chat."),
      );
    });
  }, [attachFiles, focusDefault, host, isFocused, isPrimary]);

  return useMemo(() => ({ host, view, focus }), [focus, host, view]);
}

export function ComposerExtensionHost({
  controller,
  defaultRenderer,
}: {
  controller: ComposerExtensionController;
  defaultRenderer: ReactNode;
}) {
  return (
    <PluginComposerViewProvider value={controller.view}>
      <PluginComposerHostProvider value={controller.host}>
        {defaultRenderer}
      </PluginComposerHostProvider>
    </PluginComposerViewProvider>
  );
}
