/**
 * Greenbook public API.
 *
 * The single import surface for the UI. Everything the product needs is here, so
 * a screen never reaches into `store.ts` or `ask.ts` directly and the read layer
 * stays free to change.
 */
export * from "./contract";

export {
  CHAPTER_META,
  CHAPTER_ORDER,
  clearGreenbookCache,
  getEntry,
  getProgress,
  listChapters,
  listEntries,
  listFacts,
  listMedia,
  listPhrases,
  listSources,
  listTasks,
  setProgress,
  sourcesByIds,
  trustLabel,
  trustStateOf,
} from "./store";

export { UNVERIFIED_ANSWER, askGreenbook, retrieveEvidence } from "./ask";
