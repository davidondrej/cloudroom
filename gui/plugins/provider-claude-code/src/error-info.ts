import {
  type ProviderErrorCategory,
  type ProviderErrorInfo,
} from "@get-bb/plugin-sdk/provider-bridge";
import type {
  ClaudeAssistantMessageError,
  ClaudeResultSubtype,
} from "./schemas.js";

interface BuildClaudeProviderErrorInfoArgs {
  code?: ClaudeAssistantMessageError;
  httpStatusCode?: number | null;
  resultSubtype?: string;
  /** The error text Claude Code showed, e.g. "Can't reach the API server … (ENOTFOUND)". */
  detail?: string;
}

/**
 * Claude Code reports a dead network as `server_error` with no HTTP status, so
 * the only honest signal is its own wording: "Can't reach the API server",
 * "Connection refused", "No internet route", "Connection dropped" and the
 * older "Unable to connect to API", each with a socket code in parentheses.
 */
const CLAUDE_NETWORK_ERROR =
  /Can't reach the API server|No internet route|Unable to connect to API|Connection dropped|Connection refused|\((?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN)\)/;

function getProviderErrorCategoryFromHttpStatus(
  httpStatusCode: number,
): ProviderErrorCategory {
  if (httpStatusCode === 402) {
    return "billing";
  }
  if (httpStatusCode === 401 || httpStatusCode === 403) {
    return "unauthorized";
  }
  if (httpStatusCode === 429) {
    return "rate-limit";
  }
  if (httpStatusCode === 529) {
    return "overloaded";
  }
  if (httpStatusCode >= 400 && httpStatusCode < 500) {
    return "bad-request";
  }
  if (httpStatusCode >= 500 && httpStatusCode < 600) {
    return "internal";
  }
  return "unknown";
}

function getProviderErrorCategoryFromClaudeCode(
  code: ClaudeAssistantMessageError,
  httpStatusCode: number | null,
): ProviderErrorCategory {
  if (httpStatusCode === 529) {
    return "overloaded";
  }

  switch (code) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return "unauthorized";
    case "billing_error":
      return "billing";
    case "rate_limit":
      return "rate-limit";
    case "invalid_request":
    case "model_not_found":
      return "bad-request";
    case "server_error":
      return "internal";
    case "max_output_tokens":
      return "max-output-tokens";
    case "unknown":
      return httpStatusCode !== null
        ? getProviderErrorCategoryFromHttpStatus(httpStatusCode)
        : "unknown";
  }
}

function parseClaudeResultSubtype(
  resultSubtype: string | undefined,
): ClaudeResultSubtype | null {
  switch (resultSubtype) {
    case "success":
    case "error_during_execution":
    case "error_max_turns":
    case "error_max_budget_usd":
    case "error_max_structured_output_retries":
      return resultSubtype;
    default:
      return null;
  }
}

function getProviderErrorCategoryFromClaudeResultSubtype(
  resultSubtype: ClaudeResultSubtype,
): ProviderErrorCategory {
  switch (resultSubtype) {
    case "success":
    case "error_during_execution":
      return "unknown";
    case "error_max_turns":
      return "max-turns";
    case "error_max_budget_usd":
      return "budget-exceeded";
    case "error_max_structured_output_retries":
      return "structured-output-retries";
  }
}

function getClaudeProviderCode(
  args: BuildClaudeProviderErrorInfoArgs,
): string | null {
  if (args.code !== undefined) {
    return args.code;
  }
  const resultSubtype = parseClaudeResultSubtype(args.resultSubtype);
  if (resultSubtype && resultSubtype !== "success") {
    return resultSubtype;
  }
  return null;
}

export function buildClaudeProviderErrorInfo(
  args: BuildClaudeProviderErrorInfoArgs,
): ProviderErrorInfo | null {
  const httpStatusCode = args.httpStatusCode ?? null;
  const resultSubtype = parseClaudeResultSubtype(args.resultSubtype);
  const networkFailure =
    httpStatusCode === null &&
    args.detail !== undefined &&
    CLAUDE_NETWORK_ERROR.test(args.detail);
  const category = networkFailure
    ? "connection-failed"
    : args.code !== undefined
      ? getProviderErrorCategoryFromClaudeCode(args.code, httpStatusCode)
      : httpStatusCode !== null
        ? getProviderErrorCategoryFromHttpStatus(httpStatusCode)
        : resultSubtype
          ? getProviderErrorCategoryFromClaudeResultSubtype(resultSubtype)
          : "unknown";
  const providerCode = getClaudeProviderCode(args);
  if (
    category === "unknown" &&
    providerCode === null &&
    httpStatusCode === null
  ) {
    return null;
  }

  return {
    category,
    providerCode,
    httpStatusCode,
  };
}
