/**
 * Phase 5 — Connect + Explore contracts.
 *
 * These types are the boundary between Appwrite rows (snake_case, strings for
 * numbers, JSON columns as strings) and the UI (camelCase, real types). The
 * mapping happens once, here, so no screen has to know that `is_demo_seed` is an
 * integer or that `tags` arrives as a JSON string.
 */

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
 * Feed filters. The first three are scopes, the next four are post types, and
 * `saved` is the viewer's own list. Keeping them in one union means the filter
 * bar cannot drift away from what the query builder supports.
 */
export const FEED_FILTERS = [
  { key: "for_you", label: "For You" },
  { key: "host_country", label: "Host Country" },
  { key: "my_university", label: "My University" },
  { key: "tips", label: "Tips" },
  { key: "places", label: "Places" },
  { key: "questions", label: "Questions" },
  { key: "moments", label: "Moments" },
  { key: "saved", label: "Saved" },
] as const;

export type FeedFilter = (typeof FEED_FILTERS)[number]["key"];

/** Which post types each filter admits. `null` means "no type restriction". */
export const FILTER_TYPES: Record<FeedFilter, PostType[] | null> = {
  for_you: null,
  host_country: null,
  my_university: null,
  tips: ["tip", "guide"],
  places: ["place"],
  questions: ["question"],
  moments: ["moment"],
  saved: null,
};

export interface PostMedia {
  id: string;
  kind: "image";
  /** Local `/demo-media/...` path for seeded assets, or an Appwrite file URL. */
  url: string;
  alt: string;
  attribution?: string;
  license?: string;
}

export interface AuthorSummary {
  id: string;
  displayName: string;
  initials: string;
  color: string;
  homeCountry?: string;
  hostCountry?: string;
  universityId?: string;
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
