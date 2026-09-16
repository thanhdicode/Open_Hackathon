import { Client, Storage, TablesDB } from "node-appwrite";
import { ALL_BUCKETS, GREENBOOK_TABLES, P0_TABLES, PHASE5_TABLES, TEMP_MEDIA_POLICY, tablePermissions } from "./schema.mjs";

const endpoint = process.env.VITE_APPWRITE_ENDPOINT;
const projectId = process.env.VITE_APPWRITE_PROJECT_ID;
const databaseId = process.env.VITE_APPWRITE_DATABASE_ID;
const bucketId = process.env.VITE_APPWRITE_TEMP_MEDIA_BUCKET_ID;
const apiKey = process.env.APPWRITE_API_KEY;
const verifyOnly = process.argv.includes("--verify");

for (const [name, value] of Object.entries({ endpoint, projectId, databaseId, bucketId, apiKey })) {
  if (!value) throw new Error(`${name} is required. Load a local secret environment before running this command.`);
}

const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const tables = new TablesDB(client);
const storage = new Storage(client);

async function getExistingTable(tableId) {
  try {
    return await tables.getTable({ databaseId, tableId });
  } catch (error) {
    if (error?.code === 404) return null;
    throw error;
  }
}

function columnDrift(expected, existing) {  const actual = new Map(existing.columns.map((column) => [column.key, column]));
  return expected.columns
    .map((column) => {
      const found = actual.get(column.key);
      if (!found) return `missing column ${column.key}`;
      return found.type === column.type ? null : `column ${column.key} type is ${found.type}, expected ${column.type}`;
    })
    .filter(Boolean);
}

/** Column creators used by the additive migration path. */
const COLUMN_CREATORS = {
  string: "createStringColumn",
  text: "createTextColumn",
  integer: "createIntegerColumn",
  datetime: "createDatetimeColumn",
};

async function ensureTable(definition) {
  const existing = await getExistingTable(definition.id);
  if (!existing) {
    if (verifyOnly) throw new Error(`Missing table: ${definition.id}`);
    await tables.createTable({
      databaseId,
      tableId: definition.id,
      name: definition.name,
      permissions: tablePermissions(definition),
      rowSecurity: definition.rowSecurity,
      columns: definition.columns,
      indexes: definition.indexes,
    });
    return "created";
  }

  const drift = columnDrift(definition, existing);
  if (drift.length) {
    if (verifyOnly) throw new Error(`${definition.id}: ${drift.join("; ")}`);
    // Additive migration: create only the columns that are missing. Type
    // mismatches still fail loudly because they need a deliberate migration.
    const missing = drift.filter((entry) => entry.startsWith("missing column "));
    if (missing.length !== drift.length) {
      throw new Error(`${definition.id}: ${drift.filter((e) => !e.startsWith("missing column ")).join("; ")}`);
    }
    const added = [];
    for (const entry of missing) {
      const key = entry.replace("missing column ", "");
      const column = definition.columns.find((c) => c.key === key);
      const creator = COLUMN_CREATORS[column.type];
      if (!creator) throw new Error(`${definition.id}.${key}: unsupported column type ${column.type}`);
      await tables[creator]({
        databaseId,
        tableId: definition.id,
        key: column.key,
        required: column.required,
        ...(column.type === "string" ? { size: column.size ?? 255 } : {}),
      });
      added.push(key);
    }
    return `added ${added.join(", ")}`;
  }
  return "verified";
}

async function ensureMediaBucket(definition) {
  const { id, name, fileSecurity, maximumFileSize, allowedFileExtensions, permissions, compression } = definition;
  let existing;
  try {
    existing = await storage.getBucket({ bucketId: id });
  } catch (error) {
    if (error?.code !== 404) throw error;
    if (verifyOnly) throw new Error(`Missing bucket: ${id}`);
    await storage.createBucket({ bucketId: id, name, permissions, fileSecurity, maximumFileSize, allowedFileExtensions, compression });
    return "created";
  }

  const drift = [];
  if (existing.fileSecurity !== fileSecurity) drift.push(`fileSecurity is ${existing.fileSecurity}, expected ${fileSecurity}`);
  if (existing.maximumFileSize !== maximumFileSize) drift.push(`max size is ${existing.maximumFileSize}, expected ${maximumFileSize}`);
  const currentExtensions = [...(existing.allowedFileExtensions ?? [])].sort().join(",");
  const wantedExtensions = [...allowedFileExtensions].sort().join(",");
  if (currentExtensions !== wantedExtensions) drift.push(`extensions are [${currentExtensions}], expected [${wantedExtensions}]`);
  if (drift.length) {
    if (verifyOnly) throw new Error(`${id}: ${drift.join("; ")}`);
    await storage.updateBucket({ bucketId: id, name, permissions, fileSecurity, maximumFileSize, allowedFileExtensions, compression });
    return "updated";
  }
  return "verified";
}

async function tightenTempMediaBucket(bucketId) {
  const { fileSecurity, maximumFileSize, allowedFileExtensions, compression } = TEMP_MEDIA_POLICY;
  const existing = await storage.getBucket({ bucketId });
  const drift = [];
  if (existing.fileSecurity !== fileSecurity) drift.push(`fileSecurity is ${existing.fileSecurity}, expected ${fileSecurity}`);
  if (existing.maximumFileSize !== maximumFileSize) drift.push(`max size is ${existing.maximumFileSize}, expected ${maximumFileSize}`);
  if (drift.length) {
    if (verifyOnly) throw new Error(`temp media bucket ${bucketId}: ${drift.join("; ")}`);
    await storage.updateBucket({ bucketId, name: existing.name, fileSecurity, maximumFileSize, allowedFileExtensions, compression });
    return "updated";
  }
  return "verified";
}

const bucketOutcomes = [];
for (const definition of ALL_BUCKETS) bucketOutcomes.push([definition.id, await ensureMediaBucket(definition)]);
bucketOutcomes.push([`${bucketId} (temp media)`, await tightenTempMediaBucket(bucketId)]);

await storage.getBucket({ bucketId });
const outcomes = await Promise.all([...P0_TABLES, ...GREENBOOK_TABLES, ...PHASE5_TABLES].map(async (definition) => [definition.id, await ensureTable(definition)]));
for (const [tableId, outcome] of outcomes) console.log(`${tableId}: ${outcome}`);
for (const [id, outcome] of bucketOutcomes) console.log(`bucket ${id}: ${outcome}`);
