import { Icon } from "./icons";
import { Button, Notice } from "./ui";
import type { ActivityState } from "../lib/ai/activity";
import type { AiMeta } from "../lib/ai-contracts/client";

/**
 * Real AI activity display.
 *
 * The state comes from the actual request lifecycle, never from a timer. A
 * single provider request is in flight, so the label describes that request as
 * a whole instead of pretending to advance through internal steps. No
 * chain-of-thought is shown at any point.
 */
export function AiActivity({ state, onCancel }: { state: ActivityState; onCancel?: () => void }) {
  if (state.status === "idle" || state.status === "done") return null;

  const seconds = Math.floor(state.elapsedMs / 1000);
  const busy = state.status !== "error";

  return (
    <div className="rounded-[12px] border border-line bg-surface p-4" role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        {busy ? (
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
            <span className="yy-ring absolute inset-0 motion-reduce:hidden" />
            <span className="h-2.5 w-2.5 rounded-full bg-primary" />
          </span>
        ) : (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
            <Icon name="alert" size={18} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-semibold text-ink">{state.status === "error" ? "That did not work" : state.label || "Working"}</p>
          <p className="mt-0.5 text-[12px] text-muted">
            {state.status === "error" ? state.error?.message : `${seconds}s — this is a real request to the AI service`}
          </p>
        </div>
        {busy && onCancel && (
          <button onClick={onCancel} className="min-h-[44px] shrink-0 px-2 text-[13px] font-semibold text-muted" aria-label="Cancel this request">
            Cancel
          </button>
        )}
      </div>

      {state.status === "error" && onCancel && state.error?.retryable && (
        <div className="mt-3">
          <Button variant="soft" full onClick={onCancel}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

/** Compact inline variant used inside a conversation turn. */
export function AiActivityInline({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted" role="status" aria-live="polite">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
      {label}
    </div>
  );
}

/**
 * Which AI capability answered, in provider-neutral language.
 *
 * The student never sees a vendor name or a raw provider error. What they see
 * is whether a backup was used, because that explains a slower reply without
 * implying the product is broken.
 */
export function AiProvenance({ meta }: { meta?: AiMeta }) {
  if (!meta) return null;
  const usedBackup = meta.fallbackDepth > 0;
  return (
    <p className="mt-3 text-[11px] text-muted">
      {usedBackup ? "Backup AI" : "Primary AI"} · {(meta.latencyMs / 1000).toFixed(1)}s
      {meta.repairs ? ` · corrected once` : ""}
      {meta.degradedProviders.length > 0 ? ` · ${meta.degradedProviders.length} provider${meta.degradedProviders.length === 1 ? "" : "s"} skipped` : ""}
    </p>
  );
}

export type AiNoticeKind = "working" | "retrying" | "backup" | "rate-limited" | "voice-unavailable" | "text-fallback";

const NOTICE_COPY: Record<AiNoticeKind, { title: string; tone: "primary" | "warning" }> = {
  working: { title: "Working", tone: "primary" },
  retrying: { title: "Retrying", tone: "warning" },
  backup: { title: "Using backup AI", tone: "primary" },
  "rate-limited": { title: "AI is busy — trying another route", tone: "warning" },
  "voice-unavailable": { title: "Voice unavailable", tone: "warning" },
  "text-fallback": { title: "Text only", tone: "warning" },
};

/**
 * Provider-neutral status line. No vendor names, no HTTP codes, no stack traces.
 */
export function AiNotice({ kind, body }: { kind: AiNoticeKind; body: string }) {
  const copy = NOTICE_COPY[kind];
  return <Notice tone={copy.tone} icon="info" title={copy.title} body={body} />;
}
