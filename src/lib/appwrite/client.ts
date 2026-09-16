import { Account, Client, Functions, Storage, TablesDB } from "appwrite";

const endpoint = import.meta.env.VITE_APPWRITE_ENDPOINT;
const projectId = import.meta.env.VITE_APPWRITE_PROJECT_ID;

export const APPWRITE_DATABASE_ID = import.meta.env.VITE_APPWRITE_DATABASE_ID as string | undefined;
export const APPWRITE_TEMP_MEDIA_BUCKET_ID = import.meta.env.VITE_APPWRITE_TEMP_MEDIA_BUCKET_ID as
  | string
  | undefined;
/** Dedicated bucket for opt-in social avatars (file-level security, images only). */
export const APPWRITE_PROFILE_MEDIA_BUCKET_ID = import.meta.env.VITE_APPWRITE_PROFILE_MEDIA_BUCKET_ID as
  | string
  | undefined;
/**
 * Bucket for student photos attached to community posts and place experiences.
 * Falls back to the declared bucket id so a checkout that has run the bootstrap
 * but not updated its `.env.local` still works — the bucket is created by
 * `scripts/appwrite/bootstrap.mjs`, so the id is known rather than guessed.
 */
export const APPWRITE_COMMUNITY_MEDIA_BUCKET_ID =
  (import.meta.env.VITE_APPWRITE_COMMUNITY_MEDIA_BUCKET_ID as string | undefined) || "community_media";

export const isAppwriteConfigured = Boolean(endpoint && projectId);

/**
 * The configured database id, or a thrown error naming the missing variable.
 *
 * Phase 5 modules call this once at module scope instead of asserting
 * `APPWRITE_DATABASE_ID!` at every call site. The assertion form turns an unset
 * variable into `undefined`, which Appwrite reports as a 404 on a table that
 * plainly exists — a misleading error for what is really a missing `.env.local`.
 */
export function requireDatabaseId(): string {
  if (!APPWRITE_DATABASE_ID) {
    throw new Error(
      "VITE_APPWRITE_DATABASE_ID is not set. Copy .env.example to .env.local and run scripts/appwrite/bootstrap.mjs.",
    );
  }
  return APPWRITE_DATABASE_ID;
}

const client = new Client();

if (endpoint && projectId) {
  client.setEndpoint(endpoint).setProject(projectId);
}

/**
 * Exported for Realtime subscriptions only.
 *
 * Realtime is an enhancement, never the source of truth: the feed is loaded by
 * HTTP query and a dropped socket changes nothing about what is on screen. Any
 * subscriber must unsubscribe on unmount, or a student who opens Connect ten
 * times ends up with ten live sockets.
 */
export { client };

export const account = new Account(client);
export const tablesDB = new TablesDB(client);
export const storage = new Storage(client);
export const functions = new Functions(client);
