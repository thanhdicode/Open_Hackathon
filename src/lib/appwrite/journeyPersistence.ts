import { ID, Permission, Role, type Models } from "appwrite";
import type { DnaScores } from "../../data/dna";
import type { Journey } from "../../data/journeys";
import { APPWRITE_DATABASE_ID, tablesDB } from "./client";

const PROFILE_TABLE = "student_profiles";
const DNA_TABLE = "my_dna_profiles";
const JOURNEY_TABLE = "journeys";

type StoredProfile = Models.Row & { display_name?: string; home_country_code: Journey["home"]; host_country_code: Journey["host"]; host_city?: string; university_id?: string; languages?: string; interests?: string; goals?: string; concerns?: string };
type StoredDna = Models.Row & { explicitness: number; formality: number; hierarchy_sensitivity: number; conflict_openness: number; relationship_orientation: number; time_structure: number; participation_confidence: number; uncertainty_tolerance: number };

function ready() {
  return Boolean(APPWRITE_DATABASE_ID);
}

function permissions(userId: string) {
  return [Permission.read(Role.user(userId)), Permission.update(Role.user(userId)), Permission.delete(Role.user(userId))];
}

function text(value: unknown): string {
  return JSON.stringify(value ?? []);
}

export async function saveJourney(userId: string, journey: Journey): Promise<boolean> {
  if (!ready()) return false;
  const now = new Date().toISOString();
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
    exchange_stage: "studying",
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
    assessment_version: "v1",
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
    updated_at: now,
  };
  try {
    await Promise.all([
      tablesDB.upsertRow({ databaseId: APPWRITE_DATABASE_ID!, tableId: PROFILE_TABLE, rowId: userId, data: profile, permissions: permissions(userId) }),
      tablesDB.upsertRow({ databaseId: APPWRITE_DATABASE_ID!, tableId: DNA_TABLE, rowId: userId, data: dna, permissions: permissions(userId) }),
      tablesDB.upsertRow({ databaseId: APPWRITE_DATABASE_ID!, tableId: JOURNEY_TABLE, rowId: userId, data: current, permissions: permissions(userId) }),
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
    return { ...fallback, id: "custom", name: profile.display_name || fallback.name, home: profile.home_country_code, host: profile.host_country_code, city: profile.host_city || fallback.city, university: profile.university_id || fallback.university, languages: JSON.parse(profile.languages || "[]"), interests: JSON.parse(profile.interests || "[]"), concerns: JSON.parse(profile.concerns || "[]"), myDna };
  } catch (error) {
    // Missing rows fall back to seed data; other failures still surface in the console.
    console.error("[yapyep] loadJourney failed", error);
    return null;
  }
}
