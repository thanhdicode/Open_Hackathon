/**
 * Node resolve hook so the contract parity test can import the client
 * TypeScript contracts directly. Node strips the types; it just cannot resolve
 * the extensionless relative specifiers the bundler normally handles.
 */
import { existsSync } from "node:fs";
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
