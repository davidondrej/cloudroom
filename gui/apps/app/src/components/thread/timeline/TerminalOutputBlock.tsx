import { useMemo } from "react";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { getDetailScrollMaxHeightClass } from "../../ui/detail-scroll-size.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import { terminalOutputHtml } from "./terminal-output-html.js";

interface TerminalOutputBlockProps {
  output: string;
  commandLine: string;
  exitCode: number | null;
  metadataLines: readonly string[];
  streaming: boolean;
}

interface TerminalScrollContentKeyArgs {
  commandLine: string;
  exitCode: number | null;
  metadataLines: readonly string[];
  output: string;
}

const ANSI_COLOR_INDEXES = Array.from({ length: 16 }, (_, index) => index);
const BACKGROUND_RESET_STYLE = "background-color:var(--background)";
const BACKGROUND_RESET_CONTRAST_STYLE = `${BACKGROUND_RESET_STYLE};color:var(--foreground)`;

function addBackgroundContrastColors(html: string): string {
  let out = html;
  for (const colorIndex of ANSI_COLOR_INDEXES) {
    const backgroundStyle = `background-color:var(--ansi-${colorIndex})`;
    out = out.replaceAll(
      backgroundStyle,
      `${backgroundStyle};color:var(--ansi-bg-fg-${colorIndex})`,
    );
  }
  return out.replaceAll(
    BACKGROUND_RESET_STYLE,
    BACKGROUND_RESET_CONTRAST_STYLE,
  );
}

function stringLengthSum(values: readonly string[]): number {
  let length = 0;
  for (const value of values) {
    length += value.length;
  }
  return length;
}

function terminalScrollContentKey({
  commandLine,
  exitCode,
  metadataLines,
  output,
}: TerminalScrollContentKeyArgs): string {
  return [
    commandLine.length,
    stringLengthSum(metadataLines),
    output.length,
    exitCode ?? "",
  ].join(":");
}

export function TerminalOutputBlock({
  commandLine,
  exitCode,
  metadataLines,
  output,
  streaming,
}: TerminalOutputBlockProps) {
  const renderedOutputHtml = useMemo(
    () =>
      output.length > 0
        ? addBackgroundContrastColors(terminalOutputHtml(output))
        : null,
    [output],
  );

  const showExitCode = exitCode !== null;
  const outputContentKey = terminalScrollContentKey({
    commandLine,
    exitCode,
    metadataLines,
    output,
  });

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="px-4 py-3 font-mono text-xs leading-tight text-foreground opacity-70">
        {commandLine ? (
          <div
            className={cn(
              "overflow-auto whitespace-pre-wrap break-words",
              getDetailScrollMaxHeightClass("base"),
            )}
          >
            {commandLine}
          </div>
        ) : null}
        {metadataLines.map((line, index) => (
          <div key={`${index}:${line}`} className="mt-1 text-muted-foreground">
            {line}
          </div>
        ))}
        {renderedOutputHtml ? (
          <TimelineDetailScroll
            size="base"
            streaming={streaming}
            contentKey={outputContentKey}
            className="mt-1.5"
            scrollClassName="whitespace-pre leading-tight text-muted-foreground"
          >
            <div dangerouslySetInnerHTML={{ __html: renderedOutputHtml }} />
          </TimelineDetailScroll>
        ) : null}
        {showExitCode ? (
          <div className="mt-1.5 font-mono text-xs leading-tight text-muted-foreground">
            exit code {exitCode}
          </div>
        ) : null}
      </div>
    </div>
  );
}
