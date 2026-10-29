import { PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES } from "@cloudroom/domain";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@cloudroom/server-contract";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requirePublicThread } from "../../services/lib/entity-lookup.js";

const pendingInteractionIdSchema = z
  .string()
  .regex(/^pint_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/);

/** Cards only the user answers, in the app window: paid GPU sessions (ADR 0331). The app's requests always carry an
 *  Origin header, which the browser guard has already checked; `room-cli thread interactions respond` sends none, so
 *  an agent can't approve its own GPU that way. */
const APP_ONLY_PLUGINS = new Set(["gpu"]);

function parsePendingInteractionId(rawInteractionId: string): string {
  const parsedInteractionId =
    pendingInteractionIdSchema.safeParse(rawInteractionId);
  if (!parsedInteractionId.success) {
    throw new ApiError(
      400,
      "invalid_request",
      "Invalid pending interaction id",
    );
  }
  return parsedInteractionId.data;
}

export function registerThreadInteractionRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.threads;

  get(routes.interactions, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      deps.pendingInteractions.listPendingThreadInteractions(thread.id),
    );
  });

  get(routes.interaction, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      deps.pendingInteractions.getThreadInteraction({
        threadId: thread.id,
        interactionId: parsePendingInteractionId(
          context.req.param("interactionId"),
        ),
      }),
    );
  });

  post(routes.resolveInteraction, (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      deps.pendingInteractions.resolvePendingInteraction({
        threadId: thread.id,
        interactionId: parsePendingInteractionId(
          context.req.param("interactionId"),
        ),
        resolution: payload,
      }),
    );
  });

  post(routes.respondToInteraction, (context, payload) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const current = deps.pendingInteractions.getThreadInteraction({
      threadId: thread.id,
      interactionId: parsePendingInteractionId(context.req.param("interactionId")),
    });
    if (
      current.origin?.kind === "plugin" &&
      APP_ONLY_PLUGINS.has(current.origin.pluginId) &&
      !context.req.header("origin")
    ) {
      throw new ApiError(
        403,
        "invalid_request",
        "Only the user can answer this card, in the Cloudroom app.",
      );
    }
    if (
      Buffer.byteLength(JSON.stringify(payload.value), "utf8") >
      PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES
    ) {
      throw new ApiError(
        413,
        "invalid_request",
        "Interaction response exceeds 64 KiB",
      );
    }
    return context.json(
      deps.pendingInteractions.respondToInteraction({
        threadId: thread.id,
        interactionId: parsePendingInteractionId(
          context.req.param("interactionId"),
        ),
        value: payload.value,
      }),
    );
  });

  post(routes.cancelInteraction, (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      deps.pendingInteractions.cancelPluginInteraction({
        threadId: thread.id,
        interactionId: parsePendingInteractionId(
          context.req.param("interactionId"),
        ),
        reason: "user",
      }),
    );
  });
}
