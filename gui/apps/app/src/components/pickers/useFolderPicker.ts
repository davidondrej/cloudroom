import { getProjectPathValidationMessage } from "@cloudroom/domain";
import { useHostDirectory, useHostFolderSearch } from "@/hooks/queries/host-queries";
import {
  cleanPathQuery,
  isPathQuery,
  matchFolders,
  resolveFolder,
  splitPathQuery,
  type FolderEntry,
} from "./folder-path";

const SEARCH_MIN_CHARS = 2;
const NO_FOLDERS: FolderEntry[] = [];

/** Folders for the project picker's search on `hostId`.
 *  A `~/…` or `/…` query lists the typed folder (path mode); other text searches folders anywhere under home. */
export function useFolderPicker({ hostId, query, open }: { hostId: string | null; query: string; open: boolean }) {
  const text = cleanPathQuery(query);
  const wantsPath = open && hostId !== null && isPathQuery(text);
  // Plain text also completes against home, as if the search started in `~/`: `co` + Tab gives `~/code/`.
  const plainName = !wantsPath && text.trim() !== "" && !text.includes("/");
  const homeListing = useHostDirectory(open && hostId !== null && (wantsPath || plainName) ? hostId : null, null, { retry: false });
  const home = homeListing.data?.directory ?? null;
  // Windows homes use drive paths, which path typing doesn't cover yet; those keep the plain search.
  const pathMode = wantsPath && (home === null || home.startsWith("/"));
  const { folder, leaf } = splitPathQuery(text);
  const folderPath = pathMode ? resolveFolder(folder, home) : null;
  const folderListing = useHostDirectory(folderPath !== null && folderPath !== home ? hostId : null, folderPath, { retry: false });
  const current = folderPath !== null && folderPath === home ? homeListing : folderListing;
  const listing = folderPath !== null && !current.isPlaceholderData ? current.data : undefined;

  const searchText = !wantsPath ? text.trim() : "";
  const searching = searchText.length >= SEARCH_MIN_CHARS;
  // Opening the picker warms the host's folder index, so the first search is instant.
  const search = useHostFolderSearch(open && hostId !== null && !wantsPath ? hostId : null, searching ? searchText : "");
  // Rows from the previous query stay only while they still match, so Enter never adds a folder the text doesn't name.
  // Folders only: a daemon too old for `search` answers with home's plain listing.
  const needle = searchText.toLowerCase();
  const results = searching
    ? (search.data?.entries ?? NO_FOLDERS).filter(
        (entry) => entry.kind === "directory" && entry.git !== "worktree" && entry.name.toLowerCase().includes(needle),
      )
    : NO_FOLDERS;

  return {
    pathMode,
    folder,
    leaf,
    listing,
    /** The listed folder itself can be a project: not `/` or a drive root. */
    canAddHere: listing !== undefined && getProjectPathValidationMessage(listing.directory) === null,
    loading: pathMode && listing === undefined && !current.isError,
    missing: pathMode && current.isError,
    matches: listing ? matchFolders(listing.entries, leaf) : NO_FOLDERS,
    results,
    /** The home subfolder plain text completes to. */
    homeMatch: plainName && home?.startsWith("/") && homeListing.data ? matchFolders(homeListing.data.entries, text.trim())[0] : undefined,
    home: home ?? search.data?.directory ?? null,
  };
}
