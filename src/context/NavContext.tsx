import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { TabKey } from "../components/shell";

export interface Frame {
  screen: string;
  params?: Record<string, unknown>;
}

interface NavCtx {
  tab: TabKey;
  setTab: (t: TabKey) => void;
  stack: Frame[];
  push: (screen: string, params?: Record<string, unknown>) => void;
  pop: () => void;
  reset: () => void;
  top?: Frame;
  /**
   * A place the app has been asked to reveal on the map.
   *
   * This is the Connect → Explore half of the post ↔ place bridge. `setTab`
   * clears the navigation stack, so a plain tab switch could not carry an
   * argument; a one-shot field that Explore consumes and clears can. It is
   * deliberately a single id rather than a general router, because the bridge is
   * the only cross-tab hand-off the product has.
   */
  pendingPlaceId: string | null;
  focusPlace: (placeId: string) => void;
  clearPendingPlace: () => void;
}

const Ctx = createContext<NavCtx | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<TabKey>("today");
  const [stack, setStack] = useState<Frame[]>([]);
  const [pendingPlaceId, setPendingPlaceId] = useState<string | null>(null);

  const value: NavCtx = useMemo(
    () => ({
      tab,
      setTab: (t) => {
        setStack([]);
        setTab(t);
      },
      stack,
      push: (screen, params) => setStack((s) => [...s, { screen, params }]),
      pop: () => setStack((s) => s.slice(0, -1)),
      reset: () => setStack([]),
      top: stack[stack.length - 1],
      pendingPlaceId,
      focusPlace: (placeId) => {
        setStack([]);
        setPendingPlaceId(placeId);
        setTab("explore");
      },
      clearPendingPlace: () => setPendingPlaceId(null),
    }),
    [tab, stack, pendingPlaceId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNav() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useNav must be used within NavProvider");
  return c;
}
