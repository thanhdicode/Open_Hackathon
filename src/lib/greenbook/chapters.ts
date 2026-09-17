/**
 * Chapter metadata — the one place that turns a chapter id into human copy.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * Two consumers need it, and they cannot share `store.ts`. The retrieval and
 * fallback path (`no-llm.ts`, `ask.ts`) deliberately avoids importing the
 * Appwrite browser client so it stays testable in plain Node, while `store.ts`
 * imports that client and the chapter table helpers. Putting the titles here
 * keeps them reachable from both without dragging the network client into the
 * fallback — the same reason `trustStateOf` lives in `no-llm.ts`.
 *
 * `store.ts` re-exports `CHAPTER_META`/`CHAPTER_ORDER`/`chapterTitle` so no
 * existing import path changes.
 */

export const CHAPTER_META: Record<string, { title: string; purpose: string; orderIndex: number; icon: string }> = {
  get_ready: { title: "Before you go", purpose: "Documents, money and decisions to settle before you fly.", orderIndex: 1, icon: "passport" },
  land_and_settle: { title: "Landing and settling in", purpose: "What happens at the border and in your first days.", orderIndex: 2, icon: "globe" },
  study_here: { title: "Studying here", purpose: "How your university works, enrols and examines you.", orderIndex: 3, icon: "text" },
  speak_and_understand: { title: "Speaking and understanding", purpose: "The phrases and habits that get you through a day.", orderIndex: 4, icon: "chat" },
  money_and_pay: { title: "Money and paying", purpose: "Bank accounts, cards, transfers and what things cost.", orderIndex: 5, icon: "star" },
  live_here: { title: "Living here", purpose: "SIM cards, housing, utilities and everyday admin.", orderIndex: 6, icon: "settings" },
  move_around: { title: "Getting around", purpose: "Transport, tickets, apps and staying on time.", orderIndex: 7, icon: "pin" },
  stay_safe_and_healthy: { title: "Staying safe and healthy", purpose: "Clinics, insurance, emergencies and who to call.", orderIndex: 8, icon: "alert" },
  culture_and_people: { title: "Culture and people", purpose: "Local norms, courtesy and reading the room.", orderIndex: 9, icon: "connect" },
  student_reality: { title: "Student reality", purpose: "What students actually say about living here.", orderIndex: 10, icon: "camera" },
};

export const CHAPTER_ORDER = Object.entries(CHAPTER_META)
  .sort((a, b) => a[1].orderIndex - b[1].orderIndex)
  .map(([id]) => id);

/**
 * Human title for a chapter id.
 *
 * The no-LLM briefing leads each group of facts with its chapter, and a raw
 * slug there is implementation detail leaking into student-facing copy
 * ("land and settle: …" instead of "Landing and settling in: …"). An unknown
 * chapter id is a real gap, not something to hide — it is rendered readably
 * rather than dropping the facts that live in it.
 */
export function chapterTitle(id: string): string {
  if (CHAPTER_META[id]) return CHAPTER_META[id].title;
  return id.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());
}
