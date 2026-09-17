import { routes, LEGACY_ACTIONS } from "./routes.js";
import { ProviderError } from "./providers.js";
import { logEvent, stripForbiddenKeys } from "./privacy.js";
import { isLiveTranslateSupported, voiceFallbackFor } from "./live-languages.js";
import { Client, TablesDB, Query } from "node-appwrite";
import { preflightGreenbook, validateGroundingPacket, validateGroundedAnswer } from "./grounding.js";

/**
 * ai-gateway entrypoint.
 *
 * One function, one route table. The client addresses a route with `xpath`
 * (Appwrite maps it onto req.path); the legacy `action` field is still accepted
 * so an older client build cannot hard-fail.
 *
 * Nothing here logs user content or provider keys, and no response body may
 * carry a provider secret, raw media or a reasoning trace.
 */

const STATUS_FOR_CODE = {
  RATE_LIMITED: 429,
  PAYMENT_REQUIRED: 402,
  SCHEMA_INVALID: 502,
  AI_UNAVAILABLE: 503,
  AI_EMPTY: 503,
  NOT_CONFIGURED: 503,
  LANGUAGE_UNSUPPORTED: 422,
  UNSUPPORTED_MEDIA: 422,
  INVALID_FILE: 422,
  FILE_TOO_LARGE: 413,
  EMPTY_TRANSCRIPT: 422,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
};

function send(res, body, status) {
  return res.json(stripForbiddenKeys(body), status);
}

function resolveRoute(path, body) {
  if (path && routes[path]) return { path, route: routes[path] };
  if (body?.route && routes[body.route]) return { path: body.route, route: routes[body.route] };
  if (body?.action && LEGACY_ACTIONS[body.action]) {
    const mapped = LEGACY_ACTIONS[body.action];
    return { path: mapped, route: routes[mapped] };
  }
  return null;
}

export default async ({ req, res, error }) => {
  const startedAt = Date.now();
  let routePath = "unknown";
  try {
    let body = {};
    try {
      body = JSON.parse(req.bodyText || "{}");
    } catch {
      return send(res, { ok: false, code: "BAD_REQUEST", message: "Request body must be JSON.", retryable: false }, 400);
    }

    const resolved = resolveRoute(req.path, body);
    if (!resolved) {
      return send(res, { ok: false, code: "NOT_FOUND", message: `Unknown route: ${req.path || body.action || "(none)"}.`, retryable: false }, 404);
    }
    routePath = resolved.path;

    const request = resolved.route.request.safeParse(body);
    if (!request.success) {
      const issues = request.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      return send(res, { ok: false, code: "BAD_REQUEST", message: "The request did not match the route contract.", issues, retryable: false }, 400);
    }
    const input = request.data;
    if (routePath === "/greenbook/ask") {
      const preflight = preflightGreenbook(input);
      if (preflight) return send(res, { ok: true, data: { answer: preflight.answer, whatToDo: [], whatToPrepare: [], whatToSay: [], warnings: [], confidence: "low", citedSourceIds: [] } }, 200);
      if (!input.sources.length) return send(res, { ok: false, code: "BAD_REQUEST", message: "Verified sources are required.", retryable: false }, 400);
      const endpoint = process.env.VITE_APPWRITE_ENDPOINT || process.env.APPWRITE_FUNCTION_API_ENDPOINT;
      const project = process.env.VITE_APPWRITE_PROJECT_ID || process.env.APPWRITE_FUNCTION_PROJECT_ID;
      const key = process.env.APPWRITE_API_KEY || req.headers?.["x-appwrite-key"];
      const databaseId = process.env.VITE_APPWRITE_DATABASE_ID;
      if (!endpoint || !project || !key || !databaseId) return send(res, { ok: false, code: "NOT_CONFIGURED", message: "Verified guidance is temporarily unavailable.", retryable: true }, 503);
      const tables = new TablesDB(new Client().setEndpoint(endpoint).setProject(project).setKey(key));
      const [facts, sources] = await Promise.all([
        tables.listRows({ databaseId, tableId: "knowledge_facts", queries: [Query.equal("fact_id", input.evidence.map((fact) => fact.factId)), Query.limit(40)] }),
        tables.listRows({ databaseId, tableId: "knowledge_sources", queries: [Query.equal("source_id", input.sources.map((source) => source.sourceId)), Query.limit(40)] }),
      ]);
      if (!validateGroundingPacket(input, { trustedFacts: facts.rows, trustedSources: sources.rows }).ok) return send(res, { ok: false, code: "BAD_REQUEST", message: "The verified guidance could not be checked. Please refresh and try again.", retryable: true }, 400);
    }

    // Refuse a live voice session we cannot honour rather than degrading silently.
    if (routePath === "/live/token" && input.mode === "translate") {
      const target = input.targetLanguage || input.journey?.host;
      if (!isLiveTranslateSupported(target)) {
        return send(
          res,
          {
            ok: false,
            code: "LANGUAGE_UNSUPPORTED",
            message: `Live voice translation is not available for ${target || "that language"} yet.`,
            fallback: voiceFallbackFor(target, input.journey?.host),
            retryable: false,
          },
          422,
        );
      }
    }

    const outcome = await resolved.route.handler(input);
    const result = resolved.route.result.safeParse(outcome.data);
    if (!result.success) {
      logEvent(error, routePath, "RESULT_CONTRACT_MISMATCH");
      return send(res, { ok: false, code: "SCHEMA_INVALID", message: "The AI result did not match its contract.", retryable: true }, 502);
    }
    if (routePath === "/greenbook/ask" && !validateGroundedAnswer(input, result.data).ok) return send(res, { ok: false, code: "SCHEMA_INVALID", message: "This answer could not be verified.", retryable: false }, 502);

    return send(
      res,
      {
        ok: true,
        data: result.data,
        meta: {
          route: routePath,
          // Provider-neutral telemetry. The client shows "using backup AI"
          // rather than a vendor name or a raw provider error.
          providerUsed: outcome.provider ?? "unknown",
          model: outcome.model ?? "unknown",
          fallbackDepth: outcome.fallbackDepth ?? 0,
          degradedProviders: (outcome.skipped ?? []).filter((entry) => entry.reason === "cooldown").map((entry) => entry.provider),
          unconfiguredProviders: (outcome.skipped ?? []).filter((entry) => entry.reason === "unconfigured").map((entry) => entry.provider),
          attempts: outcome.attempts ?? 1,
          ...(outcome.schemaMode ? { schemaMode: outcome.schemaMode } : {}),
          ...(typeof outcome.repairs === "number" && outcome.repairs > 0 ? { repairs: outcome.repairs } : {}),
          // Two-stage routes report which provider served each stage, so a
          // degraded extraction is visible without exposing vendor errors.
          ...(outcome.stages ? { stages: outcome.stages } : {}),
          latencyMs: Date.now() - startedAt,
        },
      },
      200,
    );
  } catch (cause) {
    const code = cause instanceof ProviderError ? cause.code : "AI_UNAVAILABLE";
    logEvent(error, routePath, code);
    // Never surface a provider stack trace or a vendor name to the student.
    const message =
      code === "RATE_LIMITED"
        ? "The AI service is busy right now. Your input is kept — try again in a moment."
        : code === "PAYMENT_REQUIRED"
          ? "That AI capability is not available on the current plan. Trying another route."
          : code === "SCHEMA_INVALID"
            ? "The AI returned a result that did not match the expected format. Try again."
            : "The AI service is temporarily unavailable. Your input is kept — try again.";
    return send(
      res,
      {
        ok: false,
        code,
        message,
        retryable: code !== "NOT_FOUND" && code !== "BAD_REQUEST",
        // Which providers were tried, without their raw errors.
        attempted: (cause?.attempted ?? []).map((entry) => ({ provider: entry.provider, code: entry.code })),
      },
      STATUS_FOR_CODE[code] ?? 503,
    );
  }
};
