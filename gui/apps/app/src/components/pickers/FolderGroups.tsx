import type { ReactNode } from "react";
import { COMPUTER_TITLE, getHostPathBasename, getHostPathDirname } from "@cloudroom/domain";
import { useThisComputer } from "@/hooks/useHostDaemon";
import { CommandGroup, CommandItem } from "@cloudroom/shared-ui/command";
import { Icon } from "@cloudroom/shared-ui/icon";
import { cn } from "@cloudroom/shared-ui/lib/utils";
import { formatRelativeTime } from "@/lib/relative-time";
import { folderValue, tildePath, type FolderEntry } from "./folder-path";
import type { useFolderPicker } from "./useFolderPicker";

const ITEM_CLASS_NAME = "py-[0.3125rem] text-xs max-md:py-2";
const PATH_ROWS = 50;
export const HERE_VALUE = "folder-here";

/** A folder to add, or to select when a project already uses it. */
export interface PickedFolder {
  path: string;
  name: string;
  projectId?: string;
  activityAt?: number;
}

type FolderPicker = ReturnType<typeof useFolderPicker>;

export const baseName = (path: string) => getHostPathBasename(path) ?? path;
const parentPath = (path: string) => getHostPathDirname(path) ?? path;

interface FolderItemProps {
  entry: FolderEntry;
  detail: ReactNode;
  addingKey: string | null;
  showAdd: boolean;
  onPick: (folder: PickedFolder) => void;
}

function FolderItem({ entry, detail, addingKey, showAdd, onPick }: FolderItemProps) {
  const adding = addingKey === entry.path;
  return (
    <CommandItem
      value={folderValue(entry.path)}
      disabled={addingKey !== null && !adding}
      onSelect={() => onPick(entry)}
      className={cn(ITEM_CLASS_NAME, "group")}
    >
      <Icon name="Folder" className="size-4 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {entry.name}
        {detail ? <span className="ml-1.5 text-muted-foreground">{detail}</span> : null}
      </span>
      {entry.projectId ? <Icon name="Check" className="size-4 text-muted-foreground" aria-label="Already a project" /> : null}
      {entry.git === "repo" ? <Icon name="GitBranch" className="size-3.5 text-muted-foreground" aria-label="Git repo" /> : null}
      {showAdd ? (
        <span className="flex shrink-0 items-center gap-1 rounded border px-1.5 text-[0.6875rem] leading-4 text-muted-foreground group-data-[selected=true]:border-primary group-data-[selected=true]:bg-primary group-data-[selected=true]:text-primary-foreground">
          {adding ? <><Icon name="Loading" className="size-3 animate-spin" />Adding</> : "+ Add"}
        </span>
      ) : null}
    </CommandItem>
  );
}

/** Key hints under the list, so Tab and Enter are discoverable. */
export function FolderKeyHints({ hints }: { hints: [key: string, label: string][] }) {
  if (hints.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-t px-3 py-1.5 text-[0.6875rem] text-muted-foreground">
      {hints.map(([key, label], index) => (
        <span key={key} className={cn("flex items-center gap-1.5", index === hints.length - 1 ? "min-w-0" : "shrink-0")}>
          <kbd className="rounded border px-1 font-sans text-[0.625rem] leading-4 text-foreground">{key}</kbd>
          <span className="truncate">{label}</span>
        </span>
      ))}
    </div>
  );
}

/** Path mode: the typed folder's subfolders, most likely first, plus the folder itself when no name is typed. */
export function FolderPathGroup({ folders, addingKey, onPick }: { folders: FolderPicker; addingKey: string | null; onPick: (folder: PickedFolder) => void }) {
  const now = Date.now();
  const { listing, matches, leaf, home } = folders;
  const heading = folders.missing
    ? `No folder at ${folders.folder}`
    : listing
      ? <>{tildePath(listing.directory, home)} <span className="font-normal opacity-70">{leaf ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : `${matches.length} folders`}</span></>
      : "Loading…";
  return (
    <CommandGroup heading={heading}>
      {listing && !leaf && folders.canAddHere ? (
        <CommandItem
          value={HERE_VALUE}
          disabled={addingKey !== null}
          onSelect={() => onPick({ path: listing.directory, name: baseName(listing.directory), ...(listing.projectId ? { projectId: listing.projectId } : {}) })}
          className={ITEM_CLASS_NAME}
        >
          <Icon name={listing.projectId ? "Folder" : "FolderPlus"} className="size-4 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {addingKey === listing.directory ? "Adding…" : `${listing.projectId ? "Select" : "Add"} ${baseName(listing.directory)}`}
          </span>
        </CommandItem>
      ) : null}
      {matches.slice(0, PATH_ROWS).map((entry) => (
        <FolderItem
          key={entry.path}
          entry={entry}
          detail={entry.activityAt ? formatRelativeTime({ timestamp: entry.activityAt, now }) : null}
          addingKey={addingKey}
          showAdd={false}
          onPick={onPick}
        />
      ))}
      {matches.length > PATH_ROWS ? (
        <div className="px-2 py-1 text-[0.6875rem] text-muted-foreground">+{matches.length - PATH_ROWS} more, newest first</div>
      ) : listing && leaf && matches.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">No folder starts with “{leaf}”</div>
      ) : null}
    </CommandGroup>
  );
}

/** Search mode: folders anywhere under home that match, best first. A project's folder shows ✓ and selects it. */
export function FolderSearchGroup({ results, home, addingKey, onPick }: { results: readonly FolderEntry[]; home: string | null; addingKey: string | null; onPick: (folder: PickedFolder) => void }) {
  const computer = useThisComputer() === "this PC" ? "PC" : COMPUTER_TITLE;
  if (results.length === 0) return null;
  return (
    <CommandGroup heading={<>On this {computer} <span className="font-normal opacity-70">{results.length}</span></>}>
      {results.map((entry) => (
        <FolderItem
          key={entry.path}
          entry={entry}
          detail={tildePath(parentPath(entry.path), home)}
          addingKey={addingKey}
          showAdd={!entry.projectId}
          onPick={onPick}
        />
      ))}
    </CommandGroup>
  );
}
