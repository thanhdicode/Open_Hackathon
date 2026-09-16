/**
 * Greenbook shared types — FROZEN INTEGRATION CONTRACT.
 *
 * This file is the seam between the data pipeline, the retrieval layer and the
 * UI. It is written by the integrator, not by any one workstream, so that the
 * RAG layer and the UI can be built in parallel against the same shape.
 *
 * Changing a name or a field here breaks a parallel workstream. Add, do not
 * rename.
 */

/** The statuses scripts/greenbook/validate.mjs is allowed to emit. */
export type VerificationStatus =
  | "official_verified"
  | "university_verified"
  | "community_verified"
  | "needs_review"
  | "conflict"
  | "stale"
  | "unverified"
  | "rejected";

/** What the student sees. Derived from verification status + freshness. */
export type TrustState = "official" | "university" | "community" | "fresh" | "stale" | "needs_review" | "source_unavailable";

export type AuthorityLevel = "A" | "B" | "C" | "D";
export type ConfidenceLabel = "high" | "medium" | "low";

/** The ten chapters, mirroring scripts/greenbook/extract.mjs CHAPTERS. */
export type ChapterId =
  | "get_ready"
  | "land_and_settle"
  | "study_here"
  | "speak_and_understand"
  | "money_and_pay"
  | "live_here"
  | "move_around"
  | "stay_safe_and_healthy"
  | "culture_and_people"
  | "student_reality";

export type JourneyStage = "before_arrival" | "arrival" | "first_week" | "settling" | "ongoing";

/** One stored row of `knowledge_facts`, camelCased for the client. */
export interface GreenbookFact {
  factId: string;
  sourceId: string;
  countryCode: string;
  city: string | null;
  universityId: string | null;
  chapter: string;
  journeyStage: string;
  claim: string;
  action: string | null;
  evidenceQuote: string | null;
  authorityLevel: AuthorityLevel | string;
  verificationStatus: VerificationStatus | string;
  confidenceLabel: ConfidenceLabel | string;
  checkedAt: string;
  validUntil: string | null;
}

/** One stored row of `knowledge_sources`. */
export interface GreenbookSource {
  sourceId: string;
  countryCode: string;
  title: string;
  url: string;
  authorityLevel: string;
  sourceType: string;
  language: string | null;
  checkedAt: string;
  contentHash: string;
  status: string;
}

/** A chapter as the UI renders it. Derived from facts when the table is empty. */
export interface GreenbookChapter {
  chapterId: string;
  countryCode: string;
  title: string;
  purpose: string;
  orderIndex: number;
  factCount: number;
}

/** A guide entry. Derived from facts when `greenbook_entries` is empty. */
export interface GreenbookEntry {
  entryId: string;
  countryCode: string;
  chapterId: string;
  city: string | null;
  universityId: string | null;
  title: string;
  whatToKnow: string;
  whatToDo: string[];
  phraseIds: string[];
  mediaIds: string[];
  factIds: string[];
  sources: GreenbookSource[];
  freshnessLabel: string;
  lastVerifiedAt: string | null;
  status: string;
}

export interface StudentPhrase {
  phraseId: string;
  countryCode: string;
  languageCode: string;
  localText: string;
  romanization: string | null;
  translation: string | null;
  contextKey: string;
  chapter: string | null;
  register: string | null;
  whenToUse: string | null;
  whenNotToUse: string | null;
}

export interface MediaResource {
  mediaId: string;
  platform: string;
  url: string;
  externalId: string | null;
  title: string;
  creator: string | null;
  thumbnailUrl: string | null;
  countryCode: string;
  chapter: string | null;
  trustTier: string;
  embedAllowed: boolean;
  language: string | null;
}

export interface GreenbookTask {
  taskId: string;
  countryCode: string;
  chapterId: string;
  journeyStage: string;
  title: string;
  detail: string | null;
  orderIndex: number;
  factIds: string[];
}

/** The context a retrieval call is allowed to use. */
export interface GreenbookQuery {
  homeCountry: string;
  hostCountry: string;
  city?: string | null;
  university?: string | null;
  journeyStage?: string | null;
  chapter?: string | null;
  entryId?: string | null;
  language?: string | null;
  languageLevel?: string | null;
  question?: string | null;
}

/** Everything retrieval found. The ONLY sources an answer may cite. */
export interface EvidencePacket {
  countryCode: string;
  chapter: string | null;
  facts: GreenbookFact[];
  sources: GreenbookSource[];
  retrievalSteps: string[];
  retrievedAt: string;
}

/**
 * A grounded answer.
 *
 * `mode` is the important field: "no_llm" means every provider failed and the
 * answer was assembled from verified facts without generation. The Greenbook
 * must remain usable in that state, so the UI renders it as a first-class
 * result rather than an error.
 */
export interface GreenbookAnswer {
  answer: string;
  whatToDo: string[];
  whatToPrepare: string[];
  whatToSay: string[];
  warnings: string[];
  confidence: ConfidenceLabel;
  sources: GreenbookSource[];
  lastChecked: string | null;
  mode: "grounded" | "no_llm";
  /** Populated in no_llm mode: the verified facts the answer was built from. */
  facts?: GreenbookFact[];
}
