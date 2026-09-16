import { AppwriteException, OAuthProvider, type Models } from "appwrite";
import { account, isAppwriteConfigured } from "./client";
import { ensureAnonymousSession } from "./session";

/**
 * Account upgrade layer (Phase 2).
 *
 * YapYep onboards guests with an anonymous session. Anonymous users cannot sign
 * back in, so after the Passport is generated the user is offered a real
 * account. Appwrite documents that an OAuth2/OTP session created while an
 * anonymous session is active attaches to the *logged-in* account, so the
 * journey rows (keyed by user id) are preserved.
 */

export type AccountKind = "guest" | "registered";

export interface AccountSnapshot {
  userId: string;
  kind: AccountKind;
  email: string | null;
  /** Linked auth providers, e.g. ["email", "google"]. */
  providers: string[];
  name: string;
  prefs: Record<string, unknown>;
}

export function snapshotOf(user: Models.User<Models.Preferences>, linkedProviders: string[] = []): AccountSnapshot {
  const providers = [...linkedProviders];
  if (user.email) providers.unshift("email");
  return {
    userId: user.$id,
    kind: user.email ? "registered" : "guest",
    email: user.email || null,
    providers: Array.from(new Set(providers.filter(Boolean))),
    name: user.name || "",
    prefs: (user.prefs ?? {}) as Record<string, unknown>,
  };
}

export async function loadAccount(): Promise<AccountSnapshot | null> {
  if (!isAppwriteConfigured) return null;
  // Guest-first: make sure a session exists before asking who is signed in,
  // otherwise the very first render (which races session creation) sees null.
  const session = await ensureAnonymousSession();
  if (!session.ok) return null;
  try {
    const user = await account.get();
    // Linked identities live behind a separate call in the web SDK.
    const identities = await account.listIdentities().catch(() => null);
    const providers = (identities?.identities ?? []).map((identity) => identity.provider).filter(Boolean);
    return snapshotOf(user, providers);
  } catch {
    return null;
  }
}

/** Google OAuth upgrade. Redirects away from the app; returns only on failure. */
export async function startGoogleUpgrade(): Promise<void> {
  const origin = window.location.origin;
  // OAuth redirect URLs must sit on a hostname registered in the project's
  // platform list (currently `localhost`), so surface a clear message instead
  // of an opaque Appwrite error.
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && window.location.protocol !== "https:") {
    throw new Error("Google sign-in needs a secure origin (https) or localhost.");
  }
  await account.createOAuth2Session({
    provider: OAuthProvider.Google,
    success: `${origin}/?auth=google`,
    failure: `${origin}/?auth_error=google`,
  });
}

export interface EmailUpgradeTicket {
  userId: string;
  expiresAt: string;
}

/** Step 1 of Email OTP: sends a 6-digit code to the address. */
export async function requestEmailUpgradeCode(userId: string, email: string): Promise<EmailUpgradeTicket> {
  const token = await account.createEmailToken({ userId, email: email.trim().toLowerCase() });
  return { userId: token.userId, expiresAt: token.expire };
}

/** Step 2 of Email OTP: exchanges the 6-digit code for a session. */
export async function completeEmailUpgrade(userId: string, code: string): Promise<AccountSnapshot> {
  const secret = code.replace(/\D/g, "");
  if (secret.length !== 6) throw new Error("Enter the 6-digit code from your email.");
  // Token sessions replace the guest session; keeping both can leave the browser
  // authenticated as the anonymous user during the exchange.
  await account.deleteSession({ sessionId: "current" }).catch(() => undefined);
  await account.createSession({ userId, secret });
  const snapshot = await loadAccount();
  if (!snapshot) throw new Error("We could not confirm your account. Please try again.");
  return snapshot;
}

export async function signOutCurrentSession(): Promise<void> {
  await account.deleteSession({ sessionId: "current" });
}

export function isAuthConfigured(): boolean {
  return isAppwriteConfigured;
}

/** Maps Appwrite auth failures to copy a student can act on. */
export function friendlyAuthError(error: unknown): string {
  if (error instanceof AppwriteException) {
    if (error.code === 401) return "That code is not valid or has expired. Request a new one.";
    if (error.code === 409) return "That email is already linked to another YapYep account.";
    if (error.code === 429) return "Too many attempts. Please wait a moment and try again.";
    if (error.code === 501) return "This sign-in method is not enabled for YapYep yet.";
    if (error.type === "user_unauthorized" || error.type === "general_unauthorized_scope") {
      return "Google sign-in is not enabled for YapYep yet. Use Email instead.";
    }
    if (error.message?.toLowerCase().includes("provider")) {
      return "Google sign-in is not enabled for YapYep yet. Use Email instead.";
    }
    return error.message || "We could not complete sign-in. Please try again.";
  }
  if (error instanceof Error) return error.message;
  return "We could not complete sign-in. Please try again.";
}
