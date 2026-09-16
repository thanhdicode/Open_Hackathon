import { z } from "zod";
import { ExecutionMethod } from "appwrite";
import { functions } from "../appwrite/client";

/**
 * Single client entry point for every AI route.
 *
 * Responsibilities:
 *  - call the ai-gateway function by route
 *  - map provider failures to a code the UI can act on
 *  - validate the response against the client contract before the UI sees it
 *
 * A response that fails client validation is reported as SCHEMA_INVALID and is
 * never rendered. No default is substituted to make a bad payload look valid.
 */

export type AiErrorCode =
  | "RATE_LIMITED"
  | "SCHEMA_INVALID"
  | "AI_UNAVAILABLE"
  | "AI_EMPTY"
  | "NOT_CONFIGURED"
  | "LANGUAGE_UNSUPPORTED"
  | "INVALID_FILE"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_MEDIA"
  | "EMPTY_TRANSCRIPT"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "OFFLINE";

/**
 * Provider-neutral telemetry.
 *
 * The UI shows "using backup AI", never a vendor name or a raw provider error.
 * `providerUsed` and `degradedProviders` exist for the debug panel and the
 * health view, not for user-facing copy.
 */
export interface AiMeta {
  route: string;
  providerUsed: string;
  model: string;
  /** 0 = the first provider in the chain answered; 1+ = a fallback did. */
  fallbackDepth: number;
  /** Providers skipped because their circuit was open. */
  degradedProviders: string[];
  /** Providers skipped because their credentials are absent. */
  unconfiguredProviders: string[];
  attempts: number;
  schemaMode?: "native" | "prompt" | "strict" | "object" | "plain";
  /** 1 means the provider answered wrong once and was repaired. */
  repairs?: number;
  latencyMs: number;
}

export class AiError extends Error {
  code: AiErrorCode;
  retryable: boolean;
  status: number;
  /** Present for LANGUAGE_UNSUPPORTED: the languages that do work. */
  fallback?: { options?: string[]; typedTextStillAvailable?: boolean; reason?: string };
  issues?: string[];

  constructor(code: AiErrorCode, message: string, { retryable = true, status = 0, fallback, issues }: { retryable?: boolean; status?: number; fallback?: AiError["fallback"]; issues?: string[] } = {}) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.fallback = fallback;
    this.issues = issues;
  }
}

const MESSAGES: Record<AiErrorCode, string> = {
  RATE_LIMITED: "The AI service is busy right now. Your input is kept — try again in a moment.",
  SCHEMA_INVALID: "The AI returned a result that did not match the expected format. Nothing was shown rather than showing something wrong.",
  AI_UNAVAILABLE: "The AI service is temporarily unavailable. Your input is kept — try again.",
  AI_EMPTY: "The AI returned an empty result. Try again or rephrase your input.",
  NOT_CONFIGURED: "AI is not configured for this environment yet.",
  LANGUAGE_UNSUPPORTED: "Live voice is not available for this language yet.",
  INVALID_FILE: "That file could not be used. Try a different image or audio file.",
  FILE_TOO_LARGE: "That file is too large to process. Try a smaller one.",
  UNSUPPORTED_MEDIA: "That file type is not supported.",
  EMPTY_TRANSCRIPT: "No speech was detected in that recording.",
  BAD_REQUEST: "Something in the request was not valid. Adjust your input and try again.",
  NOT_FOUND: "That AI route does not exist.",
  OFFLINE: "You appear to be offline. Your input is kept — reconnect and try again.",
};

export interface AiCallOptions {
  /** Abort the in-flight request when the user cancels. */
  signal?: AbortSignal;
  /** Route the call for an explicit user-chosen override instead of detection. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;

export async function callAi<T>(route: string, body: Record<string, unknown>, schema: z.ZodType<T>, options: AiCallOptions = {}): Promise<{ data: T; meta: AiMeta }> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new AiError("OFFLINE", MESSAGES.OFFLINE, { retryable: true });
  }

  let execution: { responseBody?: string | null; responseStatusCode?: number };
  try {
    execution = await functions.createExecution({
      functionId: "ai-gateway",
      body: JSON.stringify(body),
      async: false,
      xpath: route,
      method: ExecutionMethod.POST,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (/abort/i.test(message) || options.signal?.aborted) throw new AiError("AI_UNAVAILABLE", "Cancelled.", { retryable: true });
    throw new AiError("AI_UNAVAILABLE", MESSAGES.AI_UNAVAILABLE, { retryable: true });
  }

  let payload: { ok?: boolean; data?: unknown; meta?: AiMeta; code?: AiErrorCode; message?: string; retryable?: boolean; fallback?: AiError["fallback"]; issues?: string[] };
  try {
    payload = JSON.parse(execution.responseBody || "{}");
  } catch {
    throw new AiError("AI_UNAVAILABLE", MESSAGES.AI_UNAVAILABLE, { retryable: true, status: execution.responseStatusCode ?? 0 });
  }

  if (!payload.ok) {
    const code = (payload.code ?? "AI_UNAVAILABLE") as AiErrorCode;
    throw new AiError(code, payload.message || MESSAGES[code] || MESSAGES.AI_UNAVAILABLE, {
      retryable: payload.retryable ?? true,
      status: execution.responseStatusCode ?? 0,
      fallback: payload.fallback,
      issues: payload.issues,
    });
  }

  const parsed = schema.safeParse(payload.data);
  if (!parsed.success) {
    throw new AiError("SCHEMA_INVALID", MESSAGES.SCHEMA_INVALID, {
      retryable: true,
      issues: parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    });
  }

  return {
    data: parsed.data,
    meta:
      payload.meta ??
      ({ route, providerUsed: "unknown", model: "unknown", fallbackDepth: 0, degradedProviders: [], unconfiguredProviders: [], attempts: 1, latencyMs: 0 } satisfies AiMeta),
  };
}
