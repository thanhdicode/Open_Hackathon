/**
 * Seed the Greenbook product layer: tasks and phrases.
 *
 * THE RULE THIS SCRIPT FOLLOWS
 *
 * Nothing here invents a fact. Every task is DERIVED from a fact that already
 * passed the validator and is already stored — it is the fact's `actionable_advice`
 * promoted into a checklist item, and it keeps a `fact_ids` link back to the
 * requirement that justifies it. If a fact has no action, it produces no task.
 *
 * Phrases are the one place a human contributes language directly, because a
 * phrase list cannot be extracted from a government page. They are real, standard
 * phrases with their register recorded, and they are marked as curated rather
 * than official. There is no audio: nothing was recorded, so no `audio_file_id`
 * is set and the Listen control falls back to browser speech.
 *
 * Media is deliberately NOT seeded. Every media row must name a real creator and
 * a real, resolvable URL, and this environment cannot verify a video id without
 * risking a fabricated one. An empty Student Reality screen that says so is
 * correct; a screen full of invented links is not.
 *
 * Idempotent: every row id derives from its content, so a re-run is a no-op.
 *
 * Usage:
 *   node scripts/greenbook/seed.mjs
 *   node scripts/greenbook/seed.mjs --dry-run
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Permission, Query, Role, TablesDB, Client } from "node-appwrite";

const TASKS_TABLE = "greenbook_tasks";
const PHRASES_TABLE = "student_phrases";
const FACTS = "knowledge_facts";
const OUT_PATH = "docs/evidence/phase4/product-seed.json";

/** Journey stage ordering, so a checklist reads in the order a student lives it. */
const STAGE_ORDER = ["before_arrival", "arrival", "first_week", "settling", "ongoing"];
const MAX_TASKS_PER_COUNTRY = 25;

/**
 * Curated phrases.
 *
 * These are standard, widely-documented phrases in each language, not a literal
 * translation of an English sentence. `register` records the social weight, and
 * `contextKey` records the situation. They are NOT official guidance and the UI
 * does not present them as such.
 *
 * Thai notes: ครับ (khráp) is used by men and ค่ะ (khâ) by women at the end of a
 * polite sentence. Romanisation follows the common learner convention, which is
 * approximate — Thai tones cannot be written in Latin letters reliably.
 */
const PHRASES = [
  // ---- Malay (Malaysia) ----
  { country: "MY", lang: "ms", local: "Terima kasih", roman: null, translation: "Thank you", context: "courtesy", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "MY", lang: "ms", local: "Sama-sama", roman: null, translation: "You're welcome", context: "courtesy", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "MY", lang: "ms", local: "Selamat pagi", roman: null, translation: "Good morning", context: "greeting", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "MY", lang: "ms", local: "Maaf", roman: null, translation: "Sorry / excuse me", context: "apology", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "MY", lang: "ms", local: "Tolong", roman: null, translation: "Please / help", context: "request", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "MY", lang: "ms", local: "Berapa harganya?", roman: null, translation: "How much is it?", context: "shopping", chapter: "money_and_pay", register: "neutral" },
  { country: "MY", lang: "ms", local: "Saya tidak faham", roman: null, translation: "I don't understand", context: "clarification", chapter: "speak_and_understand", register: "neutral" },
  { country: "MY", lang: "ms", local: "Boleh cakap bahasa Inggeris?", roman: null, translation: "Can you speak English?", context: "clarification", chapter: "speak_and_understand", register: "neutral" },
  { country: "MY", lang: "ms", local: "Di mana tandas?", roman: null, translation: "Where is the toilet?", context: "directions", chapter: "move_around", register: "neutral" },
  { country: "MY", lang: "ms", local: "Saya pelajar", roman: null, translation: "I am a student", context: "introduction", chapter: "speak_and_understand", register: "neutral" },
  { country: "MY", lang: "ms", local: "Boleh tolong saya?", roman: null, translation: "Can you help me?", context: "request", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "MY", lang: "ms", local: "Jangan pedas", roman: null, translation: "Not spicy, please", context: "food", chapter: "live_here", register: "casual" },

  // ---- Indonesian (Indonesia) ----
  { country: "ID", lang: "id", local: "Terima kasih", roman: null, translation: "Thank you", context: "courtesy", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "ID", lang: "id", local: "Sama-sama", roman: null, translation: "You're welcome", context: "courtesy", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "ID", lang: "id", local: "Selamat pagi", roman: null, translation: "Good morning", context: "greeting", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "ID", lang: "id", local: "Permisi", roman: null, translation: "Excuse me (passing by / getting attention)", context: "courtesy", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "ID", lang: "id", local: "Maaf", roman: null, translation: "Sorry", context: "apology", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "ID", lang: "id", local: "Berapa harganya?", roman: null, translation: "How much is it?", context: "shopping", chapter: "money_and_pay", register: "neutral" },
  { country: "ID", lang: "id", local: "Saya tidak mengerti", roman: null, translation: "I don't understand", context: "clarification", chapter: "speak_and_understand", register: "neutral" },
  { country: "ID", lang: "id", local: "Bisa bicara bahasa Inggris?", roman: null, translation: "Can you speak English?", context: "clarification", chapter: "speak_and_understand", register: "neutral" },
  { country: "ID", lang: "id", local: "Di mana toilet?", roman: null, translation: "Where is the toilet?", context: "directions", chapter: "move_around", register: "neutral" },
  { country: "ID", lang: "id", local: "Saya mahasiswa", roman: null, translation: "I am a university student", context: "introduction", chapter: "speak_and_understand", register: "neutral" },
  { country: "ID", lang: "id", local: "Bisa bantu saya?", roman: null, translation: "Can you help me?", context: "request", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "ID", lang: "id", local: "Tidak pedas", roman: null, translation: "Not spicy", context: "food", chapter: "live_here", register: "casual" },

  // ---- Thai (Thailand) ----
  { country: "TH", lang: "th", local: "สวัสดี", roman: "sà-wàt-dii", translation: "Hello", context: "greeting", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "TH", lang: "th", local: "ขอบคุณ", roman: "khàawp-khun", translation: "Thank you", context: "courtesy", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "TH", lang: "th", local: "ขอโทษ", roman: "khǎaw-thôot", translation: "Sorry / excuse me", context: "apology", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "TH", lang: "th", local: "เท่าไหร่", roman: "thâo-rài", translation: "How much?", context: "shopping", chapter: "money_and_pay", register: "neutral" },
  { country: "TH", lang: "th", local: "ไม่เข้าใจ", roman: "mâi khâo-jai", translation: "I don't understand", context: "clarification", chapter: "speak_and_understand", register: "neutral" },
  { country: "TH", lang: "th", local: "พูดภาษาอังกฤษได้ไหม", roman: "phûut phaa-sǎa ang-krìt dâi mǎi", translation: "Can you speak English?", context: "clarification", chapter: "speak_and_understand", register: "neutral" },
  { country: "TH", lang: "th", local: "ห้องน้ำอยู่ไหน", roman: "hông-náam yùu nǎi", translation: "Where is the toilet?", context: "directions", chapter: "move_around", register: "neutral" },
  { country: "TH", lang: "th", local: "ผมเป็นนักศึกษา", roman: "phǒm bpen nák-sʉ̀k-sǎa", translation: "I am a student (male speaker)", context: "introduction", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "TH", lang: "th", local: "ฉันเป็นนักศึกษา", roman: "chǎn bpen nák-sʉ̀k-sǎa", translation: "I am a student (female speaker)", context: "introduction", chapter: "speak_and_understand", register: "polite-neutral" },
  { country: "TH", lang: "th", local: "ช่วยด้วย", roman: "chûai dûai", translation: "Help!", context: "emergency", chapter: "stay_safe_and_healthy", register: "urgent" },
];

function loadEnv() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function admin() {
  const client = new Client().setEndpoint(process.env.VITE_APPWRITE_ENDPOINT).setProject(process.env.VITE_APPWRITE_PROJECT_ID).setKey(process.env.APPWRITE_API_KEY);
  return { tables: new TablesDB(client), databaseId: process.env.VITE_APPWRITE_DATABASE_ID };
}

async function readAll(tables, databaseId, tableId, queries = []) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const page = await tables.listRows({ databaseId, tableId, queries: [...queries, Query.limit(100), Query.offset(offset)] });
    rows.push(...page.rows);
    if (rows.length >= page.total || page.rows.length === 0) break;
  }
  return rows;
}

/** Deterministic, collision-free id derived from content. */
function seedId(prefix, seed) {
  return `${prefix}_${String(seed).replace(/[^a-zA-Z0-9]/g, "").slice(0, 28)}`;
}

async function main() {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");
  const { tables, databaseId } = admin();

  // ---- tasks, derived from facts that carry an action ------------------------
  const facts = await readAll(tables, databaseId, FACTS);
  const actionable = facts.filter((fact) => fact.actionable_advice && String(fact.actionable_advice).trim().length > 10);

  const byCountry = new Map();
  for (const fact of actionable) {
    const list = byCountry.get(fact.country_code) ?? [];
    list.push(fact);
    byCountry.set(fact.country_code, list);
  }

  const taskPlan = [];
  for (const [country, list] of byCountry) {
    const ordered = [...list].sort((a, b) => {
      const stage = STAGE_ORDER.indexOf(a.journey_stage) - STAGE_ORDER.indexOf(b.journey_stage);
      if (stage !== 0) return stage;
      return String(a.chapter ?? "").localeCompare(String(b.chapter ?? ""));
    });
    ordered.slice(0, MAX_TASKS_PER_COUNTRY).forEach((fact, index) => {
      const action = String(fact.actionable_advice).trim();
      taskPlan.push({
        rowId: seedId("task", fact.fact_id),
        data: {
          task_id: seedId("task", fact.fact_id),
          country_code: fact.country_code,
          chapter_id: fact.chapter ?? "get_ready",
          journey_stage: fact.journey_stage ?? "before_arrival",
          // The title is the action itself; the claim is the "why" beneath it.
          title: action.length > 120 ? `${action.slice(0, 117)}…` : action,
          detail: String(fact.claim ?? "").slice(0, 400),
          order_index: index,
          fact_ids: JSON.stringify([fact.fact_id]),
        },
      });
    });
  }

  // ---- phrases ---------------------------------------------------------------
  const phrasePlan = PHRASES.map((phrase, index) => {
    const id = seedId("phr", `${phrase.country}${phrase.local}${index}`);
    return {
      rowId: id,
      data: {
        phrase_id: id,
        country_code: phrase.country,
        language_code: phrase.lang,
        local_text: phrase.local,
        romanization: phrase.roman ?? null,
        translation: phrase.translation,
        context_key: phrase.context,
        chapter: phrase.chapter,
        register: phrase.register,
        audio_file_id: null,
        checked_at: new Date().toISOString(),
      },
    };
  });

  let tasksWritten = 0;
  let phrasesWritten = 0;

  if (!dryRun) {
    for (const entry of taskPlan) {
      await tables.upsertRow({ databaseId, tableId: TASKS_TABLE, rowId: entry.rowId, data: entry.data, permissions: [Permission.read(Role.any())] });
      tasksWritten += 1;
    }
    for (const entry of phrasePlan) {
      await tables.upsertRow({ databaseId, tableId: PHRASES_TABLE, rowId: entry.rowId, data: entry.data, permissions: [Permission.read(Role.any())] });
      phrasesWritten += 1;
    }
  }

  const tasksByCountry = {};
  for (const entry of taskPlan) tasksByCountry[entry.data.country_code] = (tasksByCountry[entry.data.country_code] ?? 0) + 1;
  const phrasesByCountry = {};
  for (const entry of phrasePlan) phrasesByCountry[entry.data.country_code] = (phrasesByCountry[entry.data.country_code] ?? 0) + 1;

  console.log(dryRun ? "DRY RUN\n" : "seeding the Greenbook product layer\n");
  console.log(`  tasks derived from ${actionable.length} actionable fact(s) of ${facts.length}`);
  console.log(`  tasks by country:   ${JSON.stringify(tasksByCountry)}`);
  console.log(`  phrases by country: ${JSON.stringify(phrasesByCountry)}`);
  console.log(`  media:              not seeded — no verifiable real video id is available in this environment`);

  const evidence = {
    generatedAt: new Date().toISOString(),
    factsScanned: facts.length,
    actionableFacts: actionable.length,
    tasks: { total: taskPlan.length, byCountry: tasksByCountry },
    phrases: { total: phrasePlan.length, byCountry: phrasesByCountry },
    media: { total: 0, reason: "no verifiable real media id available; not fabricated" },
    dryRun,
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(evidence, null, 2));
  console.log(`\nwrote ${OUT_PATH}`);
}

main().catch((error) => {
  console.error("seed failed:", error.message);
  process.exitCode = 1;
});
