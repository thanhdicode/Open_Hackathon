import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadAccount, signOutCurrentSession, type AccountSnapshot } from "../lib/appwrite/auth";
import { isAuthConfigured } from "../lib/appwrite/auth";

/**
 * Shared account state: who is signed in, whether it is still a guest session,
 * and the actions that change that. Guests are a first-class state here — the
 * product intentionally lets people use YapYep before creating an account.
 */

interface AccountCtx {
  account: AccountSnapshot | null;
  loading: boolean;
  configured: boolean;
  isGuest: boolean;
  isRegistered: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AccountCtx | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const next = await loadAccount();
    setAccount(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value: AccountCtx = useMemo(
    () => ({
      account,
      loading,
      configured: isAuthConfigured(),
      isGuest: Boolean(account) && account?.kind === "guest",
      isRegistered: Boolean(account) && account?.kind === "registered",
      refresh,
      signOut: async () => {
        await signOutCurrentSession();
        setAccount(null);
      },
    }),
    [account, loading, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccount() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAccount must be used within AccountProvider");
  return ctx;
}
