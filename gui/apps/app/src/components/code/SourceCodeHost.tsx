import { Suspense, lazy, type ReactNode } from "react";
import { PluginReplacementSlot } from "@/components/plugin/PluginReplacementSlot";
import { deprecatedOriginalAlias } from "@/lib/plugin-sdk-deprecated-aliases";
import { useSourceCodeRendererReplacement } from "./codeRendererProvider";
import {
  DEFAULT_CODE_OVERFLOW,
  type RoomSourceCodeProps,
} from "./code-rendering";

const SOURCE_CODE_RENDERER_SLOT_KIND = "sourceCodeRenderer";

const RoomSourceCode = lazy(() => import("./RoomSourceCode"));

interface SourceCodeHostProps extends Omit<
  RoomSourceCodeProps,
  "overflow" | "highlightedLines"
> {
  overflow?: RoomSourceCodeProps["overflow"];
  highlightedLines?: RoomSourceCodeProps["highlightedLines"];
  fallback?: ReactNode;
}

export function SourceCodeHost({
  content,
  path,
  cacheKey,
  overflow = DEFAULT_CODE_OVERFLOW,
  highlightedLines = null,
  className,
  fallback = null,
  scrollToHighlightedLines,
  onSelectionAddToChat,
}: SourceCodeHostProps) {
  const replacement = useSourceCodeRendererReplacement();

  const original = (
    <Suspense fallback={fallback}>
      <RoomSourceCode
        content={content}
        path={path}
        cacheKey={cacheKey}
        overflow={overflow}
        highlightedLines={highlightedLines}
        className={className}
        scrollToHighlightedLines={scrollToHighlightedLines}
        onSelectionAddToChat={onSelectionAddToChat}
      />
    </Suspense>
  );

  return (
    <PluginReplacementSlot
      replacement={replacement}
      original={original}
      slotKind={SOURCE_CODE_RENDERER_SLOT_KIND}
    >
      {(slot, BoundOriginal) => (
        <div className={className}>
          <slot.component
            content={content}
            path={path}
            overflow={overflow}
            highlightedLines={highlightedLines}
            Original={BoundOriginal}
            experimental_Original={deprecatedOriginalAlias(BoundOriginal)}
          />
        </div>
      )}
    </PluginReplacementSlot>
  );
}
