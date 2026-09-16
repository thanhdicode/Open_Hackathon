import { routes, LEGACY_ACTIONS } from "./routes.js";
import { ProviderError } from "./providers.js";
import { logEvent, stripForbiddenKeys } from "./privacy.js";
import { isLiveTranslateSupported, voiceFallbackFor } from "./live-languages.js";

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
