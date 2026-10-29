import type {
  PendingInteractionCreate,
  PendingInteractionResolution,
} from "@cloudroom/domain";
import type { HostDaemonInteractiveRequestResponse } from "@cloudroom/host-daemon-contract";
import { normalizeCaughtError } from "./error-utils.js";

const DELIVERED_INTERACTIVE_REQUEST_TOMBSTONE_TTL_MS = 5 * 60 * 1000;

export interface InteractiveResolveCommandInput {
  interactionId: string;
  providerId: string;
  providerRequestId: string;
  providerThreadId: string;
  resolution: PendingInteractionResolution;
  threadId: string;
}

interface InteractiveRequestRegistrationFailure {
  error: Error;
  request: PendingInteractionCreate;
}

interface InteractiveRequestRegistryOptions {
  onCancel?: (request: PendingInteractionCreate) => Promise<void>;
  onRegistrationFailure?: (
    failure: InteractiveRequestRegistrationFailure,
  ) => void;
  registerRequest: (
    request: PendingInteractionCreate,
  ) => Promise<HostDaemonInteractiveRequestResponse>;
}

interface InterruptInteractiveThreadsArgs {
  providerId: string;
  reason: string;
  threadIds: readonly string[];
}

interface PendingInteractiveRequestEntry {
  interactionId: string | null;
  promise: Promise<PendingInteractionResolution>;
  reject: (error: Error) => void;
  resolve: (resolution: PendingInteractionResolution) => void;
  request: PendingInteractionCreate;
}

interface DeliveredInteractiveRequestTombstone {
  timeout: ReturnType<typeof setTimeout>;
}

export class InteractiveRequestRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InteractiveRequestRegistryError";
  }
}

function buildInteractiveRequestKey(
  request: Pick<
    PendingInteractionCreate,
    "providerId" | "providerRequestId" | "providerThreadId" | "threadId"
  >,
): string {
  return [
    request.threadId,
    request.providerId,
    request.providerThreadId,
    request.providerRequestId,
  ].join("\0");
}

function buildDeliveredTombstoneKey(
  request: Pick<
    InteractiveResolveCommandInput,
    | "interactionId"
    | "providerId"
    | "providerRequestId"
    | "providerThreadId"
    | "threadId"
  >,
): string {
  return [
    request.interactionId,
    request.threadId,
    request.providerId,
    request.providerThreadId,
    request.providerRequestId,
  ].join("\0");
}

export class InteractiveRequestRegistry {
  private readonly deliveredTombstones = new Map<
    string,
    DeliveredInteractiveRequestTombstone
  >();
  private readonly pendingEntries = new Map<
    string,
    PendingInteractiveRequestEntry
  >();
  private readonly threadCancels = new Map<string, Promise<unknown>>();

  constructor(private readonly options: InteractiveRequestRegistryOptions) {}

  async registerAndWait(
    request: PendingInteractionCreate,
    signal?: AbortSignal,
  ): Promise<PendingInteractionResolution> {
    const key = buildInteractiveRequestKey(request);
    const existing = this.pendingEntries.get(key);
    if (existing) {
      return existing.promise;
    }

    let resolveEntry: (
      resolution: PendingInteractionResolution,
    ) => void = () => {};
    let rejectEntry: (error: Error) => void = () => {};
    const promise = new Promise<PendingInteractionResolution>(
      (resolve, reject) => {
        resolveEntry = resolve;
        rejectEntry = reject;
      },
    );
    const entry: PendingInteractiveRequestEntry = {
      interactionId: null,
      promise,
      reject: (error) => rejectEntry(error),
      resolve: (resolution) => resolveEntry(resolution),
      request,
    };
    this.pendingEntries.set(key, entry);
    const registered = this.register(key, entry);
    signal?.addEventListener(
      "abort",
      () => {
        if (this.pendingEntries.get(key) !== entry) {
          return;
        }
        this.pendingEntries.delete(key);
        entry.reject(new Error("Interactive request cancelled"));
        const cancelled = Promise.allSettled([
          this.threadCancels.get(request.threadId),
          registered.then(() => this.options.onCancel?.(request)),
        ]).finally(() => {
          if (this.threadCancels.get(request.threadId) === cancelled) {
            this.threadCancels.delete(request.threadId);
          }
        });
        this.threadCancels.set(request.threadId, cancelled);
      },
      { once: true },
    );
    return promise;
  }

  private async register(
    key: string,
    entry: PendingInteractiveRequestEntry,
  ): Promise<void> {
    const { request } = entry;
    try {
      const cancelling = this.threadCancels.get(request.threadId);
      if (cancelling) {
        await cancelling;
        if (this.pendingEntries.get(key) !== entry) {
          return;
        }
      }
      const response = await this.options.registerRequest(request);
      if (response.outcome === "rejected") {
        this.pendingEntries.delete(key);
        entry.reject(
          new InteractiveRequestRegistryError(
            "interactive_request_rejected",
            response.reason,
          ),
        );
        return;
      }

      entry.interactionId = response.interactionId;
      if (response.status !== "pending" && response.status !== "resolving") {
        this.pendingEntries.delete(key);
        entry.reject(
          new Error(
            `Pending interaction ${response.interactionId} is already ${response.status}`,
          ),
        );
      }
    } catch (error) {
      this.pendingEntries.delete(key);
      const registrationError = normalizeCaughtError(error);
      this.options.onRegistrationFailure?.({
        error: registrationError,
        request,
      });
      entry.reject(registrationError);
    }
  }

  resolve(request: InteractiveResolveCommandInput): void {
    const key = buildInteractiveRequestKey(request);
    const tombstoneKey = buildDeliveredTombstoneKey(request);
    if (this.deliveredTombstones.has(tombstoneKey)) {
      return;
    }

    const entry = this.pendingEntries.get(key);
    if (!entry) {
      throw new InteractiveRequestRegistryError(
        "stale_interactive_request",
        `Interactive request ${request.interactionId} is no longer awaiting a provider response`,
      );
    }
    if (
      entry.interactionId !== null &&
      entry.interactionId !== request.interactionId
    ) {
      throw new InteractiveRequestRegistryError(
        "interactive_request_mismatch",
        `Interactive request ${request.interactionId} does not match registered interaction ${entry.interactionId}`,
      );
    }

    this.pendingEntries.delete(key);
    this.addDeliveredTombstone(tombstoneKey);
    entry.resolve(request.resolution);
  }

  interruptThreads(args: InterruptInteractiveThreadsArgs): void {
    const threadIds = new Set(args.threadIds);
    for (const [key, entry] of this.pendingEntries) {
      if (
        entry.request.providerId !== args.providerId ||
        !threadIds.has(entry.request.threadId)
      ) {
        continue;
      }

      this.pendingEntries.delete(key);
      entry.reject(new Error(args.reason));
    }
  }

  private addDeliveredTombstone(key: string): void {
    const existing = this.deliveredTombstones.get(key);
    if (existing) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(() => {
      this.deliveredTombstones.delete(key);
    }, DELIVERED_INTERACTIVE_REQUEST_TOMBSTONE_TTL_MS);
    timeout.unref();
    this.deliveredTombstones.set(key, { timeout });
  }
}
