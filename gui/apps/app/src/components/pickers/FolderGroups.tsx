import { getHostPathBasename } from "@cloudroom/domain";
import { CommandGroup, CommandItem } from "@cloudroom/shared-ui/command";
import { Icon } from "@cloudroom/shared-ui/icon";
import { formatRelativeTime } from "@/lib/relative-time";
import { folderValue, tildePath } from "./folder-path";
import type { useFolderPicker } from "./useFolderPicker";

/** Every row in the project picker: one height, no icon on the left. */
export const PICKER_ROW_CLASS_NAME = "group h-7 rounded-md py-0 text-xs max-md:h-10";
/** Small gray text on the right of a row, and next to a folder's name. */
export const PICKER_DETAIL_CLASS_NAME = "text-[0.6875rem] text-muted-foreground/45";
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

/** What Enter does. It shows only on the highlighted row, so the list stays quiet. */
export function RowAction({ label, busy = false }: { label: string; busy?: boolean }) {
  return busy ? (
    <span className="flex shrink-0 items-center gap-1 text-[0.6875rem] text-muted-foreground">
      <Icon name="Loading" className="size-3! animate-spin" aria-hidden />
      Adding
    </span>
  ) : (
    <span className="hidden shrink-0 items-center gap-1 rounded-sm bg-primary px-[0.4375rem] text-[0.6875rem] font-semibold leading-[1.125rem] text-primary-foreground group-data-[selected=true]:flex">
      {label}
      <Icon name="CornerDownLeft" className="size-2.5!" aria-hidden />
    </span>
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
          className={PICKER_ROW_CLASS_NAME}
        >
          <span className="min-w-0 flex-1 truncate">
            {baseName(listing.directory)}
            <span className={`ml-1.5 ${PICKER_DETAIL_CLASS_NAME}`}>this folder</span>
          </span>
          <RowAction label={listing.projectId ? "Select" : "Add"} busy={addingKey === listing.directory} />
        </CommandItem>
      ) : null}
      {matches.slice(0, PATH_ROWS).map((entry) => (
        <CommandItem
          key={entry.path}
          value={folderValue(entry.path)}
          disabled={addingKey !== null && addingKey !== entry.path}
          onSelect={() => onPick(entry)}
          className={PICKER_ROW_CLASS_NAME}
        >
          <span className="min-w-0 flex-1 truncate">
            {entry.name}/
            {entry.activityAt ? <span className={`ml-1.5 ${PICKER_DETAIL_CLASS_NAME}`}>{formatRelativeTime({ timestamp: entry.activityAt, now })}</span> : null}
          </span>
          {entry.projectId ? <Icon name="Check" className="size-3.5! text-muted-foreground/45 group-data-[selected=true]:hidden" aria-label="Already a project" /> : null}
          {entry.git === "repo" ? <Icon name="GitBranch" className="size-3.5! text-muted-foreground/45 group-data-[selected=true]:hidden" aria-label="Git repo" /> : null}
          <RowAction label={entry.projectId ? "Select" : "Add"} busy={addingKey === entry.path} />
        </CommandItem>
      ))}
      {matches.length > PATH_ROWS ? (
        <div className={`px-2 py-1 ${PICKER_DETAIL_CLASS_NAME}`}>+{matches.length - PATH_ROWS} more, newest first</div>
      ) : listing && leaf && matches.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground/70">No folder starts with “{leaf}”</div>
      ) : null}
    </CommandGroup>
  );
}
