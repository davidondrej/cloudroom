import type { ILink, ILinkProvider, Terminal } from "ghostty-web";

export interface TerminalLinkTarget {
  source: "detected-url" | "osc8";
  uri: string;
}

interface TerminalLinkHandlers {
  onActivate: (target: TerminalLinkTarget) => void;
  onHover: (target: TerminalLinkTarget | null) => void;
}

interface RequestTerminalLinkOpenArgs {
  openLink: (uri: string) => void;
  requestConfirmation: (target: TerminalLinkTarget) => void;
  target: TerminalLinkTarget;
}

interface TerminalLinkDetectorHost {
  linkDetector?: { providers: ILinkProvider[] };
}

export function routeTerminalLinks(
  provider: ILinkProvider,
  source: TerminalLinkTarget["source"],
  { onActivate, onHover }: TerminalLinkHandlers,
): ILinkProvider {
  return {
    provideLinks: (y, callback) =>
      provider.provideLinks(y, (links) =>
        callback(
          links?.map(
            (link): ILink => ({
              ...link,
              activate: (event) => {
                if (event.button === 0) {
                  onActivate({ source, uri: link.text });
                }
              },
              hover: (isHovered) => {
                onHover(isHovered ? { source, uri: link.text } : null);
              },
            }),
          ),
        ),
      ),
  };
}

export function replaceTerminalLinkProviders(
  terminal: Terminal,
  providers: readonly ILinkProvider[],
): void {
  const detector = (terminal as unknown as TerminalLinkDetectorHost)
    .linkDetector;
  if (detector === undefined) {
    throw new Error("Terminal links can be routed only after it opens");
  }
  detector.providers.length = 0;
  for (const provider of providers) {
    terminal.registerLinkProvider(provider);
  }
}

export function requestTerminalLinkOpen({
  openLink,
  requestConfirmation,
  target,
}: RequestTerminalLinkOpenArgs): void {
  if (target.source === "osc8") {
    requestConfirmation(target);
    return;
  }
  openLink(target.uri);
}
