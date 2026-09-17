/**
 * Phase 5 — Connect + Explore contracts.
 *
 * These types are the boundary between Appwrite rows (snake_case, strings for
 * numbers, JSON columns as strings) and the UI (camelCase, real types). The
 * mapping happens once, here, so no screen has to know that `is_demo_seed` is an
 * integer or that `tags` arrives as a JSON string.
 */

import type { ExchangeStage } from "../journey/dates";

/* ------------------------------- Community ------------------------------- */

export const POST_TYPES = ["moment", "tip", "question", "place", "warning", "guide", "culture", "study"] as const;
export type PostType = (typeof POST_TYPES)[number];

export const POST_TYPE_META: Record<PostType, { label: string; icon: string; tone: "muted" | "primary" | "success" | "warning" | "error" }> = {
  moment: { label: "Moment", icon: "star", tone: "muted" },
  tip: { label: "Tip", icon: "check", tone: "success" },
  question: { label: "Question", icon: "chat", tone: "primary" },
  place: { label: "Place", icon: "pin", tone: "primary" },
  warning: { label: "Warning", icon: "alert", tone: "warning" },
  guide: { label: "Guide", icon: "text", tone: "muted" },
  culture: { label: "Culture", icon: "globe", tone: "muted" },
  study: { label: "Study", icon: "practice", tone: "muted" },
};

/**
 * Feed filters. The five scopes lead because they are the modes the product
 * promises; the type filters and Host Country follow because they are useful
 * narrowing, not destinations. `for_you` is the only one that is *ranked* — every
 * other mode is a plain reverse-chronological or owner-scoped list, so a student
 * can always reach the raw stream when they want to.
 */
export const FEED_FILTERS = [
  { key: "for_you", label: "For You" },
  { key: "latest", label: "Latest" },
  { key: "my_university", label: "My University" },
  { key: "near_campus", label: "Near Campus" },
  { key: "saved", label: "Saved" },
  { key: "host_country", label: "Host Country" },
  { key: "tips", label: "Tips" },
  { key: "places", label: "Places" },
  { key: "questions", label: "Questions" },
  { key: "moments", label: "Moments" },
] as const;

export type FeedFilter = (typeof FEED_FILTERS)[number]["key"];

/** Which post types each filter admits. `null` means "no type restriction". */
export const FILTER_TYPES: Record<FeedFilter, PostType[] | null> = {
  for_you: null,
  latest: null,
  host_country: null,
  my_university: null,
  near_campus: null,
  tips: ["tip", "guide"],
  places: ["place"],
  questions: ["question"],
  moments: ["moment"],
  saved: null,
};

/**
 * Feed modes that are scoped by the viewer's own journey rather than by post
 * type. `near_campus` is a *place* scope: it keeps posts whose tagged place sits
 * inside the campus radius, which is what "what is around my campus" means. It
 * is not live-location proximity — no viewer coordinate is ever involved.
 */
export const SCOPED_FILTERS: FeedFilter[] = ["for_you", "host_country", "my_university", "near_campus", "latest", "saved"];

/* ---------------------------------- media --------------------------------- */

export type MediaKind = "image" | "video";

/**
 * What the composer and the uploader accept.
 *
 * These are demo limits, deliberately conservative, and they are the single
 * source of truth for both the client validation and the bucket allowlist — a
 * bucket that accepts `svg` or `html` while the UI says "JPG, PNG, WebP or MP4"
 * is a stored-XSS surface with a friendly label on it.
 *
 * Images are resized in the browser before upload, so the image cap is generous
 * enough that a normal phone photo passes without the student seeing an error.
 * Video is short-form only: this is a community post, not a Reels product.
 */
export const MEDIA_LIMITS = {
  maxImagesPerPost: 4,
  maxVideosPerPost: 1,
  maxImageBytes: 6_000_000,
  maxVideoBytes: 20_000_000,
  /** Advisory, surfaced to the student before upload rather than enforced after. */
  preferredVideoSeconds: 30,
  imageMime: ["image/jpeg", "image/png", "image/webp"],
  videoMime: ["video/mp4", "video/webm"],
  imageExtensions: ["jpg", "jpeg", "png", "webp"],
  videoExtensions: ["mp4", "webm"],
} as const;

export const ALLOWED_MEDIA_MIME: readonly string[] = [...MEDIA_LIMITS.imageMime, ...MEDIA_LIMITS.videoMime];

export function mediaKindFor(mime: string): MediaKind | null {
  if ((MEDIA_LIMITS.imageMime as readonly string[]).includes(mime)) return "image";
  if ((MEDIA_LIMITS.videoMime as readonly string[]).includes(mime)) return "video";
  return null;
}

export interface PostMedia {
  id: string;
  kind: MediaKind;
  /** Local `/demo-media/...` path for seeded assets, or an Appwrite file URL. */
  url: string;
  alt: string;
  attribution?: string;
  license?: string;
  /** Only meaningful for `kind === "video"`; read from the file, never invented. */
  durationS?: number;
}

export interface AuthorSummary {
  id: string;
  displayName: string;
  initials: string;
  color: string;
  homeCountry?: string;
  hostCountry?: string;
  universityId?: string;
  /** ISO codes, so the ranker can compare them without a second lookup. */
  languages?: string[];
  /** True only for seeded fixtures. Drives the visible "Demo" marker. */
  isDemoSeed: boolean;
}

export interface CommunityPost {
  id: string;
  authorId: string;
  author: AuthorSummary;
  countryCode: string;
  universityId: string;
  postType: PostType;
  body: string;
  placeId?: string;
  tags: string[];
  /**
   * Where in the exchange timeline the author was when they wrote this.
   * Populated by AI enrichment when it succeeds and by the deterministic
   * keyword extractor when it does not, so the field is always present and the
   * ranker never has to branch on "is enrichment available".
   */
  journeyStage?: ExchangeStage;
  /** AI-derived topics. Falls back to deterministic keyword extraction. */
  topics: string[];
  reactionCount: number;
  commentCount: number;
  saveCount: number;
  media: PostMedia[];
  isDemoSeed: boolean;
  verification?: string;
  createdAt: string;
  /** Viewer-specific state, resolved from the viewer's own rows. */
  viewerReacted: boolean;
  viewerSaved: boolean;
  /**
   * Human-readable reasons this post was ranked where it was. Only set by the
   * For You ranker — every other feed mode leaves it empty, because a
   * chronological list has nothing to explain. The UI shows these instead of a
   * score: a student can audit "Students at NUS" but not "0.83 relevance".
   */
  reasons?: string[];
}

export interface PostComment {
  id: string;
  postId: string;
  authorId: string;
  author: AuthorSummary;
  body: string;
  isDemoSeed: boolean;
  createdAt: string;
}

/* --------------------------------- People -------------------------------- */

export const EXCHANGE_ROLES = ["local", "current_exchange", "incoming", "returned"] as const;
export type ExchangeRole = (typeof EXCHANGE_ROLES)[number];

export const ROLE_LABELS: Record<ExchangeRole, string> = {
  local: "Local student",
  current_exchange: "On exchange now",
  incoming: "Incoming",
  returned: "Returned home",
};

export interface SocialProfile {
  userId: string;
  displayName: string;
  initials: string;
  color: string;
  role: ExchangeRole;
  homeCountry?: string;
  hostCountry?: string;
  city: string;
  universityId: string;
  major: string;
  bio: string;
  languages: string[];
  interests: string[];
  discoverable: boolean;
  localHelper: boolean;
  isDemoSeed: boolean;
  verification?: string;
  joinedAt?: string;
  /** Always false. Stored so the claim is testable rather than a UI promise. */
  liveLocationShared: boolean;
  counts: { posts: number; tips: number; placesShared: number; helpfulAnswers: number };
}

export interface MatchReason {
  label: string;
  detail: string;
}

export interface ScoredProfile {
  profile: SocialProfile;
  score: number;
  reasons: MatchReason[];
}

/* --------------------------------- Explore ------------------------------- */

export const EXPLORE_CATEGORIES = [
  { key: "all", label: "All" },
  { key: "campus", label: "Campus" },
  { key: "study", label: "Study" },
  { key: "food", label: "Food" },
  { key: "coffee", label: "Coffee" },
  { key: "health", label: "Health" },
  { key: "pharmacy", label: "Pharmacy" },
  { key: "banking", label: "Banking" },
  { key: "transport", label: "Transport" },
  { key: "culture", label: "Culture" },
  { key: "religion", label: "Religion" },
  { key: "hangout", label: "Hangout" },
  { key: "studentlife", label: "Student Life" },
] as const;

export type ExploreCategory = (typeof EXPLORE_CATEGORIES)[number]["key"];

export const EXPLORE_SCOPES = [
  { key: "for_you", label: "For You" },
  { key: "students_recommend", label: "Students recommend" },
  { key: "saved", label: "Saved" },
  { key: "near_campus", label: "Near campus" },
] as const;

export type ExploreScope = (typeof EXPLORE_SCOPES)[number]["key"];

/**
 * A place is two layers, and they are never merged in one record:
 * the objective base (name, coordinates, OSM identity) and the community layer
 * (what students said). `studentSaves`/`studentStories` are denormalised counts
 * of real rows, not decoration.
 */
export interface Place {
  id: string;
  name: string;
  category: ExploreCategory;
  description: string;
  address: string;
  lat: number;
  lng: number;
  city: string;
  countryCode: string;
  universityId: string;
  campusId?: string;
  osmType?: string;
  osmId?: string;
  /** `osm_overpass` (Tier D, discovery only) or `seed_pack_researched` (Tier C). */
  source: string;
  authorityLevel: string;
  isDemoSeed: boolean;
  studentSaves: number;
  studentStories: number;
  communityTags: { key: string; value: string }[];
  /** Metres from the campus centre. Always available, unlike viewer distance. */
  distanceFromCampusM: number;
}

/** The community layer: one student's experience of one place. */
export interface PlaceContribution {
  id: string;
  placeId: string;
  authorId: string;
  author: AuthorSummary;
  note: string;
  mediaUrl?: string;
  tags: { key: string; value: string }[];
  visitContext?: string;
  isDemoSeed: boolean;
  createdAt: string;
}

/** Viewer-relative, and deliberately never persisted as an absolute position. */
export type LocationPermission = "not_requested" | "requesting" | "granted" | "denied" | "unavailable";

/* -------------------------------- Constants ------------------------------ */

export const VISIT_CONTEXTS = [
  { key: "first_week", label: "First week" },
  { key: "settling", label: "Settling in" },
  { key: "ongoing", label: "Ongoing" },
  { key: "visiting", label: "Just visiting" },
] as const;

/** Community attributes a student can attach to a place experience. */
export const EXPERIENCE_TAGS = [
  { key: "good_study", label: "Good study place" },
  { key: "cheap_food", label: "Cheap food" },
  { key: "quiet", label: "Quiet" },
  { key: "wifi", label: "Wi-Fi" },
  { key: "power_outlets", label: "Power outlets" },
  { key: "social", label: "Social" },
  { key: "late_night", label: "Late night" },
  { key: "cash", label: "Cash only" },
  { key: "card", label: "Cards accepted" },
  { key: "language_hard", label: "Language can be hard" },
  { key: "halal", label: "Halal" },
  { key: "aircon", label: "Air-conditioned" },
] as const;

export type ExperienceTagKey = (typeof EXPERIENCE_TAGS)[number]["key"];

export const REPORT_REASONS = [
  { key: "spam", label: "Spam or advertising" },
  { key: "harassment", label: "Harassment" },
  { key: "misleading", label: "Misleading information" },
  { key: "safety", label: "Safety concern" },
  { key: "other", label: "Something else" },
] as const;

export const SAFETY_DEFAULTS = {
  preciseLiveLocationPublic: false,
  homeAddressPublic: false,
  placeVisitSharing: "opt_in",
  discoverableProfile: "opt_in",
  blockedUsersHidden: true,
  reportsSupported: true,
} as const;
