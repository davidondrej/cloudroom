// Git URLs can carry a username or token (`https://user:TOKEN@host/repo`).
// Strip them so they never reach the database, the API, errors or progress.
// Only network URLs (`https://`, `ssh://`...) have userinfo (git also takes
// `http:///`). `file:` paths, scp-style `user@host:path`, and `http:/x@h`
// which git reads as one, stay as is.
// Userinfo may hold quotes, spaces and backslashes; only / ? # end it.
const SCHEME = String.raw`((?<![a-z0-9+.-])(?:https?|ftps?|ssh|git|git\+ssh|ssh\+git|git\+https?):\/{2,})`;
const URL_USERINFO = new RegExp(`${SCHEME}[^/?#]*@`, "giu");
// Free text: a URL also ends at whitespace. Quotes and commas stay
// (#1935: passwords can hold them).
const TEXT_URL_USERINFO = new RegExp(`${SCHEME}[^\\s/?#]*@`, "giu");
// SSH needs its username (`ssh://git@host/repo`) and never takes a token in the URL.
const SSH_SCHEME = /^(?:ssh|git\+ssh|ssh\+git):\/+$/iu;

function strip(match: string, scheme: string): string {
  if (!SSH_SCHEME.test(scheme)) return scheme;
  const user = match.slice(scheme.length, -1).split(":")[0];
  return `${scheme}${user}@`;
}

export function stripGitUrlCredentials(value: string): string {
  return value.replace(URL_USERINFO, strip);
}

/** For errors and progress lines, including git's own `Password for 'https://TOKEN@host'`. */
export function stripTextGitUrlCredentials(value: string): string {
  return value.replace(TEXT_URL_USERINFO, strip);
}
