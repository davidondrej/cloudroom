import { useEffect, useState, type ReactNode } from "react";
import type { DocumentFilePreview } from "@cloudroom/client-core";
import { Icon } from "@cloudroom/shared-ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@cloudroom/shared-ui/select";
import { hashSourceContents } from "@/components/code/source-code-budget";
import type { DocumentPreview } from "@/lib/document-preview";
import type { FilePreviewState } from "./FilePreview";

interface Conversion {
  source: DocumentFilePreview;
  preview: DocumentPreview | null;
}

interface DocumentFilePreviewView {
  state: FilePreviewState;
  notice: ReactNode;
}

interface DocumentNoticeProps {
  preview: DocumentPreview;
  partIndex: number;
  onSelectPart: (index: number) => void;
}

function DocumentNotice({
  preview,
  partIndex,
  onSelectPart,
}: DocumentNoticeProps) {
  const part = preview.parts[partIndex];
  return (
    <div className="mx-4 mb-1 mt-2 flex shrink-0 items-center gap-2 rounded-md bg-surface-recessed px-2.5 py-1.5 text-xs text-muted-foreground">
      <Icon name="Info" className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{preview.label}</span>
      {preview.parts.length > 1 ? (
        <Select
          value={String(partIndex)}
          onValueChange={(value) => onSelectPart(Number(value))}
        >
          <SelectTrigger
            aria-label="Sheet"
            className="ml-auto h-6 w-auto shrink-0 gap-1 rounded border-border bg-background px-1.5 py-0 text-xs text-foreground"
          >
            <span>
              {part?.name} ({partIndex + 1} of {preview.parts.length})
            </span>
          </SelectTrigger>
          <SelectContent>
            {preview.parts.map((option, index) => (
              <SelectItem key={index} value={String(index)}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : preview.detail ? (
        <span className="ml-auto shrink-0">{preview.detail}</span>
      ) : null}
    </div>
  );
}

export function useDocumentFilePreview(
  filePreview: DocumentFilePreview | null,
): DocumentFilePreviewView | null {
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [partIndex, setPartIndex] = useState(0);

  useEffect(() => {
    if (!filePreview) return;
    let active = true;
    import("@/lib/document-preview")
      .then(({ convertDocument }) =>
        convertDocument(filePreview.format, filePreview.contentBytes),
      )
      .catch(() => null)
      .then((preview) => {
        if (active) setConversion({ source: filePreview, preview });
      });
    return () => {
      active = false;
    };
  }, [filePreview]);

  if (!filePreview) return null;
  if (conversion?.source !== filePreview) {
    return { state: { kind: "loading" }, notice: null };
  }
  const { preview } = conversion;
  if (!preview) {
    return {
      state: {
        kind: "error",
        message: `Preview not available for ${filePreview.mimeType}.`,
      },
      notice: null,
    };
  }
  const index = Math.min(partIndex, preview.parts.length - 1);
  const text = preview.parts[index]?.text ?? "";
  return {
    state:
      text.trim() === ""
        ? { kind: "empty" }
        : {
            kind: "ready",
            lineRange: null,
            textPreviewKind: preview.textKind,
            file: {
              cacheKey: `document-preview:${filePreview.path}:${index}:${hashSourceContents(text)}`,
              name: filePreview.name ?? filePreview.path,
              contents: text,
            },
          },
    notice: (
      <DocumentNotice
        preview={preview}
        partIndex={index}
        onSelectPart={setPartIndex}
      />
    ),
  };
}
