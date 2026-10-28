import { createContext } from "react";
import type { PromptMentionResource } from "@cloudroom/domain";

export type PromptMentionLinkResolver = (
  resource: PromptMentionResource,
) => (() => void) | null;

export const PromptMentionLinkContext =
  createContext<PromptMentionLinkResolver | null>(null);
