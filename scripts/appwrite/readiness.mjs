/**
 * Appwrite project readiness probe (read-only).
 *
 * Reports the live state of buckets, TablesDB tables and users so phase gates
 * can assert remote reality instead of trusting status documents.
 *
 * Usage: pnpm verify:appwrite:readiness
 */
import { Client, Storage, TablesDB, Users } from "node-appwrite";

const required = ["VITE_APPWRITE_ENDPOINT", "VITE_APPWRITE_PROJECT_ID", "VITE_APPWRITE_DATABASE_ID", "APPWRITE_API_KEY"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required. Run with --env-file=.env.local`);
}

const client = new Client()
  .setEndpoint(process.env.VITE_APPWRITE_ENDPOINT)
  .setProject(process.env.VITE_APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

const storage = new Storage(client);
const tables = new TablesDB(client);
const users = new Users(client);

const out = { projectId: process.env.VITE_APPWRITE_PROJECT_ID, databaseId: process.env.VITE_APPWRITE_DATABASE_ID };

try {
  const list = await storage.listBuckets();
  out.buckets = list.buckets.map((b) => ({
    id: b.$id,
    name: b.name,
    fileSecurity: b.fileSecurity,
    maxFileSizeBytes: b.maximumFileSize,
    allowedExtensions: b.allowedFileExtensions,
    permissions: b.$permissions,
  }));
} catch (error) {
  out.bucketsError = `${error.code ?? "?"} ${error.message}`;
}

try {
  const list = await tables.listTables({ databaseId: process.env.VITE_APPWRITE_DATABASE_ID });
  out.tableCount = list.total;
  out.tables = list.tables.map((t) => t.$id);
} catch (error) {
  out.tablesError = `${error.code ?? "?"} ${error.message}`;
}

try {
  const list = await users.list([]);
  out.userCount = list.total;
  out.recentUsers = list.users.slice(0, 5).map((u) => ({
    id: u.$id,
    anonymous: !u.email,
    email: u.email || null,
    labels: u.labels,
    created: u.$createdAt,
  }));
} catch (error) {
  out.usersError = `${error.code ?? "?"} ${error.message}`;
}

console.log(JSON.stringify(out, null, 2));
