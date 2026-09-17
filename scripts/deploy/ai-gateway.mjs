/**
 * Deploy the ai-gateway function to Appwrite.
 *
 * WHY THIS EXISTS
 *
 * The deployed `ai-gateway` was pre-Phase-3 code: it answered 503 "YapLens is
 * temporarily unavailable" to EVERY route, including `/health`, and it carried no
 * environment variables at all. So the browser could never reach a real model —
 * "Ask this Greenbook" fell back to no-LLM in the UI even though the route was
 * implemented and verified locally. A route that exists in a checkout and not in
 * the running product is not a feature.
 *
 * It also fixes the configuration the function needs to work at all:
 *   - provider credentials, read from .env.local (never from the repository)
 *   - a timeout long enough for a real inference (the default was 30s, below the
 *     text chain's own 60s deadline, so a slow-but-successful call would have been
 *     killed by the platform before the chain could fall back)
 *   - an install command that works without a committed lock file
 *
 * Usage:
 *   node scripts/deploy/ai-gateway.mjs --dry-run
 *   node scripts/deploy/ai-gateway.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { Client, Functions } from "node-appwrite";

const FUNCTION_ID = "ai-gateway";
const ROOT = "functions/ai-gateway";
const dryRun = process.argv.includes("--dry-run");

/** Server-side secrets the function needs. Client-visible values are not pushed. */
const SECRET_KEYS = [
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "OPENROUTER_API_KEY",
  "CAVOTI_API_KEY",
  "EXPLABS_API_KEY",
];
/** Non-secret configuration, still server-side. */
const CONFIG_KEYS = ["CAVOTI_BASE_URL", "EXPLABS_BASE_URL", "VYCE_BASE_URL"];

function loadEnv() {
  if (!existsSync(".env.local")) throw new Error(".env.local is required");
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

/** Every file under the function directory, so the package is complete. */
function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...collectFiles(path));
    else files.push(relative(ROOT, path));
  }
  return files;
}

loadEnv();

const client = new Client()
  .setEndpoint(process.env.VITE_APPWRITE_ENDPOINT)
  .setProject(process.env.VITE_APPWRITE_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);
const functions = new Functions(client);

const files = collectFiles(ROOT);
console.log(`function files (${files.length}):`);
for (const file of files) console.log(`  ${file}`);

const missing = [...SECRET_KEYS, ...CONFIG_KEYS].filter((key) => !process.env[key]);
if (missing.length) console.log(`\nnot set locally, will be skipped: ${missing.join(", ")}`);

if (dryRun) {
  console.log("\ndry run — nothing written");
  process.exit(0);
}

/* ------------------------------ configuration ------------------------------ */

const existing = await functions.get({ functionId: FUNCTION_ID });
console.log(`\ncurrent: timeout=${existing.timeout}s install="${existing.commands}"`);
console.log(`current execute permissions: ${JSON.stringify(existing.execute ?? [])}`);

/*
 * The function must be executable by the people who actually use it.
 *
 * A freshly created function carries NO execute permission (`execute: []`), and
 * Appwrite then rejects every client call with
 *   401 user_unauthorized — "No permissions provided for action 'execute'"
 * even though the deployment is ready and an API key works fine. The failure is
 * invisible from the dashboard-side deploy and only shows up as the browser
 * silently degrading to the no-LLM answer, so it is asserted here.
 *
 * The value comes from a fixed list and must be the BARE role string (`any`,
 * `guests`, `users`) — not `execute("users")`, which is the `permission("role")`
 * form used for storage/database resources and is rejected here. There is no
 * `Permission.execute` helper either, so it is written as a literal.
 *
 * It must be `any`. This Appwrite version will not accept the principal a
 * first-time visitor actually is:
 *
 *   execute: ["guests"] → "Missing execute permission for role guests. Only
 *                          [any, users, user:<id>, …] scopes are allowed"
 *   execute: ["users"]  → "Missing execute permission for role users. Only
 *                          [any, guests] scopes are allowed"
 *
 * because `ensureAnonymousSession()` creates a *user* (an anonymous session has
 * a real `$id`), while `guests` means "no session at all", and a session created
 * moments ago is not yet recognised as the `users` scope either. Only `any`
 * covers the anonymous first-time visitor across all of that — and that visitor
 * is the demo persona, so anything narrower means "Ask this Greenbook" silently
 * degrades to the no-LLM answer for exactly the person the demo is built around.
 *
 * Narrowing this is safe to revisit only if the check is re-run against a
 * freshly created anonymous session, not just an existing one.
 */
const DESIRED_EXECUTE = ["any"];
const currentExecute = existing.execute ?? [];
const executeMatches =
  currentExecute.length === DESIRED_EXECUTE.length && DESIRED_EXECUTE.every((role) => currentExecute.includes(role));

if (!executeMatches) {
  await functions.update({
    functionId: FUNCTION_ID,
    name: existing.name,
    execute: DESIRED_EXECUTE,
  });
  console.log(`updated execute permissions → ${JSON.stringify(DESIRED_EXECUTE)}`);
} else {
  console.log("execute permissions already correct");
}

// The text chain's own deadline is 60s, so a 30s platform timeout would kill a
// slow-but-successful call before failover could happen.
const DESIRED_TIMEOUT = 120;
const DESIRED_COMMAND = "npm install --omit=dev";

if (existing.timeout !== DESIRED_TIMEOUT || existing.commands !== DESIRED_COMMAND) {
  await functions.update({ functionId: FUNCTION_ID, name: existing.name, timeout: DESIRED_TIMEOUT, commands: DESIRED_COMMAND });
  console.log(`updated: timeout=${DESIRED_TIMEOUT}s install="${DESIRED_COMMAND}"`);
} else {
  console.log("configuration already correct");
}

/*
 * Variables are addressed by an ID that is NOT the key.
 *
 * The project convention is `env_<lowercased key>`, and `functions.get()` does
 * not return the variable list at all (`fn.variables` is undefined), so reading
 * it from there reported "0 variables" while the keys plainly existed — which
 * made the script try to create duplicates and then fail to update them.
 * `listVariables()` is the only reliable source for the id/key mapping.
 */
const variableList = await functions.listVariables({ functionId: FUNCTION_ID });
const byKey = new Map(variableList.variables.map((variable) => [variable.key, variable]));
console.log(`existing variables: ${variableList.total} (${[...byKey.keys()].join(", ")})`);

const variableIdFor = (key) => byKey.get(key)?.$id ?? `env_${key.toLowerCase()}`;

for (const key of [...SECRET_KEYS, ...CONFIG_KEYS]) {
  const value = process.env[key];
  if (!value) continue;
  const existingVariable = byKey.get(key);
  if (existingVariable) {
    await functions.updateVariable({ functionId: FUNCTION_ID, variableId: existingVariable.$id, key, value });
    console.log(`  var updated: ${key} (${existingVariable.$id})`);
  } else {
    await functions.createVariable({ functionId: FUNCTION_ID, variableId: variableIdFor(key), key, value });
    console.log(`  var created: ${key} (${variableIdFor(key)})`);
  }
}

/* --------------------------------- deploy ---------------------------------- */

const archive = ".tmp-probe/ai-gateway.tar.gz";
execFileSync("tar", ["-czf", archive, "-C", ROOT, "."], { stdio: "inherit" });
console.log(`\npackaged ${archive}`);

const { InputFile } = await import("node-appwrite/file");
const deployment = await functions.createDeployment({
  functionId: FUNCTION_ID,
  entrypoint: "src/main.js",
  code: InputFile.fromPath(archive, "ai-gateway.tar.gz"),
  activate: false,
});
console.log(`deployment ${deployment.$id} created — waiting for the build`);

for (let attempt = 0; attempt < 60; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const current = await functions.getDeployment({ functionId: FUNCTION_ID, deploymentId: deployment.$id });
  if (current.status === "ready") {
    console.log(`  build ready after ${(attempt + 1) * 5}s`);
    break;
  }
  if (current.status === "failed") throw new Error(`deployment build failed: ${current.buildLog?.slice(-800) ?? "(no log)"}`);
  if (attempt % 6 === 5) console.log(`  still ${current.status} (${(attempt + 1) * 5}s)`);
  if (attempt === 59) throw new Error(`deployment did not become ready; last status ${current.status}`);
}

/*
 * Activation is `updateFunctionDeployment`, not `updateDeployment` — the latter
 * does not exist on the SDK's Functions service, so the first successful build
 * completed and then threw on activation, leaving the old code live. The build
 * log said "ready" while the function still answered 503.
 */
await functions.updateFunctionDeployment({ functionId: FUNCTION_ID, deploymentId: deployment.$id });
console.log(`activated deployment ${deployment.$id}`);

// Appwrite Cloud can restore the function snapshot's old runtime settings when
// a deployment is activated. Apply the complete runtime contract afterwards in
// one update so setting timeout cannot clear execute permissions (or vice versa).
await functions.update({
  functionId: FUNCTION_ID,
  name: existing.name,
  execute: DESIRED_EXECUTE,
  timeout: DESIRED_TIMEOUT,
  commands: DESIRED_COMMAND,
});
const active = await functions.get({ functionId: FUNCTION_ID });
if (active.timeout !== DESIRED_TIMEOUT || !DESIRED_EXECUTE.every((role) => active.execute?.includes(role))) {
  throw new Error(`active function configuration drifted: timeout=${active.timeout}, execute=${JSON.stringify(active.execute ?? [])}`);
}
console.log(`verified active configuration: timeout=${active.timeout}s execute=${JSON.stringify(active.execute)}`);
