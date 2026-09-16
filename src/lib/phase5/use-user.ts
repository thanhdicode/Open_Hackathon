import { useEffect, useState } from "react";
import { currentUser } from "../appwrite/user";

/**
 * The signed-in user id, resolved once and shared.
 *
 * Phase 5 writes (a post, a reaction, a saved place) all need an owner id, and
 * `ensureAnonymousSession` is idempotent but not free — calling it from every
 * card that needs an id would issue a session request per render. The promise is
 * cached at module scope for the same reason `session.ts` caches its bootstrap.
 */

let cached: Promise<string | null> | null = null;

export function resolveUserId(): Promise<string | null> {
  if (!cached) {
    cached = currentUser()
      .then((result) => (result.ok ? result.user.$id : null))
      .catch(() => null);
  }
  return cached;
}

/** Drop the cache so the next caller re-resolves (used after sign-out). */
export function resetUserIdCache(): void {
  cached = null;
}

export function useCurrentUserId(): { userId: string | null; loading: boolean } {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    resolveUserId().then((id) => {
      if (cancelled) return;
      setUserId(id);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { userId, loading };
}
