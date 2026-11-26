// Risky local actions need a human click (ADR 0260, docs/scopes/security.md).
// A click is a request the desktop app signed. A signed-in phone also counts,
// but only for Mac access and app-only cards (GPU). Anyone else who asks for a
// plugin or skill install, or a plugin update, gets a request ID instead: the
// server checks the request and says what it would do, the app shows that, and
// a click there runs it.
import { randomUUID } from "node:crypto";
import { CALLER_TOKEN_HEADER } from "@cloudroom/config/caller-proof";
import {
  createHumanClickVerifier,
  HUMAN_CLICK_HEADER,
  HUMAN_CLICK_REQUIRED_CODE,
  HUMAN_CLICK_THREAD_HEADER,
  humanClickAction,
  type HumanClickAction,
} from "@cloudroom/config/human-click";
import { getThread } from "@cloudroom/db";
import { pluginIdSchema } from "@cloudroom/domain";
import {
  pluginCatalogInstallRequestSchema,
  pluginInstallRequestSchema,
  registrySkillInstallRequestSchema,
  type PluginCatalogResolvedSource,
} from "@cloudroom/server-contract";
import type { Context, Hono } from "hono";
import { ApiError } from "./errors.js";
import { getGateAuthKind } from "./request-context.js";
import type { PluginCatalogService } from "./services/plugin-catalog/plugin-catalog-service.js";
import type { PluginService } from "./services/plugins/plugin-service.js";
import { packageRefForSource } from "./services/skills/registry-parse.js";
import { resolveRegistrySkillById } from "./services/skills/registry-proxy.js";
import type { ServerAppDeps } from "./types.js";

const HUMAN_CLICK_CONTEXT_KEY = "cloudroomHumanClick";

declare module "hono" {
  interface ContextVariableMap {
    [HUMAN_CLICK_CONTEXT_KEY]: boolean | undefined;
  }
}

const MAX_WAITING = 5;
const WAIT_MS = 10 * 60_000;
const KEEP_ANSWER_MS = 10 * 60_000;
const MAX_BODY_LENGTH = 16_384;

const ASK_MESSAGE =
  "A person must approve this in the Cloudroom app on this computer. The app is showing the request now; room-cli waits for the answer.";
const REFUSED_MESSAGE =
  "This needs a click in the Cloudroom desktop app that started this server. Quit and reopen Cloudroom, then try again.";
const ANSWER_MESSAGE =
  "Only a person can answer this, with a click in the Cloudroom app on this computer.";
const TOO_MANY_MESSAGE =
  "Too many requests are already waiting for a click in the Cloudroom app. Ask the user to answer them first.";

type Status = "waiting" | "running" | "done" | "declined" | "expired";

interface Row {
  label: string;
  value: string;
}

/** What a kept request would do, worked out here: the app prints it as is. */
interface Described {
  title: string;
  verb: "Install" | "Update";
  rows: Row[];
  /** The checked request a click runs, never the asker's raw path or body. */
  path: string;
  body: unknown;
}

interface ClickRequest extends Described {
  id: string;
  action: HumanClickAction;
  /** The asking thread's title, when room-cli ran in one. The asker says which, so it is only a hint. */
  askedBy: string | null;
  createdAt: number;
  answeredAt: number | null;
  status: Status;
  /** What the action answered, once a person approved it. */
  response: { status: number; body: unknown } | null;
}

interface HumanClickReader {
  get(key: typeof HUMAN_CLICK_CONTEXT_KEY): boolean | undefined;
}

export function isHumanClick(context: HumanClickReader): boolean {
  return context.get(HUMAN_CLICK_CONTEXT_KEY) === true;
}

export function assertHumanClick(context: HumanClickReader): void {
  if (!isHumanClick(context)) {
    throw new ApiError(403, HUMAN_CLICK_REQUIRED_CODE, REFUSED_MESSAGE);
  }
}

const rows = (pairs: Array<[string, string | undefined | null]>): Row[] =>
  pairs.flatMap(([label, value]) => (value ? [{ label, value }] : []));

function sourceRows(source: PluginCatalogResolvedSource): Row[] {
  return source.kind === "npm"
    ? rows([
        ["npm package", source.package],
        ["version", source.resolvedVersion ?? source.range ?? source.tag],
        ["registry", source.registry],
        ["not resolved", source.unresolvedReason],
      ])
    : rows([
        ["repository", source.url],
        ["subdirectory", source.subdir],
        ["ref", source.ref ?? source.range],
        ["tag", source.resolvedTag],
        ["commit", source.resolvedCommit],
        ["not resolved", source.unresolvedReason],
      ]);
}

interface HumanClickServices {
  catalog: Pick<PluginCatalogService, "installPlan">;
  plugins: Pick<PluginService, "list" | "listUpdateResults">;
}

/** Checks a request and says what it would do. Throws what is wrong with it. */
async function describe(
  action: HumanClickAction,
  path: string,
  body: unknown,
  { catalog, plugins }: HumanClickServices,
): Promise<Described> {
  if (action === "plugin-update") {
    const id = pluginIdSchema.safeParse(path.split("/")[4]);
    const plugin = id.success
      ? plugins.list().find((entry) => entry.id === id.data)
      : undefined;
    if (plugin === undefined) throw new Error("unknown plugin");
    const update = plugins
      .listUpdateResults()
      .find((entry) => entry.id === plugin.id);
    return {
      title: "Update this plugin?",
      verb: "Update",
      rows: rows([
        ["plugin", plugin.id],
        ["source", plugin.sourceDisplay],
        ["installed", update?.installed.display ?? plugin.version],
        ["new version", update?.candidate?.display ?? "latest compatible"],
      ]),
      path: `/api/v1/plugins/${plugin.id}/update`,
      body: {},
    };
  }
  if (action === "skill-registry-install") {
    const input = registrySkillInstallRequestSchema.safeParse(body);
    if (!input.success) throw new Error("expected { registrySkillId }");
    const skill = await resolveRegistrySkillById(input.data.registrySkillId);
    // A source the installer would refuse is never shown.
    packageRefForSource(skill.source);
    return {
      title: "Install this skill?",
      verb: "Install",
      rows: rows([
        ["skill", skill.name],
        ["registry ID", skill.id],
        ["source", skill.source],
        ["reviewed", "no: anyone can publish to skills.sh"],
      ]),
      path,
      // The source is part of the ID, so the ID shown is the source installed.
      body: { registrySkillId: skill.id },
    };
  }
  if (action === "plugin-catalog-install") {
    const input = pluginCatalogInstallRequestSchema.safeParse(body);
    if (!input.success) throw new Error("expected { entryId, marketplace? }");
    const plan = await catalog.installPlan(input.data);
    if (!plan.compatible) {
      throw new Error(plan.incompatibleReason ?? "incompatible plugin");
    }
    const bundled = plan.kind === "bundled";
    return {
      title: "Install this plugin?",
      verb: "Install",
      rows: [
        ...rows([
          ["plugin", plan.displayName],
          ["catalog entry", plan.entryId],
          [
            "marketplace",
            bundled
              ? "bundled with Cloudroom"
              : `${plan.marketplaceDisplayName} (${plan.marketplace})`,
          ],
          [
            "reviewed",
            bundled || plan.official
              ? "by Cloudroom"
              : "no: a third-party marketplace",
          ],
          ["author", bundled || plan.official ? null : plan.author.name],
        ]),
        ...(bundled
          ? rows([["source", plan.source]])
          : sourceRows(plan.resolvedSource)),
      ],
      path,
      // The marketplace and source shown here are the ones installed: a changed listing is refused.
      body: bundled
        ? input.data
        : {
            entryId: plan.entryId,
            marketplace: plan.marketplace,
            ...(plan.official ? {} : { confirmedSource: plan.resolvedSource }),
          },
    };
  }
  const input = pluginInstallRequestSchema.safeParse(body);
  if (!input.success) throw new Error("expected { source, selection? }");
  const { selection } = input.data;
  return {
    title: "Install this plugin?",
    verb: "Install",
    rows: rows([
      ["source", input.data.source],
      [
        "subdirectory",
        selection?.kind === "subdirectory" ? selection.path : null,
      ],
      ["plugin", selection?.kind === "entry" ? selection.name : null],
    ]),
    path,
    body: input.data,
  };
}

export function installHumanClick(
  app: Hono,
  deps: Pick<
    ServerAppDeps,
    "callerProofs" | "config" | "db" | "hub" | "logger"
  >,
  services: HumanClickServices,
): void {
  const verifier = createHumanClickVerifier(deps.config.humanClickPublicKey);
  deps.logger.info(
    !verifier.enabled
      ? "Human clicks: off, the desktop app did not start this server"
      : verifier.broken
        ? "Human clicks: the desktop app's key is unreadable, so plugin and skill installs and raising Mac access are refused"
        : "Human clicks: plugin and skill installs and raising Mac access need a click in the app",
  );
  const requests = new Map<string, ClickRequest>();
  const approved = new WeakSet<Request>();
  const ownToken = deps.callerProofs.issueInternal();
  // Kept from now, so a later wrapper around app.fetch can't swap the approved request for a copy.
  const dispatch = app.fetch;
  const changed = (): void => deps.hub.notifySystem(["plugins-changed"]);

  function sweep(): void {
    const now = Date.now();
    for (const request of requests.values()) {
      if (request.status === "waiting" && now - request.createdAt > WAIT_MS) {
        request.status = "expired";
        request.answeredAt = now;
      }
      if (
        request.answeredAt !== null &&
        now - request.answeredAt > KEEP_ANSWER_MS
      ) {
        requests.delete(request.id);
      }
    }
  }

  const refuse = (
    message: string,
    extra: { requestId?: string; status?: 403 | 413 | 422 } = {},
  ): Response =>
    Response.json(
      extra.status === undefined || extra.status === 403
        ? {
            code: HUMAN_CLICK_REQUIRED_CODE,
            message,
            requestId: extra.requestId,
          }
        : { code: "invalid_request", message, error: message },
      { status: extra.status ?? 403 },
    );

  app.use("/api/v1/*", async (context, next) => {
    const { method, path } = context.req;
    const header = context.req.header(HUMAN_CLICK_HEADER);
    const action = humanClickAction(method, path);
    const human =
      !verifier.enabled ||
      approved.has(context.req.raw) ||
      verifier.verify(header, method, path) ||
      // A signed-in phone may change Mac access or answer an app-only card (GPU), nothing else.
      // The relay runs in this process; a machine on the relay is not a person.
      ((action === "mac-access" || action === "interaction-respond") &&
        getGateAuthKind(context) === "session" &&
        deps.callerProofs.isInternal(context.req.header(CALLER_TOKEN_HEADER)));
    context.set(HUMAN_CLICK_CONTEXT_KEY, human);
    // Mac access and interaction responses check for themselves: only raising Mac access or answering an app-only card needs a click.
    if (
      human ||
      action === null ||
      action === "mac-access" ||
      action === "interaction-respond"
    )
      return next();
    // The app's own click failed: it didn't start this server.
    if (header !== undefined) return refuse(REFUSED_MESSAGE);
    if (action === "approve" || action === "decline") {
      return refuse(ANSWER_MESSAGE);
    }
    if (Number(context.req.header("content-length") ?? 0) > MAX_BODY_LENGTH) {
      return refuse("The request is too large.", { status: 413 });
    }
    const text = await context.req.text();
    if (text.length > MAX_BODY_LENGTH) {
      return refuse("The request is too large.", { status: 413 });
    }
    let described: Described;
    try {
      described = await describe(action, path, JSON.parse(text), services);
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error), {
        status: 422,
      });
    }
    sweep();
    const waiting = [...requests.values()].filter(
      (request) => request.status === "waiting",
    );
    if (waiting.length >= MAX_WAITING) return refuse(TOO_MANY_MESSAGE);
    const thread = getThread(
      deps.db,
      context.req.header(HUMAN_CLICK_THREAD_HEADER) ?? "",
    );
    const request: ClickRequest = {
      ...described,
      id: randomUUID(),
      action,
      askedBy: thread?.title ?? thread?.titleFallback ?? null,
      createdAt: Date.now(),
      answeredAt: null,
      status: "waiting",
      response: null,
    };
    requests.set(request.id, request);
    changed();
    return refuse(ASK_MESSAGE, { requestId: request.id });
  });

  const find = (context: Context): ClickRequest => {
    sweep();
    const request = requests.get(context.req.param("id") ?? "");
    if (request === undefined) {
      throw new ApiError(404, "not_found", "Unknown request.");
    }
    return request;
  };
  const view = ({
    answeredAt: _answeredAt,
    path: _path,
    body: _body,
    ...shown
  }: ClickRequest) => shown;

  app.get("/api/v1/human-clicks", (context) => {
    sweep();
    return context.json({
      requests: [...requests.values()]
        .filter((request) => request.status === "waiting")
        .map(view),
    });
  });

  app.get("/api/v1/human-clicks/:id", (context) =>
    context.json(view(find(context))),
  );

  // Only a human click gets to these two: the check above refused everyone else.
  app.post("/api/v1/human-clicks/:id/approve", async (context) => {
    const request = find(context);
    if (request.status !== "waiting") {
      throw new ApiError(
        409,
        "already_answered",
        "This request was already answered.",
      );
    }
    request.status = "running";
    changed();
    try {
      const replay = new Request(new URL(request.path, context.req.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CALLER_TOKEN_HEADER]: ownToken,
        },
        body: JSON.stringify(request.body),
      });
      approved.add(replay);
      const response = await dispatch(replay);
      request.response = {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    } catch (error) {
      request.response = {
        status: 500,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }
    request.status = "done";
    request.answeredAt = Date.now();
    changed();
    return context.json(view(request));
  });

  app.post("/api/v1/human-clicks/:id/decline", (context) => {
    const request = find(context);
    if (request.status === "waiting") {
      request.status = "declined";
      request.answeredAt = Date.now();
      changed();
    }
    return context.json(view(request));
  });
}
