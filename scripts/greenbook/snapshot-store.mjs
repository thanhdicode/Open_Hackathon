/**
 * Snapshot store.
 *
 * Raw fetched pages are blobs, not records: a government page is 100-500 KB of
 * HTML and a PDF can be megabytes. They are archived so facts can be re-extracted
 * when the extractor improves, and diffed when a source changes — neither of
 * which needs a queryable row.
 *
 * The store is pluggable so the pipeline never learns which backend it uses:
 *
 *   local      writes under .greenbook-snapshots/ — works with no credentials
 *   appwrite   Appwrite Storage, reusing the project's existing permission model
 *
 * Appwrite is the default when credentials exist, because the project already
 * uses Appwrite Storage for media and adding a second object store would mean a
 * second credential and a second permission model for no benefit at this corpus
 * size (41 sources ≈ tens of MB).
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCAL_ROOT = process.env.GREENBOOK_SNAPSHOT_DIR || ".greenbook-snapshots";

/** Deterministic object key. Date-versioned so history is preserved. */
export function snapshotKey({ country, category, sourceId, date, extension }) {
  const day = (date ?? new Date().toISOString()).slice(0, 10);
  const safeCategory = (category ?? "misc").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  return `${country.toLowerCase()}/${safeCategory}/${sourceId}/${day}.${extension}`;
}

function extensionFor(contentType, url) {
  const type = String(contentType ?? "").toLowerCase();
  if (type.includes("pdf")) return "pdf";
  if (type.includes("json")) return "json";
  if (type.includes("csv")) return "csv";
  if (type.includes("html")) return "html";
  const fromUrl = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(url ?? "");
  return fromUrl ? fromUrl[1].toLowerCase() : "bin";
}

/* -------------------------------------------------------------------------- */
/* Local store                                                                */
/* -------------------------------------------------------------------------- */

export function createLocalStore(root = LOCAL_ROOT) {
  return {
    kind: "local",
    async put(key, body) {
      const target = join(root, key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      return { key, bytes: body.length ?? body.byteLength ?? 0, location: target };
    },
    async get(key) {
      return readFile(join(root, key));
    },
    async has(key) {
      try {
        await stat(join(root, key));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Appwrite Storage store                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Uses the Appwrite Storage REST API directly so the pipeline does not depend on
 * the browser SDK. Only used when the credentials are present.
 */
export function createAppwriteStore({ endpoint, projectId, apiKey, bucketId }) {
  const base = `${String(endpoint).replace(/\/$/, "")}/storage/buckets/${bucketId}/files`;

  return {
    kind: "appwrite",
    bucketId,
    async put(key, body) {
      const form = new FormData();
      // Appwrite derives the file id from the form field; a deterministic id
      // makes ingestion idempotent — the same snapshot is never stored twice.
      const fileId = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 36);
      form.append("fileId", fileId);
      form.append("file", new Blob([body]), key.split("/").pop());
      const response = await fetch(base, {
        method: "POST",
        headers: { "X-Appwrite-Project": projectId, "X-Appwrite-Key": apiKey },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        // 409 means this exact snapshot already exists: idempotent, not an error.
        if (response.status === 409) return { key, fileId, bytes: 0, duplicate: true };
        throw new Error(`appwrite storage:${response.status} ${payload.message ?? ""}`.trim());
      }
      return { key, fileId: payload.$id, bytes: payload.sizeOriginal ?? 0, location: `${bucketId}/${payload.$id}` };
    },
    async get(fileId) {
      const response = await fetch(`${base}/${fileId}/download`, {
        headers: { "X-Appwrite-Project": projectId, "X-Appwrite-Key": apiKey },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`appwrite storage download:${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    async has() {
      // Appwrite has no cheap existence probe; put() handles the conflict.
      return false;
    },
  };
}

/** Pick a store from the environment. Local is the safe default. */
export function createStore() {
  const endpoint = process.env.VITE_APPWRITE_ENDPOINT;
  const projectId = process.env.VITE_APPWRITE_PROJECT_ID;
  const apiKey = process.env.APPWRITE_API_KEY;
  const bucketId = process.env.GREENBOOK_SNAPSHOT_BUCKET_ID || process.env.VITE_APPWRITE_TEMP_MEDIA_BUCKET_ID;

  if (process.env.GREENBOOK_SNAPSHOT_STORE === "local") return createLocalStore();
  if (endpoint && projectId && apiKey && bucketId) return createAppwriteStore({ endpoint, projectId, apiKey, bucketId });
  return createLocalStore();
}

export { extensionFor };
