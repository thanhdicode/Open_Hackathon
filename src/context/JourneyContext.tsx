import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CountryCode } from "../data/countries";
import { JOURNEYS, journeyById, type Journey } from "../data/journeys";
import { computePairDNA, type PairDNA } from "../data/pairDNA";
import type { DnaScores } from "../data/dna";
import type { JourneyDates } from "../lib/journey/dates";
import { fetchTaskProgress, setTaskProgress } from "../lib/appwrite/taskProgress";
import { loadJourney, saveJourney } from "../lib/appwrite/journeyPersistence";
import { currentUser } from "../lib/appwrite/user";

export type ForcedState = "default" | "loading" | "empty" | "error" | "offline" | "permission" | "lowconf" | "stale";

export type SavedKind = "place" | "insight" | "phrase" | "task";
export interface SavedItem {
  id: string;
  kind: SavedKind;
  title: string;
  subtitle?: string;
  icon?: string;
}

interface JourneyCtx {
  journey: Journey;
  pair: PairDNA;
  setJourneyId: (id: string) => void;
  hydrate: (userId: string, journey: Journey, tasks: Record<string, boolean>) => void;
  /** override home/host/myDna for a freshly onboarded user */
  setCustom: (patch: Partial<Journey>) => void;
  /** live-switch origin/destination while keeping the active MyDNA (ASEAN Compass) */
  setRoute: (home: CountryCode, host: CountryCode) => void;
  forced: ForcedState;
  setForced: (s: ForcedState) => void;
  savedTasks: Record<string, boolean>;
  toggleTask: (id: string) => void;
  saved: SavedItem[];
  toggleSave: (item: SavedItem) => void;
  isSaved: (id: string) => boolean;
}

const Ctx = createContext<JourneyCtx | null>(null);

export function JourneyProvider({ children }: { children: ReactNode }) {
  const [journey, setJourney] = useState<Journey>(journeyById("minh"));
  const [forced, setForced] = useState<ForcedState>("default");
  const [savedTasks, setSavedTasks] = useState<Record<string, boolean>>({});
  const [saved, setSavedItems] = useState<SavedItem[]>([]);
  const userIdRef = useRef<string | null>(null);
  /**
   * Persistence runs from a single effect, never from inside a state updater:
   * React StrictMode double-invokes updaters to surface impurity, which used to
   * fire two concurrent `saveJourney` writes for the same user (409 unique
   * column constraint) and silently drop the first journey save.
   */
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) return;
    dirty.current = false;
    void (async () => {
      const result = await currentUser();
      if (!result.ok) return;
      userIdRef.current = result.user.$id;
      await saveJourney(result.user.$id, journey);
    })().catch((error) => console.error("[yapyep] journey persistence failed", error));
  }, [journey]);

  const editJourney = (updater: (current: Journey) => Journey) => {
    dirty.current = true;
    setJourney(updater);
  };

  const pair = useMemo(() => computePairDNA(journey.home, journey.host, journey.myDna as DnaScores), [journey]);

  const value: JourneyCtx = {
    journey,
    pair,
    setJourneyId: (id) => setJourney(journeyById(id)),
    hydrate: (userId, nextJourney, tasks) => {
      userIdRef.current = userId;
      dirty.current = false;
      setJourney(nextJourney);
      setSavedTasks(tasks);
    },
    setCustom: (patch) => editJourney((j) => ({ ...j, ...patch })),
    setRoute: (home, host) =>
      editJourney((j) => {
        const p = computePairDNA(home, host, j.myDna as DnaScores);
        return { ...j, home, host, readiness: p.readiness };
      }),
    forced,
    setForced,
    savedTasks,
    toggleTask: (id) => {
      setSavedTasks((s) => {
        const next = !s[id];
        if (userIdRef.current) void setTaskProgress(userIdRef.current, id, next).catch((error) => console.error("[yapyep] task progress persistence failed", error));
        else {
          void currentUser().then((result) => {
            if (!result.ok) return;
            userIdRef.current = result.user.$id;
            return setTaskProgress(result.user.$id, id, next);
          }).catch((error) => console.error("[yapyep] task progress persistence failed", error));
        }
        return { ...s, [id]: next };
      });
    },
    saved,
    toggleSave: (item) =>
      setSavedItems((list) => (list.some((s) => s.id === item.id) ? list.filter((s) => s.id !== item.id) : [item, ...list])),
    isSaved: (id) => saved.some((s) => s.id === id),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useJourney() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useJourney must be used within JourneyProvider");
  return c;
}

export function makeCustomJourney(home: CountryCode, host: CountryCode, myDna: DnaScores, dates?: JourneyDates): Partial<Journey> {
  const base = JOURNEYS[0];
  const pair = computePairDNA(home, host, myDna);
  return {
    home,
    host,
    myDna,
    readiness: pair.readiness,
    id: "custom",
    name: "You",
    initials: "Y",
    avatarColor: "#3157D5",
    // The canonical timeline travels with the profile. Without it the stage
    // cannot be derived and Today falls back to the seed journey's dates, which
    // is how a brand-new student used to be shown another student's schedule.
    ...(dates ? { dates } : {}),
  };
}
