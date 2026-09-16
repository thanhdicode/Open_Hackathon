/**
 * AI contract parity test.
 *
 * The gateway (server) and the client keep separate copies of every contract so
 * the Appwrite function stays self-contained when it is deployed. This test is
 * what keeps the two honest: the same fixtures must pass on both sides, and the
 * same invalid fixtures must fail on both sides.
 *
 * It also asserts the behaviour the Phase 3 refactor exists to guarantee:
 * a payload missing `confidence`, `misunderstandingRisk` or a score dimension
 * is REJECTED, never repaired with an invented default.
 *
 * Run: node --test scripts/verify/contracts.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { z } from "zod";
import { contracts as serverContracts } from "../../functions/ai-gateway/src/contracts.js";
import { fixtures, SCHEMA_FILE_NAMES } from "./ai-contract-fixtures.mjs";

register("./ts-resolve-hooks.mjs", import.meta.url);

/** Client mirror modules. `client.ts` is excluded: it touches import.meta.env. */
const CLIENT_MODULES = {
  lensResult: ["../../src/lib/ai-contracts/lens.ts", "LensResultSchema"],
  sceneResult: ["../../src/lib/ai-contracts/scene.ts", "SceneResultSchema"],
  sceneRegion: ["../../src/lib/ai-contracts/scene.ts", "SceneRegionSchema"],
  replyResult: ["../../src/lib/ai-contracts/reply.ts", "ReplyResultSchema"],
  toneCheckResult: ["../../src/lib/ai-contracts/tone-check.ts", "ToneCheckResultSchema"],
  transcriptionResult: ["../../src/lib/ai-contracts/transcription.ts", "TranscriptionResultSchema"],
  translationTurn: ["../../src/lib/ai-contracts/translation.ts", "TranslationTurnSchema"],
  speechResult: ["../../src/lib/ai-contracts/speech.ts", "SpeechResultSchema"],
  coachInsight: ["../../src/lib/ai-contracts/conversation.ts", "CoachInsightSchema"],
  conversationTurn: ["../../src/lib/ai-contracts/conversation.ts", "ConversationTurnSchema"],
  conversationSession: ["../../src/lib/ai-contracts/conversation.ts", "ConversationSessionSchema"],
  simScenario: ["../../src/lib/ai-contracts/sim.ts", "SimScenarioSchema"],
  simTurn: ["../../src/lib/ai-contracts/sim.ts", "SimTurnSchema"],
  simFeedback: ["../../src/lib/ai-contracts/sim.ts", "SimFeedbackSchema"],
  studyResult: ["../../src/lib/ai-contracts/study.ts", "StudyResultSchema"],
  assignmentResult: ["../../src/lib/ai-contracts/study.ts", "AssignmentResultSchema"],
  lectureResult: ["../../src/lib/ai-contracts/study.ts", "LectureResultSchema"],
  liveTokenResult: ["../../src/lib/ai-contracts/client.ts", null],
  greenbookAnswer: ["../../src/lib/ai-contracts/greenbook.ts", "GreenbookAnswerSchema"],
};

async function loadClientSchema(contractName) {
  const entry = CLIENT_MODULES[contractName];
  assert.ok(entry, `no client mirror registered for ${contractName}`);
  const [path, exportName] = entry;
  if (!exportName) return null;
  const module = await import(path);
  const schema = module[exportName];
  assert.ok(schema, `${path} does not export ${exportName}`);
  return schema;
}

const contractNames = Object.keys(fixtures);

test("every fixture contract has a server contract and a generated schema file", () => {
  for (const name of contractNames) {
    assert.ok(serverContracts[name], `server is missing contract: ${name}`);
    assert.ok(SCHEMA_FILE_NAMES[name], `no schema file name registered for: ${name}`);
  }
});

for (const name of contractNames) {
  test(`${name}: server contract accepts valid fixtures`, () => {
    for (const [index, fixture] of fixtures[name].valid.entries()) {
      const parsed = serverContracts[name].safeParse(fixture);
      assert.ok(parsed.success, `valid fixture ${index} rejected by server: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    }
  });

  test(`${name}: server contract rejects invalid fixtures`, () => {
    for (const [index, fixture] of fixtures[name].invalid.entries()) {
      const parsed = serverContracts[name].safeParse(fixture);
      assert.equal(parsed.success, false, `invalid fixture ${index} was accepted by the server contract`);
    }
  });
}

test("client mirrors agree with the server on every fixture", async () => {
  const disagreements = [];
  for (const name of contractNames) {
    const clientSchema = await loadClientSchema(name);
    if (!clientSchema) continue;
    for (const [kind, list] of Object.entries(fixtures[name])) {
      for (const [index, fixture] of list.entries()) {
        const serverOk = serverContracts[name].safeParse(fixture).success;
        const clientOk = clientSchema.safeParse(fixture).success;
        if (serverOk !== clientOk) disagreements.push(`${name}.${kind}[${index}] server=${serverOk} client=${clientOk}`);
      }
    }
  }
  assert.deepEqual(disagreements, [], `client and server contracts disagree:\n  ${disagreements.join("\n  ")}`);
});

test("client mirrors are not satisfied by a default the server would reject", async () => {
  // The refactor removed a gateway normalize() that invented confidence, risk
  // and score values. Neither side may accept a payload that omits them.
  const requiredCases = [
    ["lensResult", fixtures.lensResult.invalid[2]],
    ["simFeedback", fixtures.simFeedback.invalid[3]],
  ];
  for (const [name, fixture] of requiredCases) {
    assert.equal(serverContracts[name].safeParse(fixture).success, false, `${name}: server invented a default`);
    const clientSchema = await loadClientSchema(name);
    assert.equal(clientSchema.safeParse(fixture).success, false, `${name}: client invented a default`);
  }
});

test("generated JSON Schemas exist and match the live contracts", async () => {
  const { readFile } = await import("node:fs/promises");
  const mismatches = [];
  for (const [contractName, fileName] of Object.entries(SCHEMA_FILE_NAMES)) {
    let stored;
    try {
      stored = JSON.parse(await readFile(`schemas/${fileName}`, "utf8"));
    } catch {
      mismatches.push(`${fileName} is missing — run scripts/verify/generate-schemas.mjs`);
      continue;
    }
    const generated = z.toJSONSchema(serverContracts[contractName], { io: "output" });
    for (const key of ["type", "properties", "required", "additionalProperties"]) {
      const a = JSON.stringify(stored[key]);
      const b = JSON.stringify(generated[key]);
      if (a !== b) mismatches.push(`${fileName}.${key} is stale — run scripts/verify/generate-schemas.mjs`);
    }
  }
  assert.deepEqual(mismatches, [], mismatches.join("\n"));
});

test("no contract carries a chain-of-thought or secret field", () => {
  const forbidden = ["chainOfThought", "reasoning", "apiKey", "api_key", "rawAudio", "mediaBase64"];
  const found = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      if (forbidden.includes(key)) found.push(`${path}.${key}`);
      walk(node[key], `${path}.${key}`);
    }
  };
  for (const [name, schema] of Object.entries(serverContracts)) {
    walk(z.toJSONSchema(schema, { io: "output" }), name);
  }
  assert.deepEqual(found, [], `contracts expose fields they must not: ${found.join(", ")}`);
});
