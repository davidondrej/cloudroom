import { COMPUTER } from "@cloudroom/domain/computer-name";
import { connectCredentialSchema, deriveConnectBaseUrl } from "@cloudroom/connect-client";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ConnectTunnel } from "./tunnel.js";

const ACCOUNT_KV_KEY = "relay-account";
// A signed-out key the relay hasn't retired yet, because this Mac was offline.
const RETIRE_KV_KEY = "relay-retire";
const CHECK_INTERVAL_MS = 60_000;

export class PhoneRelay {
  signedIn = false;
  error: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "storage" | "log">,
    private readonly tunnel: ConnectTunnel,
    private readonly onChange: () => void,
  ) {}

  async start(): Promise<void> {
    await this.tunnel.start();
    await this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.tunnel.stop();
  }

  check(force = false): Promise<void> {
    this.checking ??= this.reconcile(force)
      .then(() => {
        this.error = null;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== this.error) this.bb.log.warn(`Cloudroom Connect registration failed: ${message}`);
        this.error = message;
      })
      .finally(() => {
        this.checking = null;
        this.onChange();
      });
    return this.checking;
  }

  signOutPhones(): Promise<{ revoked: number }> {
    return this.call("/api/phone-sessions/revoke") as Promise<{ revoked: number }>;
  }

  private async reconcile(force: boolean): Promise<void> {
    await this.retirePending();
    const { accountId, blocked } = await this.bb.sdk.cloudroom.connectAccount();
    this.signedIn = accountId !== null;
    if (accountId === null) {
      const signedOut = this.tunnel.getCredential();
      if (signedOut !== null) await this.retire(signedOut);
      if (blocked) throw new Error(blocked);
      return;
    }
    const registeredFor = await this.bb.storage.kv.get<string>(ACCOUNT_KV_KEY);
    if (!force && registeredFor === accountId && this.tunnel.getCredential() !== null) {
      return;
    }
    // Another account's key goes first, so that account's phones lose this Mac even if registering fails.
    const previous = registeredFor !== accountId ? this.tunnel.getCredential() : null;
    if (previous !== null) await this.retire(previous);
    const registration = await this.bb.sdk.cloudroom.connectRegister();
    await this.bb.storage.kv.set(ACCOUNT_KV_KEY, registration.accountId);
    await this.tunnel.useCredential({
      serverUrl: registration.serverUrl,
      handle: registration.handle,
      credential: registration.credential,
    });
  }

  /** Retires the key on the relay too, so no saved copy can still reach the account's other Macs. */
  private async retire(credential: NonNullable<ReturnType<ConnectTunnel["getCredential"]>>): Promise<void> {
    await this.bb.storage.kv.set(RETIRE_KV_KEY, credential);
    await this.tunnel.forget();
    await this.retirePending();
  }

  /** Offline, the key stays saved and the next check retries; only network errors and relay outages keep it. */
  private async retirePending(): Promise<void> {
    const saved = connectCredentialSchema.safeParse(await this.bb.storage.kv.get<unknown>(RETIRE_KV_KEY));
    if (!saved.success) return;
    const response = await fetch(new URL("/api/unregister", deriveConnectBaseUrl(saved.data.serverUrl)), {
      method: "POST",
      headers: { authorization: `Bearer ${saved.data.credential}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (response !== null && response.status < 500) await this.bb.storage.kv.delete(RETIRE_KV_KEY);
  }

  async call(path: string, body?: unknown): Promise<unknown> {
    const credential = this.tunnel.getCredential();
    if (credential === null) {
      throw new Error(
        this.signedIn
          ? "Cloudroom Connect is still setting up. Try again in a moment."
          : "Sign in to Cloudroom to use it on your phone.",
      );
    }
    const response = await fetch(
      new URL(path, deriveConnectBaseUrl(credential.serverUrl)),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.credential}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 401) {
      void this.check(true);
      throw new Error(`Cloudroom Connect is setting up this ${COMPUTER} again. Try again in a moment.`);
    }
    if (!response.ok) {
      throw new Error(`Cloudroom Connect returned HTTP ${response.status}.`);
    }
    return response.json();
  }
}
