import type { FeatureFlags } from "@cloudroom/domain";
import {
  readEnvVarWithDefault,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  ROOM_FF_PLACEHOLDER_ENV,
  ROOM_FF_TIMELINE_WINDOW_EVENT_BUDGET_ENV,
  DEFAULT_ROOM_FF_PLACEHOLDER,
  DEFAULT_ROOM_FF_TIMELINE_WINDOW_EVENT_BUDGET,
} from "./env-vars.js";

type LoadFeatureFlagsArgs = EnvLoaderArgs;

export function loadFeatureFlags(
  args: LoadFeatureFlagsArgs = {},
): FeatureFlags {
  const loader = resolveEnvLoader(args);
  return {
    placeholder: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_ROOM_FF_PLACEHOLDER,
      definition: ROOM_FF_PLACEHOLDER_ENV,
      env: loader.env,
    }),
    timelineWindowEventBudget: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_ROOM_FF_TIMELINE_WINDOW_EVENT_BUDGET,
      definition: ROOM_FF_TIMELINE_WINDOW_EVENT_BUDGET_ENV,
      env: loader.env,
    }),
  };
}
