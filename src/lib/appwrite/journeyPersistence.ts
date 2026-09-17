import { AppwriteException, ID, Permission, Role, type Models } from "appwrite";
import type { DnaScores } from "../../data/dna";
import type { Journey } from "../../data/journeys";
import { EMPTY_JOURNEY_DATES, deriveRole, deriveStage, type JourneyDates } from "../journey/dates";
import { APPWRITE_DATABASE_ID, tablesDB } from "./client";
import { appError } from "./errors";
import { personalizeJourney } from "../journey/personalize";

const PROFILE_TABLE = "student_profiles";
const DNA_TABLE = "my_dna_profiles";
const JOURNEY_TABLE = "journeys";

type StoredProfile = Models.Row & { display_name?: string; home_country_code: Journey["home"]; host_country_code: Journey["host"]; host_city?: string; university_id?: string; languages?: string; interests?: string; goals?: string; concerns?: string; journey_dates?: string; journey_role?: string; exchange_stage?: string };
type StoredDna = Models.Row & { assessment_version?: string; explicitness: number; formality: number; hierarchy_sensitivity: number; conflict_openness: number; relationship_orientation: number; time_structure: number; participation_confidence: number; uncertainty_tolerance: number };

function ready() {
  return Boolean(APPWRITE_DATABASE_ID);
}

function permissions(userId: string) {
  return [Permission.read(Role.user(userId)), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))];
}

function text(value: unknown): string {
  return JSON.stringify(value ?? []);
}

/**
 * Read the stored timeline back, tolerating every shape an older row can have.
 *
 * Rows written before this column existed have no `journey_dates` at all, and a
 * half-written row could hold anything. Returning `null` on an unreadable value
 * is deliberate: the caller then keeps the fallback journey's dates rather than
 * being handed a timeline with `undefined` in it, which would silently derive
 * `before_departure` for a student who landed three months ago.
 */
function readDates(raw: unknown): JourneyDates | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<JourneyDates>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      departureDate: parsed.departureDate ?? null,
      arrivalDate: parsed.arrivalDate ?? null,
      programStartDate: parsed.programStartDate ?? null,
      programEndDate: parsed.programEndDate ?? null,
      returnDate: parsed.returnDate ?? null,
    };
  } catch {
    return null;
  }
}

/** A `YYYY-MM-DD` day as the ISO instant Appwrite's datetime column expects. */
function asInstant(day: string | null): string | null {
  return day ? `${day}T00:00:00.000Z` : null;
}

/**
 * Deterministic upsert for owner-scoped rows.
 *
 * `TablesDB.upsertRow` was returning 409 "row already exists" for rows it had
 * just created when several writes ran concurrently (React StrictMode double
 * invocation), which silently dropped journey/MyDNA persistence on the first
 * onboarding save. An explicit read → update / create sequence is idempotent
 * and reports the real failure instead of masking it.
 */
async function upsertRow(tableId: string, rowId: string, data: Record<string, unknown>, userId: string): Promise<void> {
  const create = () =>
    tablesDB.createRow({ databaseId: APPWRITE_DATABASE_ID!, tableId, rowId, data, permissions: permissions(userId) });

  try {
    await tablesDB.getRow({ databaseId: APPWRITE_DATABASE_ID!, tableId, rowId });
  } catch (error) {
    if (error instanceof AppwriteException && error.code === 404) {
      try {
        await create();
      } catch (createError) {
        // A concurrent writer won the race — update the row it created.
        if (createError instanceof AppwriteException && createError.code === 409) {
          await tablesDB.updateRow({ databaseId: APPWRITE_DATABASE_ID!, tableId, rowId, data });
          return;
        }
        throw createError;
      }
      return;
    }
    throw error;
  }
  await tablesDB.updateRow({ databaseId: APPWRITE_DATABASE_ID!, tableId, rowId, data });
}

export async function saveJourney(userId: string, journey: Journey): Promise<boolean> {
  if (!ready()) return false;
  const now = new Date().toISOString();
  const dates = journey.dates ?? EMPTY_JOURNEY_DATES;
  /**
   * Stage and role are DERIVED, then stored.
   *
   * Deriving at write time is what stops the profile from claiming
   * `exchange_stage: "studying"` for a student who has not left home yet — the
   * previous hardcoded value, which was wrong for every student whose dates said
   * otherwise. It is recomputed on read as well, so a row written weeks ago does
   * not keep an outdated stage.
   */
  const stage = deriveStage(dates);
  const role = deriveRole(dates);
  const profile = {
    user_id: userId,
    display_name: journey.name,
    home_country_code: journey.home,
    host_country_code: journey.host,
    host_city: journey.city,
    university_id: journey.university,
    languages: text(journey.languages),
    interests: text(journey.interests),
    goals: "[]",
    concerns: text(journey.concerns),
    // The canonical timeline, and the two existing datetime columns filled from
    // it so nothing that already reads them is left behind.
    journey_dates: text(dates),
    exchange_start: asInstant(dates.arrivalDate),
    exchange_end: asInstant(dates.returnDate),
    exchange_stage: stage,
    journey_role: role,
    created_at: now,
    updated_at: now,
  };
  const dna = {
    user_id: userId,
    explicitness: journey.myDna.directness,
    formality: journey.myDna.formality,
    hierarchy_sensitivity: journey.myDna.hierarchy,
    conflict_openness: journey.myDna.conflict,
    relationship_orientation: journey.myDna.relationship,
    time_structure: journey.myDna.time,
    participation_confidence: journey.myDna.participation,
    uncertainty_tolerance: journey.myDna.uncertainty,
    assessment_version: journey.myDnaAssessed === false ? "unassessed" : "v1",
    updated_at: now,
  };
  const current = {
    journey_id: userId,
    user_id: userId,
    home_country_code: journey.home,
    host_country_code: journey.host,
    city: journey.city,
    university_id: journey.university,
    status: "active",
    is_current: 1,
    // The `journeys` table already carries start_date/end_date; fill them from
    // the canonical timeline so the two records cannot disagree.
    start_date: asInstant(dates.arrivalDate),
    end_date: asInstant(dates.returnDate),
    updated_at: now,
  };
  try {
    await Promise.all([
      upsertRow(PROFILE_TABLE, userId, profile, userId),
      upsertRow(DNA_TABLE, userId, dna, userId),
      upsertRow(JOURNEY_TABLE, userId, current, userId),
    ]);
    return true;
  } catch (error) {
    console.error("[yapyep] saveJourney failed", error);
    return false;
  }
}

export async function loadJourney(userId: string, fallback: Journey): Promise<Journey | null> {
  if (!ready()) return null;
  try {
    const [profile, dna] = await Promise.all([
      tablesDB.getRow<StoredProfile>({ databaseId: APPWRITE_DATABASE_ID!, tableId: PROFILE_TABLE, rowId: userId }),
      tablesDB.getRow<StoredDna>({ databaseId: APPWRITE_DATABASE_ID!, tableId: DNA_TABLE, rowId: userId }),
    ]);
    const myDna: DnaScores = { directness: dna.explicitness, formality: dna.formality, hierarchy: dna.hierarchy_sensitivity, conflict: dna.conflict_openness, relationship: dna.relationship_orientation, time: dna.time_structure, participation: dna.participation_confidence, uncertainty: dna.uncertainty_tolerance };
    /*
     * The timeline comes from storage when it is readable, and from the fallback
     * journey when it is not. Stage is re-derived here rather than trusted from
     * the row: a profile saved in August would otherwise still say "before
     * departure" in October, and Today would phase the journey wrongly.
     */
    const storedDates = readDates(profile.journey_dates);
    const dates = storedDates ?? EMPTY_JOURNEY_DATES;
    return {
      ...fallback,
      ...personalizeJourney(profile.home_country_code, profile.host_country_code, myDna, dates),
      id: "custom",
      name: profile.display_name || fallback.name,
      home: profile.home_country_code,
      host: profile.host_country_code,
      city: profile.host_city ?? "",
      university: profile.university_id ?? "",
      languages: JSON.parse(profile.languages || "[]"),
      interests: JSON.parse(profile.interests || "[]"),
      concerns: JSON.parse(profile.concerns || "[]"),
      dates,
      myDna,
      myDnaAssessed: !(String(dna.assessment_version ?? "v1").includes("unassessed")),
    };
  } catch (error) {
    /*
     * Missing rows fall back to seed data; other failures still surface in the
     * console. A brand-new guest has no saved journey yet, so a 404 here is the
     * normal first-run path — logging it as an error made every fresh session look
     * broken and buried the failures that do matter.
     */
    if (appError(error) !== "not_found") console.error("[yapyep] loadJourney failed", error);
    return null;
  }
}
