/**
 * Regenerates schemas/*.schema.json from the gateway Zod contracts.
 *
 * The gateway is the source of truth for provider output, so the published
 * JSON Schemas are derived rather than hand-maintained. Run after any contract
 * change and commit the result:
 *
 *   node scripts/verify/generate-schemas.mjs
 */
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { contracts } from "../../functions/ai-gateway/src/contracts.js";
import { SCHEMA_FILE_NAMES } from "./ai-contract-fixtures.mjs";

const TITLES = {
  lensResult: "YapLensResult",
  sceneResult: "YapSceneResult",
  sceneRegion: "YapSceneRegion",
  replyResult: "YapReplyResult",
  toneCheckResult: "YapToneCheckResult",
  transcriptionResult: "YapTranscriptionResult",
  translationTurn: "YapTranslationTurn",
  speechResult: "YapSpeechResult",
  coachInsight: "YapCoachInsight",
  conversationSession: "YapConversationSession",
  conversationTurn: "YapConversationTurn",
  simScenario: "YapSimScenario",
  simTurn: "YapSimTurn",
  simFeedback: "YapSimFeedback",
  studyResult: "YapStudyResult",
  assignmentResult: "YapAssignmentResult",
  lectureResult: "YapLectureResult",
  liveTokenResult: "YapLiveTokenResult",
  greenbookAnswer: "YapGreenbookAnswer",
};

let written = 0;
for (const [contractName, fileName] of Object.entries(SCHEMA_FILE_NAMES)) {
  const schema = contracts[contractName];
  if (!schema) {
    console.error(`missing contract: ${contractName}`);
    process.exitCode = 1;
    continue;
  }
  const jsonSchema = z.toJSONSchema(schema, { io: "output" });
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: TITLES[contractName] ?? contractName,
    ...jsonSchema,
  };
  delete document.$schema;
  document.$schema = "https://json-schema.org/draft/2020-12/schema";
  await writeFile(`schemas/${fileName}`, `${JSON.stringify(document, null, 2)}\n`);
  written += 1;
}
console.log(`regenerated ${written} JSON Schemas from functions/ai-gateway/src/contracts.js`);
