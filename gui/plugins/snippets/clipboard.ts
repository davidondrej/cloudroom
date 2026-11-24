import { useCallback, useEffect, useRef } from "react";

// Only text copied or pasted in a Cloudroom chat enters this opt-in, in-memory history.
export function useClipboardHistory(owner: string | null, enabled: boolean) {
  const history = useRef<string[]>([]);
  const remember = useCallback(
    (text: string) => {
      if (
        enabled &&
        text &&
        text.length <= 65536 &&
        history.current[0] !== text
      ) {
        history.current = [
          text,
          ...history.current.filter((item) => item !== text),
        ].slice(0, 20);
      }
    },
    [enabled],
  );
  useEffect(() => {
    history.current = [];
    if (!enabled) return;
    function record(event: ClipboardEvent) {
      const element = (node: EventTarget | null) =>
        node instanceof Element
          ? node
          : node instanceof Node
            ? node.parentElement
            : null;
      const chat = "[data-cloudroom-composer],[data-timeline-row-id]";
      const selection = document.getSelection();
      if (
        event.type === "paste"
          ? !element(event.target)?.closest(chat)
          : !element(selection?.anchorNode ?? null)?.closest(chat) ||
            !element(selection?.focusNode ?? null)?.closest(chat)
      )
        return;
      remember(
        event.type === "paste"
          ? (event.clipboardData?.getData("text/plain") ?? "")
          : (document.getSelection()?.toString() ?? ""),
      );
    }
    const copied = (event: Event) =>
      remember((event as CustomEvent<string>).detail);
    document.addEventListener("cloudroom:chat-copied", copied);
    for (const name of ["copy", "cut", "paste"] as const)
      document.addEventListener(name, record, true);
    return () => {
      document.removeEventListener("cloudroom:chat-copied", copied);
      for (const name of ["copy", "cut", "paste"] as const)
        document.removeEventListener(name, record, true);
      history.current = [];
    };
  }, [owner, enabled, remember]);
  return {
    remember,
    read: (current: string) =>
      enabled
        ? [current, ...history.current.filter((text) => text !== current)]
        : undefined,
  };
}
