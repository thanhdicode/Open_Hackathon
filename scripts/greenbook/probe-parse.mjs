/**
 * Diagnose why a source parsed to little or no text.
 *
 * Written after this happened twice: `sg-ica-student` yielded 0 characters from
 * 29,845 bytes and `my-emgs` 12 characters from 170,721 bytes, and in both cases
 * the pipeline reported "too little text" as though the *source* were the
 * problem. It was the parser. Guessing at that from a summary line wastes a
 * fetch and an AI call per attempt.
 *
 * Reports which container was chosen and how big it was, so a bad pick is
 * visible immediately rather than inferred from a character count.
 *
 * Usage:
 *   node scripts/greenbook/probe-parse.mjs                       # every snapshot
 *   node scripts/greenbook/probe-parse.mjs my-emgs               # one source
 *   node scripts/greenbook/probe-parse.mjs --text my-emgs        # show the text
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { contentContainer, htmlToText, regionToText, stripBoilerplate } from "./fetch.mjs";

const ROOT = ".greenbook-snapshots";
const MIN_TEXT = 400;

/** Every archived .html snapshot, as `{ sourceId, path }`. */
function snapshots() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".html")) found.push({ sourceId: path.split(/[\\/]/).slice(-2, -1)[0], path });
    }
  };
  walk(ROOT);
  return found;
}

/** Which branch of contentContainer() matched, and how much it captured. */
function diagnose(html) {
  const hasMain = /<main\b/i.test(html);
  const hasArticle = /<article\b/i.test(html);
  const container = contentContainer(html);
  const chosen = container === html ? "whole document (fallback)" : `${container.length}B region`;
  return { hasMain, hasArticle, chosen, containerBytes: container.length, htmlBytes: html.length };
}

const argv = process.argv.slice(2);
const showText = argv.includes("--text");
const filter = argv.find((arg) => !arg.startsWith("--"));

const targets = snapshots().filter((entry) => !filter || entry.sourceId.includes(filter));
if (!targets.length) {
  console.log("no snapshots matched" + (filter ? ` "${filter}"` : ""));
  process.exitCode = 1;
}

for (const { sourceId, path } of targets.sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
  const html = readFileSync(path, "utf8");
  const info = diagnose(html);
  const text = stripBoilerplate(htmlToText(html));
  // What the whole document would yield, to judge whether the pick helped.
  const whole = stripBoilerplate(regionToText(html));
  const share = ((info.containerBytes / info.htmlBytes) * 100).toFixed(1);
  const verdict = text.length >= MIN_TEXT ? "OK  " : "LOW ";
  const ratio = whole.length ? (text.length / whole.length) : 1;
  console.log(
    `${verdict} ${sourceId.padEnd(26)} html=${String(info.htmlBytes).padStart(7)}B  picked=${String(text.length).padStart(6)}  whole=${String(whole.length).padStart(6)}  kept=${(ratio * 100).toFixed(0).padStart(3)}% of doc text  main=${info.hasMain ? "y" : "n"} art=${info.hasArticle ? "y" : "n"}`,
  );
  if (showText) {
    console.log("  " + "-".repeat(70));
    console.log(text.slice(0, 700).split("\n").map((line) => "  " + line).join("\n"));
    console.log("");
  }
}
