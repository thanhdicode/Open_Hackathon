import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./icons";
import { Avatar } from "./ui";
import { useJourney } from "../context/JourneyContext";
import { useNav } from "../context/NavContext";
import { COUNTRIES } from "../data/countries";

export type TabKey = "today" | "passport" | "lens" | "explore" | "connect";

export const TABS: { key: TabKey; icon: IconName; label: string }[] = [
  { key: "today", icon: "today", label: "Today" },
  { key: "passport", icon: "passport", label: "Passport" },
  { key: "lens", icon: "lens", label: "Lens" },
  { key: "explore", icon: "explore", label: "Explore" },
  { key: "connect", icon: "connect", label: "Connect" },
];

/* --------------------------- Desktop context panel -------------------------- */

interface ContextPanelCtx {
  /** DOM node of the desktop context panel; null when the panel is unavailable. */
  target: HTMLElement | null;
  setTarget: (node: HTMLElement | null) => void;
  /** How many mounted views currently want the panel. */
  claims: number;
  setClaims: (update: (current: number) => number) => void;
}

const PanelCtx = createContext<ContextPanelCtx>({ target: null, setTarget: () => {}, claims: 0, setClaims: () => {} });

function ContextPanelProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  return <PanelCtx.Provider value={{ target, setTarget, claims, setClaims }}>{children}</PanelCtx.Provider>;
}

/**
 * Desktop-only context panel target (ADR-003 §5: optional 280–320px panel).
 * Views portal secondary content (sources, evidence, participant info) here and
 * render it inline below 1200px, so the workspace is never a narrow phone
 * column on desktop. The panel only takes space while a view claims it.
 */
export function useContextPanel() {
  return useContext(PanelCtx).target;
}

/** Declare that the calling view uses the desktop context panel while mounted. */
export function useContextPanelClaim(active = true) {
  const { setClaims } = useContext(PanelCtx);
  useEffect(() => {
    if (!active) return;
    setClaims((n) => n + 1);
    return () => setClaims((n) => Math.max(0, n - 1));
  }, [active, setClaims]);
}

function ContextPanel() {
  const { setTarget, claims } = useContext(PanelCtx);
  const nav = useNav();
  const ref = useRef<HTMLDivElement | null>(null);
  const wide = useMediaQuery(WIDE_PANEL_QUERY);
  // The <aside> stays mounted (CSS-hidden) below `wide`; portalling into it
  // would silently drop content on tablet/mobile, so gate on the real viewport.
  const available = nav.stack.length === 0 && claims > 0 && wide;

  useEffect(() => {
    setTarget(available ? ref.current : null);
    return () => setTarget(null);
  }, [available, setTarget]);

  return (
    <aside
      aria-hidden={!available}
      className={`hidden shrink-0 border-l border-line bg-surface wide:w-[300px] ${
        available ? "wide:block" : "wide:hidden"
      }`}
    >
      <div ref={ref} className="scroll-area h-full overflow-y-auto p-5" />
    </aside>
  );
}

/**
 * Mirrors `--breakpoint-wide` in `src/index.css`: the context panel only fits
 * once rail (220) + workspace (680–800) + panel (300) still add up.
 */
const WIDE_PANEL_QUERY = "(min-width: 1200px)";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/* ---------------------------------- Shell ---------------------------------- */
/**
 * Responsive application shell (ADR-003 §5). The legacy centered
 * `max-w-[420px]` phone frame is gone:
 *  - 360–599 mobile: single column + bottom nav
 *  - 600–1023 tablet/narrow laptop: compact navigation rail
 *  - 1024+ desktop: left rail, 680–800px workspace, optional context panel
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ContextPanelProvider>
      <div className="flex h-[100dvh] w-full overflow-hidden bg-canvas text-ink">
        <NavRail />
        <div className="flex min-w-0 flex-1 justify-center">
          <div className="relative flex h-full min-h-0 w-full max-w-[800px] flex-col">{children}</div>
        </div>
        <ContextPanel />
      </div>
    </ContextPanelProvider>
  );
}

export function NavRail() {
  const nav = useNav();
  const { journey } = useJourney();

  return (
    <nav
      aria-label="Primary"
      className="hidden shrink-0 flex-col border-r border-line bg-surface px-2 py-4 rail:flex rail:w-[76px] desk:w-[220px] desk:px-3"
    >
      <div className="mb-4 flex items-center justify-center gap-2 desk:justify-start desk:px-2">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-ink text-[15px] font-extrabold text-white">Y</span>
        <span className="hidden text-[16px] font-extrabold tracking-tight text-ink desk:inline">YapYep</span>
      </div>

      <button
        onClick={() => nav.push("compass")}
        className="mb-3 hidden min-h-[44px] items-center gap-1.5 rounded-[10px] border border-line px-2.5 desk:flex"
      >
        <span className="text-[15px]">{COUNTRIES[journey.home].flag}</span>
        <span className="text-[12px] text-muted">→</span>
        <span className="text-[15px]">{COUNTRIES[journey.host].flag}</span>
        <span className="ml-0.5 truncate text-[12px] font-semibold text-ink">{COUNTRIES[journey.host].name.split(" ")[0]}</span>
      </button>

      <div className="flex flex-1 flex-col gap-1">
        {TABS.map((t) => {
          const on = nav.tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => nav.setTab(t.key)}
              aria-current={on ? "page" : undefined}
              aria-label={t.label}
              title={t.label}
              className={`relative flex min-h-[44px] items-center justify-center gap-3 rounded-[10px] px-3 text-[13px] font-semibold transition desk:justify-start ${
                on ? "bg-canvas text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {on && <span className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-ink" />}
              <Icon name={t.icon} size={22} filled={on} />
              <span className="hidden desk:inline">{t.label}</span>
            </button>
          );
        })}
      </div>

      <button
        onClick={() => nav.push("profile")}
        aria-label="Profile"
        className="mt-3 flex min-h-[44px] items-center justify-center gap-2 rounded-[10px] px-2 text-[13px] font-semibold text-ink desk:justify-start"
      >
        <Avatar initials={journey.initials} color={journey.avatarColor} size={32} />
        <span className="hidden desk:inline">Profile</span>
      </button>
    </nav>
  );
}

export function TopHeader({
  onAvatar,
  onCompass,
}: {
  onAvatar: () => void;
  onCompass: () => void;
}) {
  const { journey } = useJourney();
  const nav = useNav();
  const active = TABS.find((t) => t.key === nav.tab) ?? TABS[0];

  return (
    <header className="flex min-h-[56px] shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={onCompass}
          className="flex min-h-[44px] items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 active:scale-95 rail:hidden"
        >
          <span className="text-[15px]">{COUNTRIES[journey.home].flag}</span>
          <span className="text-[12px] font-semibold text-muted">→</span>
          <span className="text-[15px]">{COUNTRIES[journey.host].flag}</span>
          <span className="ml-0.5 text-[13px] font-bold text-ink">{COUNTRIES[journey.host].name.split(" ")[0]}</span>
          <Icon name="chevron" size={14} />
        </button>
        <h1 className="hidden truncate text-[16px] font-extrabold tracking-tight text-ink rail:block">{active.label}</h1>
      </div>
      <span className="text-[15px] font-extrabold tracking-tight text-ink rail:hidden">
        YapYep
      </span>
      <button onClick={onAvatar} aria-label="Profile" className="min-h-[44px] min-w-[44px] active:scale-95">
        <Avatar initials={journey.initials} color={journey.avatarColor} size={38} />
      </button>
    </header>
  );
}

export function BottomNavigation({ active, onChange }: { active: TabKey; onChange: (t: TabKey) => void }) {
  return (
    <nav
      aria-label="Primary"
      className="relative z-30 flex shrink-0 items-stretch justify-around border-t border-line bg-surface px-2 pb-5 pt-2 rail:hidden"
    >
      {TABS.map((t) => {
        const on = active === t.key;
        if (t.key === "lens") {
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              aria-current={on ? "page" : undefined}
              aria-label={t.label}
              className="flex min-h-[44px] flex-1 flex-col items-center justify-center"
            >
              <span className="-mt-6 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-white transition active:scale-95">
                <Icon name="lens" size={26} filled />
              </span>
              <span className={`mt-1 text-[10px] font-semibold ${on ? "text-ink" : "text-muted"}`}>{t.label}</span>
            </button>
          );
        }
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            aria-current={on ? "page" : undefined}
            className={`flex min-h-[48px] flex-1 flex-col items-center justify-center gap-0.5 ${on ? "text-ink" : "text-muted"}`}
          >
            <Icon name={t.icon} size={23} filled={on} />
            <span className="text-[10px] font-semibold">{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** Push-screen header with a back button. */
export function ScreenHeader({ title, onBack, right }: { title: string; onBack: () => void; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-3">
      <button onClick={onBack} aria-label="Back" className="flex h-11 w-11 items-center justify-center rounded-full text-ink active:scale-90">
        <Icon name="back" size={22} />
      </button>
      <h1 className="flex-1 truncate text-[16px] font-bold text-ink">{title}</h1>
      {right}
    </header>
  );
}

export function Scroll({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`scroll-area flex-1 overflow-y-auto ${className}`}>{children}</div>;
}
