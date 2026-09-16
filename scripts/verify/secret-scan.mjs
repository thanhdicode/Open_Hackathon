/**
 * Secret scan.
 *
 * Checks that no server-side credential value appears in any tracked file or in
 * the built bundle. Values that are public by design are excluded, because
 * reporting them as leaks trains people to ignore the scan:
 *   - `VITE_*` values are compiled into the client bundle intentionally
 *   - `*_BASE_URL`, `*_ENDPOINT`, `*_URL` are endpoints, not credentials
 *
 * The scan reads values from `.env.local` and never prints them.
 *
 * Usage: node scripts/verify/secret-scan.mjs
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PUBLIC_BY_DESIGN = /(_BASE_URL|_ENDPOINT|_URL)$/;
const MIN_SECRET_LENGTH = 20;

let envText;
try {
  envText = readFileSync(".env.local", "utf8");
} catch {
  console.error(".env.local not found — nothing to scan against.");
  process.exit(1);
}

const candidates = envText
  .split(/\r?\n/)
  .filter((line) => line && !line.startsWith("#") && line.includes("="))
  .map((line) => ({
    key: line.slice(0, line.indexOf("=")).trim(),
    value: line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, ""),
  }))
  .filter((entry) => entry.value.length >= MIN_SECRET_LENGTH);

const secrets = candidates.filter((entry) => !entry.key.startsWith("VITE_") && !PUBLIC_BY_DESIGN.test(entry.key));
const publicValues = candidates.filter((entry) => entry.key.startsWith("VITE_") || PUBLIC_BY_DESIGN.test(entry.key));

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .concat(execSync("find dist -type f", { encoding: "utf8" }).split("\n").filter(Boolean));

const hits = {};
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const entry of secrets) {
    if (text.includes(entry.value)) (hits[entry.key] ??= []).push(file);
  }
}

// A server credential must never reach the client bundle at all.
const bundleFiles = files.filter((file) => file.startsWith("dist/"));
const bundleLeaks = [];
for (const file of bundleFiles) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const entry of secrets) {
    if (text.includes(entry.value)) bundleLeaks.push(`${entry.key} in ${file}`);
  }
}

console.log(`scanned ${files.length} files (${bundleFiles.length} in dist/)`);
console.log(`  secret values checked : ${secrets.length} (${secrets.map((entry) => entry.key).join(", ")})`);
console.log(`  public by design      : ${publicValues.length} (${publicValues.map((entry) => entry.key).join(", ")})`);

for (const [key, where] of Object.entries(hits)) console.log(`  LEAK  ${key} in ${[...new Set(where)].join(", ")}`);
console.log(`  bundle check          : ${bundleLeaks.length ? bundleLeaks.join("; ") : "no secret in dist/"}`);

const failed = Object.keys(hits).length > 0 || bundleLeaks.length > 0;
console.log(failed ? "\nFAIL — a server-side secret reached a committed or built file" : "\nPASS — no server-side secret in any tracked file or dist/");
if (failed) process.exitCode = 1;
