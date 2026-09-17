import Mascot from "../mascot";
/**
 * Shared Greenbook UI primitives.
 *
 * The trust vocabulary lives here so that "Official", "Community" and "Stale"
 * mean exactly the same thing on every screen. A trust badge that is rendered
 * differently in two places is how a field manual starts lying to its reader.
 */
import type { ReactNode } from "react";
import { Badge, BottomSheet, Card } from "../ui";
import { Icon, type IconName } from "../icons";
import type { GreenbookSource, TrustState } from "../../lib/greenbook";

/* --------------------------------- Trust ---------------------------------- */

const TRUST: Record<TrustState, { label: string; tone: "muted" | "primary" | "success" | "warning" | "error"; icon: IconName }> = {
  official: { label: "Official", tone: "success", icon: "check" },
  university: { label: "University", tone: "primary", icon: "check" },
  community: { label: "Community", tone: "warning", icon: "chat" },
  fresh: { label: "Fresh", tone: "success", icon: "check" },
  stale: { label: "Stale", tone: "error", icon: "alert" },
  needs_review: { label: "Needs review", tone: "warning", icon: "info" },
  source_unavailable: { label: "Source unavailable", tone: "error", icon: "alert" },
};

export function TrustBadge({ state }: { state: TrustState }) {
  const meta = TRUST[state] ?? TRUST.needs_review;
  return (
    <Badge tone={meta.tone}>
      <Icon name={meta.icon} size={11} /> {meta.label}
    </Badge>
  );
}

export function trustText(state: TrustState): string {
  return (TRUST[state] ?? TRUST.needs_review).label;
}

/* -------------------------------- Sources --------------------------------- */

export function formatDate(value: string | null | undefined): string {
  if (!value) return "unknown";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "unknown";
  return new Date(parsed).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function SourceRow({ source }: { source: GreenbookSource }) {
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      className="flex items-start gap-3 border-b border-line py-3 last:border-0"
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-canvas text-[11px] font-bold text-muted">
        {source.authorityLevel || "?"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold leading-snug text-ink">{source.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted">{source.url}</span>
        <span className="mt-1 block text-[11px] text-muted">
          Checked {formatDate(source.checkedAt)}
          {source.language ? ` · ${source.language}` : ""}
        </span>
      </span>
      <Icon name="chevron" size={16} />
    </a>
  );
}

export function SourcesDrawer({ open, onClose, sources }: { open: boolean; onClose: () => void; sources: GreenbookSource[] }) {
  return (
    <BottomSheet open={open} onClose={onClose} title={`Sources (${sources.length})`}>
      {sources.length === 0 ? (
        <p className="text-[13px] text-muted">No official source is attached to this guidance yet.</p>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          {sources.map((source) => (
            <SourceRow key={source.sourceId} source={source} />
          ))}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        Authority A is a government, regulator or the university itself. B is an official partner body. C is a reputable secondary source. Nothing here is a
        nationality claim — it is what an official page currently says.
      </p>
    </BottomSheet>
  );
}

/* --------------------------------- Layout --------------------------------- */

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-bold uppercase tracking-wide text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ChapterRow({
  title,
  purpose,
  factCount,
  icon,
  onClick,
}: {
  title: string;
  purpose: string;
  factCount: number;
  icon: string;
  onClick: () => void;
}) {
  const empty = factCount === 0;
  return (
    <Card onClick={onClick} className="mb-2 p-3.5">
      <div className="flex items-center gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${empty ? "bg-canvas text-muted" : "bg-primary-soft text-primary"}`}>
          <Icon name={icon as IconName} size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-ink">{title}</span>
          <span className="mt-0.5 block text-[12px] leading-snug text-muted">{purpose}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className={`block text-[12px] font-bold ${empty ? "text-muted" : "text-ink"}`}>{empty ? "—" : factCount}</span>
          <span className="block text-[10px] text-muted">{empty ? "no data" : "points"}</span>
        </span>
        <Icon name="chevron" size={16} />
      </div>
    </Card>
  );
}

/**
 * Progressive AI states.
 *
 * These are driven by the real request lifecycle, never by a timer. `steps` is
 * the list of things that have actually happened, so a fast answer shows one
 * step and a slow one shows four — the display cannot claim progress that has
 * not occurred.
 */
export function AiThinking({ steps }: { steps: string[] }) {
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <Mascot pose="think" size={40} />
      {steps.map((step, index) => (
        <div key={step} className="flex items-center gap-2 text-[12px] text-muted">
          <span className={`h-1.5 w-1.5 rounded-full ${index === steps.length - 1 ? "yy-pulse bg-primary" : "bg-line"}`} />
          {step}
        </div>
      ))}
    </div>
  );
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-0">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-right text-[12px] font-medium text-ink">{value}</span>
    </div>
  );
}
