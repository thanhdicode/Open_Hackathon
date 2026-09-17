import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import type { CountryCode } from "../data/countries";
import { COUNTRIES } from "../data/countries";
import { Icon, type IconName } from "./icons";

/* ----------------------------- Buttons & chips ---------------------------- */

export function Button({
  children,
  onClick,
  variant = "primary",
  full,
  size = "md",
  disabled,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "inverse" | "ghost" | "soft" | "danger" | "outline";
  full?: boolean;
  size?: "md" | "lg" | "sm";
  disabled?: boolean;
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 font-semibold rounded-[12px] transition active:scale-[.98] disabled:opacity-40 disabled:active:scale-100";
  const sizes = {
    sm: "text-[13px] px-3 min-h-[44px]",
    md: "text-[15px] px-4 min-h-[46px]",
    lg: "text-[16px] px-5 min-h-[52px]",
  };
  // Black CTA (ADR-003). No coloured glow: shadows belong to overlays only.
  const variants = {
    primary: "bg-ink text-white",
    inverse: "bg-surface text-ink",
    ghost: "bg-transparent text-primary",
    soft: "bg-primary-soft text-primary",
    danger: "bg-error-soft text-error",
    outline: "bg-surface text-ink border border-line",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${sizes[size]} ${variants[variant]} ${full ? "w-full" : ""} ${className}`}
    >
      {children}
    </button>
  );
}

export function Chip({
  children,
  active,
  onClick,
  tone = "default",
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  tone?: "default" | "primary";
}) {
  const tones = {
    default: active ? "bg-ink text-white border-ink" : "bg-surface text-muted border-line",
    primary: active ? "bg-ink text-white border-ink" : "bg-primary-soft text-primary border-transparent",
  };
  return (
    <button
      onClick={onClick}
      /*
       * `aria-pressed` is not decoration. These chips are a single-choice group
       * whose selected state is currently signalled by colour alone, which a
       * screen reader cannot read and a colour-blind student cannot see. It is
       * also the only machine-readable way for a test to confirm that switching
       * the feed actually happened instead of assuming the tap landed.
       */
      aria-pressed={active ?? false}
      className={`shrink-0 rounded-full border px-3.5 py-2 text-[13px] font-medium transition active:scale-95 min-h-[44px] ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-[12px] bg-canvas p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`flex min-h-[44px] flex-1 items-center justify-center rounded-[9px] px-2 py-2 text-[13px] font-medium transition ${
            value === o.value ? "border border-line bg-surface text-ink" : "text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------- Cards ---------------------------------- */

export function Card({
  children,
  className = "",
  onClick,
  style,
  tone = "surface",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  style?: CSSProperties;
  tone?: "surface" | "ink";
} & Omit<HTMLAttributes<HTMLDivElement>, "children" | "className" | "onClick" | "style">) {
  // Explicit tone instead of a bg-* override: Tailwind resolves competing
  // background utilities by stylesheet order, not class attribute order.
  const tones = {
    surface: "border border-line bg-surface",
    ink: "border border-ink bg-ink text-white",
  };
  return (
    <div
      onClick={onClick}
      style={style}
      // Forwarded so callers can attach data-* hooks (and aria-*) without this
      // component needing a prop for each one.
      {...rest}
      className={`rounded-[12px] ${tones[tone]} ${onClick ? "cursor-pointer transition active:scale-[.99]" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[17px] font-bold tracking-tight text-ink">{title}</h2>
      {action && (
        <button onClick={onAction} className="min-h-[44px] text-[13px] font-semibold text-primary">
          {action}
        </button>
      )}
    </div>
  );
}

/* -------------------------------- Country --------------------------------- */

export function FlagChip({ code, size = 20 }: { code: CountryCode; size?: number }) {
  return <span style={{ fontSize: size, lineHeight: 1 }}>{COUNTRIES[code].flag}</span>;
}

export function CountryPairChip({ home, host, onClick }: { home: CountryCode; host: CountryCode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[13px] font-semibold text-ink"
    >
      <FlagChip code={home} size={16} />
      <span className="text-muted">→</span>
      <FlagChip code={host} size={16} />
      <span className="ml-0.5 text-[12px] text-muted">{COUNTRIES[host].name.split(" ")[0]}</span>
    </button>
  );
}

/* ------------------------------- Progress --------------------------------- */

export function ProgressRing({ value, size = 56, stroke = 6, label }: { value: number; size?: number; stroke?: number; label?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c - (value / 100) * c;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e5e5e1" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={off}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset .6s ease" }}
        />
      </svg>
      <div className="absolute text-center">
        {label ?? <span className="text-[13px] font-bold text-ink">{value}%</span>}
      </div>
    </div>
  );
}

export function ProgressBar({ value, tone = "primary" }: { value: number; tone?: "primary" | "success" }) {
  const colors = { primary: "bg-ink", success: "bg-success" };
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-canvas">
      <div className={`h-full rounded-full ${colors[tone]}`} style={{ width: `${value}%`, transition: "width .6s ease" }} />
    </div>
  );
}

/* --------------------------------- Badges --------------------------------- */

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "primary" | "success" | "warning" | "error" }) {
  const tones = {
    muted: "bg-canvas text-muted",
    primary: "bg-primary-soft text-primary",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-warning",
    error: "bg-error-soft text-error",
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>{children}</span>;
}

export function SourceBadge({ source }: { source?: string }) {
  if (!source) return null;
  return (
    <Badge tone="primary">
      <Icon name="check" size={11} /> {source}
    </Badge>
  );
}

export function FreshnessBadge({ reviewed, status }: { reviewed?: string; status: "verified" | "community" | "review" | "outdated" }) {
  const map = {
    verified: { tone: "success" as const, label: "Official source" },
    community: { tone: "primary" as const, label: "Community verified" },
    review: { tone: "warning" as const, label: "Needs review" },
    outdated: { tone: "error" as const, label: "Outdated" },
  };
  const m = map[status];
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted">
      <Badge tone={m.tone}>{m.label}</Badge>
      {reviewed && <span>Last reviewed {reviewed}</span>}
    </div>
  );
}

export function RiskBadge({ value }: { value: number }) {
  const tone = value >= 60 ? "error" : value >= 40 ? "warning" : "success";
  const color = value >= 60 ? "var(--color-error)" : value >= 40 ? "var(--color-warning)" : "var(--color-success)";
  return (
    <Badge tone={tone}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} /> {value}% risk
    </Badge>
  );
}

/* ------------------------------- Avatar ----------------------------------- */

export function Avatar({ initials, color, size = 40, ring }: { initials: string; color: string; size?: number; ring?: boolean }) {
  return (
    <div
      className={`flex items-center justify-center rounded-full font-bold text-white ${ring ? "ring-2 ring-white" : ""}`}
      style={{ width: size, height: size, background: color, fontSize: size * 0.4 }}
    >
      {initials}
    </div>
  );
}

/* ------------------------------ DNA meters -------------------------------- */

export function DnaBar({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <span className="font-mono text-[12px] text-muted">{value}</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-canvas">
        <div className="h-full rounded-full bg-ink" style={{ width: `${value}%` }} />
      </div>
      {hint && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

export function ScoreBarRow({ label, value, delta }: { label: string; value: number; delta?: number }) {
  const tone = value >= 80 ? "bg-success" : value >= 60 ? "bg-ink" : "bg-warning";
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-[12px] font-bold text-ink">{value}</span>
          {delta != null && delta > 0 && <span className="text-[11px] font-bold text-success">+{delta}</span>}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-canvas">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${value}%`, transition: "width .6s ease" }} />
      </div>
    </div>
  );
}

export function CultureGapMeter({ label, you, host, verdict, tone }: { label: string; you: number; host: number; verdict: string; tone: "success" | "primary" | "warning" }) {
  const toneColor = { success: "var(--color-success)", primary: "var(--color-primary)", warning: "var(--color-warning)" }[tone];
  const lo = Math.min(you, host);
  const hi = Math.max(you, host);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <span className="text-[11px] font-semibold" style={{ color: toneColor }}>{verdict}</span>
      </div>
      <div className="relative h-2.5 w-full rounded-full bg-canvas">
        <div className="absolute h-2.5 rounded-full" style={{ left: `${lo}%`, width: `${hi - lo}%`, background: toneColor, opacity: 0.25 }} />
        <Dot pos={you} color="var(--color-ink)" title="You" />
        <Dot pos={host} color={toneColor} title="Host" hollow />
      </div>
    </div>
  );
}

function Dot({ pos, color, hollow, title }: { pos: number; color: string; hollow?: boolean; title: string }) {
  return (
    <div
      title={title}
      className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
      style={{ left: `${pos}%`, background: hollow ? "#fff" : color, borderColor: color }}
    />
  );
}

/* ------------------------------- States ----------------------------------- */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`yy-skeleton rounded-[10px] ${className}`} />;
}

export function EmptyState({ icon = "info", title, body, action, onAction }: { icon?: IconName; title: string; body?: string; action?: string; onAction?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-canvas text-muted">
        <Icon name={icon} size={24} />
      </div>
      <h3 className="text-[16px] font-bold text-ink">{title}</h3>
      {body && <p className="mt-1 max-w-[240px] text-[13px] text-muted">{body}</p>}
      {action && (
        <div className="mt-4">
          <Button variant="soft" onClick={onAction}>{action}</Button>
        </div>
      )}
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <EmptyState icon="alert" title="Something went wrong" body="We couldn't load this right now. Please try again." action="Retry" onAction={onRetry} />
  );
}

export function OfflineBanner() {
  return (
    <div className="flex items-center gap-2 rounded-[12px] bg-ink px-3 py-2.5 text-[13px] font-medium text-white">
      <Icon name="signal" size={16} /> You're offline — showing saved content
    </div>
  );
}

export function Notice({ tone = "warning", icon, title, body }: { tone?: "warning" | "error" | "primary"; icon: IconName; title: string; body: string }) {
  const tones = {
    warning: "bg-warning-soft border-warning/30 text-warning",
    error: "bg-error-soft border-error/30 text-error",
    primary: "bg-primary-soft border-primary/20 text-primary",
  };
  return (
    <div className={`rounded-[12px] border px-3.5 py-3 ${tones[tone]}`}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">
          <Icon name={icon} size={18} />
        </span>
        <div>
          <p className="text-[13px] font-bold text-ink">{title}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{body}</p>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Bottom sheet / toast ------------------------- */

export function BottomSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-ink/40" />
      <div className="yy-fade relative w-full rounded-t-[14px] bg-surface p-5 pb-7 shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />
        {title && <h3 className="mb-3 text-[17px] font-bold text-ink">{title}</h3>}
        {children}
      </div>
    </div>
  );
}

export function Toast({ text }: { text: string }) {
  return (
    <div className="yy-fade pointer-events-none absolute bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2.5 text-[13px] font-medium text-white shadow-pop">
      {text}
    </div>
  );
}
