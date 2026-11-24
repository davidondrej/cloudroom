import {
  emptyDevice,
  snippetService,
  type Device,
  type View,
} from "./service.ts";

// One account-scoped library on this phone, whether the Mac is awake or asleep.
export function phoneSnippets() {
  const marker = () =>
    document.cookie.match(
      /(?:^|; )__Host-cloudroom-offline-session=([^;]+)/,
    )?.[1];
  const binding = "cloudroom:snippets:session";
  const offlineOwner = () => {
    const session = marker();
    if (!session) return undefined;
    const saved = JSON.parse(localStorage.getItem(binding) ?? "null");
    return saved?.session === session && typeof saved.owner === "string"
      ? (saved.owner as string)
      : undefined;
  };
  let defaultSync = false;
  let revoked = false;
  let verifiedAt = 0;
  let verifiedSession: string | undefined;
  async function remote(body: Record<string, unknown>) {
    const owner = offlineOwner();
    if (
      body.action === "identity" &&
      owner &&
      (!navigator.onLine ||
        (marker() === verifiedSession && Date.now() - verifiedAt < 60000))
    )
      return owner;
    let response;
    try {
      response = await fetch("/__cloud/snippets", {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          body.action === "identity" ? { ...body, knownOwner: owner } : body,
        ),
      });
    } catch (error) {
      if (body.action === "identity" && owner) return owner;
      throw error;
    }
    if (
      response.status === 401 ||
      (body.action === "identity" && response.status === 403)
    ) {
      revoked = true;
      localStorage.removeItem(binding);
      verifiedAt = 0;
      throw new Error("Sign in to use phone snippets.");
    }
    if (!response.ok) {
      if (body.action === "identity" && owner && response.status >= 500)
        return owner;
      const problem = await response.json().catch(() => null);
      throw new Error(
        problem?.error ?? "Your phone could not reach Cloudroom.",
      );
    }
    const value = await response.json();
    if (body.action === "identity") {
      if (!value.owner || typeof value.owner !== "string")
        throw new Error("Could not verify the phone account.");
      const session = marker();
      if (session)
        localStorage.setItem(
          binding,
          JSON.stringify({ session, owner: value.owner }),
        );
      revoked = false;
      verifiedSession = session;
      verifiedAt = Date.now();
      if (typeof value.sync === "boolean") defaultSync = value.sync;
      return value.owner as string;
    }
    return value;
  }
  const key = (account: string) => "cloudroom:snippets:" + account;
  const service = snippetService(
    (account) => {
      const saved = localStorage.getItem(key(account));
      if (saved) return JSON.parse(saved) as Device;
      const device = { ...emptyDevice(), sync: defaultSync };
      localStorage.setItem(key(account), JSON.stringify(device));
      return device;
    },
    (account, d) => localStorage.setItem(key(account), JSON.stringify(d)),
    remote,
    () => {},
  );
  type Input = { owner: string; organization: string | null; argv: string[] };
  function call(method: "view", input: "local" | "refresh"): Promise<View>;
  function call(method: "run", input: Input): Promise<unknown>;
  function call(method: "view" | "run", input: "local" | "refresh" | Input) {
    const work = async () => {
      const result =
        typeof input === "string"
          ? await service.view(input)
          : await service.run(input.argv, input);
      if (revoked) throw new Error("Sign in to use phone snippets.");
      return result;
    };
    return navigator.locks
      ? navigator.locks.request("cloudroom:snippets", work)
      : work();
  }
  return { call };
}
