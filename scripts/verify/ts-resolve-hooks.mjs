/**
 * Node resolve hook so the contract parity test can import the client
 * TypeScript contracts directly. Node strips the types; it just cannot resolve
 * the extensionless relative specifiers the bundler normally handles.
 *
 * The `load` hook covers a second mismatch. Vite lets a module write
 * `import config from "./x.json"`, but Node's ESM loader requires the
 * `with { type: "json" }` attribute and fails the whole import graph without it.
 * That made every module transitively importing `config/phase5-campuses.json`
 * — which is most of Phase 5 — untestable under `node --test`. Serving the JSON
 * here keeps the application source bundler-idiomatic rather than contorting it
 * to suit the test runner.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/i.test(specifier)) {
    try {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(`${specifier}.ts`, context);
    } catch {
      /* fall through to the default resolver */
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    return {
      format: "json",
      shortCircuit: true,
      source: readFileSync(fileURLToPath(url), "utf8"),
    };
  }
  return nextLoad(url, context);
}
