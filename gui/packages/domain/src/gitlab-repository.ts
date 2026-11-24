// A project URL goes into Git commands on another machine. Accept only GitLab.com project
// paths, including subgroups. Web UI links, credentials and special Git transports aren't remotes.
export function gitlabRepository(remote: unknown): string | null {
  if (typeof remote !== "string" || remote.length > 1024) return null;
  const match =
    /^(?:https:\/\/gitlab\.com\/|ssh:\/\/git@gitlab\.com\/|git@gitlab\.com:)([\w./-]+?)\/?$/i.exec(
      remote.trim(),
    );
  if (!match) return null;
  const path = match[1]!.replace(/\.git$/i, "");
  const parts = path.split("/");
  if (
    parts.length < 2 || /\.git$/i.test(path) ||
    parts.some(
      (part) =>
        !/^[a-z\d_][\w.-]*$/i.test(part) ||
        part.endsWith(".") ||
        part.includes(".."),
    )
  )
    return null;
  return "https://gitlab.com/" + path;
}
