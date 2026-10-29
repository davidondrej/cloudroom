import type {
  JsonObject,
  PromptInput,
  ThreadOriginKind,
  ThreadVisibility,
} from "@cloudroom/domain";
import type {
  CreateThreadEnvironmentArgs,
  CreateThreadRequest,
  EnvironmentArgs,
  ProviderEnvironmentArgs,
  StartedOnBehalfOf,
  ThreadCreateOrigin,
} from "@cloudroom/server-contract";

export interface ThreadCreateServiceRequestInput {
  executionTarget?: "local" | "cloud";
  requestId?: string;
  baseBranch?: string;
  environment: CreateThreadEnvironmentArgs;
  executionInputSources?: CreateThreadRequest["executionInputSources"];
  /**
   * Epoch ms the first message should dispatch at. Present ⇒ the thread is
   * created `pending` with no turn and the first message is queued as a row
   * waiting on the clock.
   */
  sendAt?: CreateThreadRequest["sendAt"];
  input: PromptInput[];
  pluginMetadata?: CreateThreadRequest["pluginMetadata"];
  pluginSubmission?: CreateThreadRequest["pluginSubmission"];
  sectionId?: CreateThreadRequest["sectionId"];
  model?: CreateThreadRequest["model"];
  origin: ThreadCreateOrigin | null;
  originPluginId?: CreateThreadRequest["originPluginId"];
  originKind?: ThreadOriginKind | null;
  parentThreadId?: string;
  permissionMode?: CreateThreadRequest["permissionMode"];
  projectId: string;
  providerId?: CreateThreadRequest["providerId"];
  reasoningLevel?: CreateThreadRequest["reasoningLevel"];
  serviceTier?: CreateThreadRequest["serviceTier"];
  sourceSeqEnd?: CreateThreadRequest["sourceSeqEnd"];
  sourceThreadId?: string;
  startedOnBehalfOf: StartedOnBehalfOf | null;
  title?: string;
  visibility?: ThreadVisibility;
}

export interface ThreadCreateServiceRequest extends Omit<
  ThreadCreateServiceRequestInput,
  "environment" | "pluginMetadata" | "providerId"
> {
  environment: EnvironmentArgs | ProviderEnvironmentArgs;
  pluginMetadata: { pluginId: string; metadata: JsonObject } | null;
  providerId: string;
  titleFallback: string | null;
  visibility: ThreadVisibility;
}
