import { useAtom } from "jotai";
import { useRef, useState } from "react";
import { Button } from "@cloudroom/shared-ui/button";
import { Icon } from "@cloudroom/shared-ui/icon";
import { Input } from "@cloudroom/shared-ui/input";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cloudroom/shared-ui/dropdown-menu";
import { SettingsWithControl } from "@/components/ui/settings-section";
import {
  SETTINGS_DROPDOWN_CONTENT_CLASS,
  SETTINGS_DROPDOWN_TRIGGER_CLASS,
} from "@/components/settings/settings-dropdown";
import {
  BUNDLED_SCRIPT_FONT,
  CHAT_FONT_SIZES,
  CHAT_LINE_HEIGHTS,
  FONT_FILE_EXTENSIONS,
  SYSTEM_SCRIPT_FONT,
  UPLOADED_SCRIPT_FONT,
  chatFontSizeAtom,
  chatLineHeightAtom,
  installUploadedFont,
  scriptFontAtom,
  uploadedFontNameAtom,
} from "@/lib/reading-preferences";

interface Option<T> {
  value: T;
  label: string;
}

function SettingsDropdown<T>({
  ariaLabel,
  options,
  selected,
  onSelect,
}: {
  ariaLabel: string;
  options: readonly Option<T>[];
  selected: T;
  onSelect: (value: T) => void;
}) {
  const current = options.find((option) => option.value === selected);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
          aria-label={ariaLabel}
        >
          <span className="min-w-0 truncate">{current?.label ?? "Custom"}</span>
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={SETTINGS_DROPDOWN_CONTENT_CLASS}>
        {options.map((option) => (
          <DropdownMenuItem
            key={String(option.value)}
            onSelect={() => onSelect(option.value)}
          >
            {option.label}
            <Icon
              name="Check"
              className={cn("ml-auto", option.value !== selected && "opacity-0")}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type FontMode = "system" | "bundled" | "installed" | "file";

const FONT_OPTIONS: readonly Option<FontMode>[] = [
  { value: "system", label: "System default" },
  { value: "bundled", label: "Vazirmatn (built-in)" },
  { value: "installed", label: "Installed font…" },
  { value: "file", label: "Font file…" },
];

function fontModeOf(font: string): FontMode {
  if (font === SYSTEM_SCRIPT_FONT) return "system";
  if (font === BUNDLED_SCRIPT_FONT) return "bundled";
  if (font === UPLOADED_SCRIPT_FONT) return "file";
  return "installed";
}

const SIZE_OPTIONS: readonly Option<number>[] = CHAT_FONT_SIZES.map((size) => ({
  value: size,
  label: `${size}px`,
}));

const LINE_HEIGHT_OPTIONS: readonly Option<number>[] = CHAT_LINE_HEIGHTS.map(
  (height, index) => ({
    value: height,
    label: ["Normal", "Relaxed", "Loose"][index] ?? String(height),
  }),
);

export function ReadingSettings() {
  const [scriptFont, setScriptFont] = useAtom(scriptFontAtom);
  const [uploadedName, setUploadedName] = useAtom(uploadedFontNameAtom);
  const [fontSize, setFontSize] = useAtom(chatFontSizeAtom);
  const [lineHeight, setLineHeight] = useAtom(chatLineHeightAtom);
  const [pendingMode, setPendingMode] = useState<FontMode | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mode = pendingMode ?? fontModeOf(scriptFont);

  const chooseFile = async (file: File | undefined) => {
    if (file === undefined) return;
    setFileError(null);
    setLoadingFile(true);
    try {
      await installUploadedFont(file);
      setUploadedName(file.name);
      setScriptFont(UPLOADED_SCRIPT_FONT);
      setPendingMode(null);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingFile(false);
    }
  };

  return (
    <>
      <SettingsWithControl
        label="Script font"
        description="Used for Arabic, Persian, Hebrew and other text the interface font does not cover. Latin text keeps Inter."
      >
        <SettingsDropdown
          ariaLabel="Script font"
          options={FONT_OPTIONS}
          selected={mode}
          onSelect={(value) => {
            setFileError(null);
            if (value === "system") {
              setPendingMode(null);
              setScriptFont(SYSTEM_SCRIPT_FONT);
            } else if (value === "bundled") {
              setPendingMode(null);
              setScriptFont(BUNDLED_SCRIPT_FONT);
            } else {
              setPendingMode(value);
            }
          }}
        />
      </SettingsWithControl>
      {mode === "installed" ? (
        <SettingsWithControl
          label="Font name"
          description="The family name of a font installed on this computer."
        >
          <Input
            className="h-7 w-full text-xs sm:w-44"
            aria-label="Font name"
            placeholder="Font family name"
            defaultValue={fontModeOf(scriptFont) === "installed" ? scriptFont : ""}
            onChange={(event) => setScriptFont(event.target.value)}
          />
        </SettingsWithControl>
      ) : null}
      {mode === "file" ? (
        <SettingsWithControl
          label="Font file"
          description={
            fileError ??
            (uploadedName !== "" && scriptFont === UPLOADED_SCRIPT_FONT
              ? `Using ${uploadedName}. Stored on this device.`
              : "A .ttf, .otf, .woff or .woff2 file, up to 20 MB. Stored on this device.")
          }
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={FONT_FILE_EXTENSIONS.join(",")}
            className="hidden"
            aria-label="Font file"
            onChange={(event) => {
              void chooseFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className={SETTINGS_DROPDOWN_TRIGGER_CLASS}
            disabled={loadingFile}
            onClick={() => fileInputRef.current?.click()}
          >
            {loadingFile ? "Loading…" : "Choose font file"}
          </Button>
        </SettingsWithControl>
      ) : null}
      <SettingsWithControl
        label="Chat text size"
        description="Messages and the prompt box."
      >
        <SettingsDropdown
          ariaLabel="Chat text size"
          options={SIZE_OPTIONS}
          selected={fontSize}
          onSelect={setFontSize}
        />
      </SettingsWithControl>
      <SettingsWithControl
        label="Chat line spacing"
        description="Arabic-script text often reads better with more space between lines."
      >
        <SettingsDropdown
          ariaLabel="Chat line spacing"
          options={LINE_HEIGHT_OPTIONS}
          selected={lineHeight}
          onSelect={setLineHeight}
        />
      </SettingsWithControl>
    </>
  );
}
