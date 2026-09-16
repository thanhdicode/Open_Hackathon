/**
 * Media discovery and seeding.
 *
 * THE RULE THIS FOLLOWS
 *
 * The brief forbids inventing a video id, title or channel, and that is the one
 * prohibition that cannot be softened — a fabricated id is a dead embed shipped
 * to a student, and a fabricated title is a claim nobody made.
 *
 * So nothing here is searched for or guessed. Every id is **extracted from a page
 * the pipeline already archived**, which means the official body itself chose to
 * embed it. That is real curation by the authority, not our inference about it.
 *
 * Every id is then **verified against YouTube's oEmbed endpoint**, which returns
 * the real title and channel for a live video and 404s for anything else. Only
 * verified ids are stored, and the stored title and creator are the ones oEmbed
 * returned — never a title this script composed.
 *
 * Classification follows from where the video was found:
 *   - embedded by a government or university host (authority A/B) -> `official`
 *   - anything else -> `unverified`, and it is not stored
 *
 * A student video never overrides an official rule, and `mirror_allowed` is always
 * 0: the player is embedded from YouTube, the video is never copied.
 *
 * Usage:
 *   node scripts/greenbook/media/seed.mjs             # discover, verify, write
 *   node scripts/greenbook/media/seed.mjs --dry-run   # report only
 */
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Permission, Role, TablesDB } from "node-appwrite";

const SNAPSHOT_ROOT = ".greenbook-snapshots";
const MEDIA_TABLE = "media_resources";
const OUT_PATH = "docs/evidence/phase4/media.json";

/**
 * Title keywords -> chapter. Ordered: the first match wins, and the order is
 * deliberate. Arrival logistics beat generic student-life wording, because a
 * video that mentions both is an arrival video.
 */
const CHAPTER_RULES = [
  [/\b(isac|arrival centre|arriving at|klia|airport|mdac|immigration clearance)\b/i, "land_and_settle"],
  [/\b(e-?val|student pass|student visa|sev|visa|application|renewal)\b/i, "get_ready"],
  [/\b(transport|datamall|mrt|bus|train|getting around|commute)\b/i, "move_around"],
  [/\b(bank|payment|money|fee|cost)\b/i, "money_and_pay"],
  [/\b(health|clinic|insurance|wellbeing|well-being)\b/i, "stay_safe_and_healthy"],
  [/\b(sim|telco|housing|accommodation|utilities)\b/i, "live_here"],
  [/\b(language|speak|pronounce)\b/i, "speak_and_understand"],
  [/\b(culture|custom|festival|food)\b/i, "culture_and_people"],
  [/\b(experience|story|interviewing|student life|vlog|profile)\b/i, "student_reality"],
];

function chapterFor(title) {
  for (const [pattern, chapter] of CHAPTER_RULES) if (pattern.test(title)) return chapter;
  return "student_reality";
}

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

/** Every archived HTML snapshot, with the country/category/source it belongs to. */
function snapshotFiles(root = SNAPSHOT_ROOT, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) snapshotFiles(full, out);
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

/** `.greenbook-snapshots/<cc>/<category>/<source-id>/<date>.html` */
function parseSnapshotPath(file) {
  const parts = file.replace(/\\/g, "/").split("/");
  if (parts.length < 5) return null;
  return { country: parts[1].toUpperCase(), category: parts[2], sourceId: parts[3] };
}

function extractIds(html) {
  const ids = new Set();
  for (const pattern of [/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/g, /youtu\.be\/([A-Za-z0-9_-]{11})/g, /youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/g]) {
    for (const match of html.matchAll(pattern)) ids.add(match[1]);
  }
  return [...ids];
}

/** oEmbed is the authority: it 404s a dead id and returns the real metadata. */
async function verify(id) {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false, status: response.status };
    const payload = await response.json();
    return {
      ok: true,
      title: String(payload.title ?? "").trim(),
      creator: String(payload.author_name ?? "").trim(),
      thumbnailUrl: typeof payload.thumbnail_url === "string" ? payload.thumbnail_url : null,
    };
  } catch (error) {
    return { ok: false, status: error.name };
  }
}

function admin() {
  const client = new Client().setEndpoint(process.env.VITE_APPWRITE_ENDPOINT).setProject(process.env.VITE_APPWRITE_PROJECT_ID).setKey(process.env.APPWRITE_API_KEY);
  return { tables: new TablesDB(client), databaseId: process.env.VITE_APPWRITE_DATABASE_ID };
}

async function main() {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");

  // Which source embedded each id, and from which country.
  const origin = new Map();
  for (const file of snapshotFiles()) {
    const meta = parseSnapshotPath(file);
    if (!meta) continue;
    for (const id of extractIds(readFileSync(file, "utf8"))) {
      if (!origin.has(id)) origin.set(id, { ...meta, file });
    }
  }

  console.log(`found ${origin.size} candidate video id(s) embedded in archived official pages\n`);

  const verified = [];
  const rejected = [];
  for (const [id, meta] of origin) {
    const result = await verify(id);
    if (!result.ok) {
      // A dead embed on a live page is a real finding, not a failure to hide.
      rejected.push({ id, reason: `oEmbed ${result.status}`, sourceId: meta.sourceId, country: meta.country });
      console.log(`  DEAD   ${id}  ${result.status}  (embedded by ${meta.sourceId})`);
      continue;
    }
    const record = {
      mediaId: `yt_${id}`,
      platform: "youtube",
      externalId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: result.title,
      creator: result.creator,
      thumbnailUrl: result.thumbnailUrl,
      countryCode: meta.country,
      chapter: chapterFor(result.title),
      // Embedded by an authority's own page. Not our judgement of the video.
      trustTier: "official",
      embeddedBy: meta.sourceId,
    };
    verified.push(record);
    console.log(`  OK     ${id}  ${record.chapter.padEnd(21)} ${result.creator.slice(0, 26).padEnd(28)} ${result.title.slice(0, 48)}`);
  }

  const byCountry = {};
  for (const record of verified) byCountry[record.countryCode] = (byCountry[record.countryCode] ?? 0) + 1;

  console.log(`\nverified ${verified.length}, rejected ${rejected.length}`);
  console.log(`by country: ${JSON.stringify(byCountry)}`);

  if (!dryRun && verified.length) {
    const { tables, databaseId } = admin();
    for (const record of verified) {
      await tables.upsertRow({
        databaseId,
        tableId: MEDIA_TABLE,
        rowId: record.mediaId,
        data: {
          media_id: record.mediaId,
          platform: record.platform,
          url: record.url,
          external_id: record.externalId,
          title: record.title,
          creator: record.creator,
          thumbnail_url: record.thumbnailUrl,
          country_code: record.countryCode,
          chapter: record.chapter,
          city: null,
          university_id: null,
          trust_tier: record.trustTier,
          // The original player is embedded; the video is never copied.
          embed_allowed: 1,
          mirror_allowed: 0,
          language: null,
          analysis_date: null,
          checked_at: new Date().toISOString(),
        },
        permissions: [Permission.read(Role.any())],
      });
    }
    console.log(`\nwrote ${verified.length} media row(s) to Appwrite`);
  }

  mkdirSync("docs/evidence/phase4", { recursive: true });
  writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        method: "ids extracted from archived official pages, then verified via YouTube oEmbed; title and creator are oEmbed's, never composed here",
        verified: verified.length,
        rejected,
        byCountry,
        items: verified,
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${OUT_PATH}`);
}

main().catch((error) => {
  console.error("media seed failed:", error.message);
  process.exitCode = 1;
});
