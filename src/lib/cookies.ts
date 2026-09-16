/**
 * Cookie preference architecture.
 *
 * YapYep only sets strictly-necessary cookies (the Appwrite session), so no
 * consent banner is shown while no non-essential category is configured.
 * The banner appears automatically the moment analytics is actually wired up
 * (Phase 6 / product decision), and analytics can never load before consent.
 *
 * Background: ICO guidance exempts strictly-necessary cookies; Singapore PDPC
 * likewise notes consent depends on whether personal data is collected and on
 * the purpose. Marketing cookies are not used at all.
 */

export type CookieCategory = "necessary" | "analytics" | "marketing";

export interface CookieEntry {
  category: CookieCategory;
  name: string;
  provider: string;
  purpose: string;
  duration: string;
  essential: boolean;
}

export const COOKIE_INVENTORY: CookieEntry[] = [
  {
    category: "necessary",
    name: "a_session_<project>",
    provider: "Appwrite",
    purpose: "Keeps you signed in to your YapYep guest or full account and protects requests.",
    duration: "Session to 1 year",
    essential: true,
  },
  {
    category: "analytics",
    name: "_(ga|ga_*)",
    provider: "Google Analytics",
    purpose: "Aggregated usage statistics that help us improve YapYep. Not configured today.",
    duration: "Up to 2 years",
    essential: false,
  },
];

export const COOKIE_CATEGORY_COPY: Record<CookieCategory, { title: string; state: string; detail: string }> = {
  necessary: {
    title: "Strictly necessary",
    state: "Always on",
    detail: "Required to run the service you asked for — sign-in, session and security. These cannot be switched off.",
  },
  analytics: {
    title: "Analytics",
    state: "Off",
    detail: "Optional product analytics. Nothing is collected and no script is loaded until you allow it.",
  },
  marketing: {
    title: "Marketing",
    state: "None",
    detail: "YapYep does not use advertising or marketing cookies.",
  },
};

const STORAGE_KEY = "yy.cookieConsent";

export interface CookieConsent {
  analytics: boolean;
  marketing: boolean;
  decidedAt: string | null;
}

const NO_CONSENT: CookieConsent = { analytics: false, marketing: false, decidedAt: null };

export function readCookieConsent(): CookieConsent {
  if (typeof window === "undefined") return NO_CONSENT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return NO_CONSENT;
    const parsed = JSON.parse(raw) as Partial<CookieConsent>;
    return { analytics: Boolean(parsed.analytics), marketing: false, decidedAt: parsed.decidedAt ?? null };
  } catch {
    return NO_CONSENT;
  }
}

export function writeCookieConsent(consent: { analytics: boolean }): CookieConsent {
  const next: CookieConsent = {
    analytics: Boolean(consent.analytics),
    marketing: false,
    decidedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable (private mode) — consent simply stays default-off */
  }
  return next;
}

/**
 * True only when a non-essential provider is actually present in the build.
 * The Figma Make site plugin injects gtag/dataLayer solely when
 * `.figma/make/site.json` configures `analytics.googleAnalyticsId`, so the
 * presence of those globals is the ground truth for "analytics exists".
 */
export function analyticsConfigured(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { gtag?: unknown; dataLayer?: unknown[] };
  return typeof w.gtag === "function" || Array.isArray(w.dataLayer);
}

export function canLoadAnalytics(): boolean {
  return analyticsConfigured() && readCookieConsent().analytics;
}

/** Banner is only justified when an optional category exists and is undecided. */
export function shouldShowConsentBanner(): boolean {
  return analyticsConfigured() && readCookieConsent().decidedAt === null;
}
