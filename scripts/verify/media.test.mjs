/**
 * Media and speech-fallback unit tests.
 *
 * These cover two pieces of pure logic that the product depends on but that
 * had no test: the WAV container (without it a browser cannot play Gemini's
 * headerless PCM) and the speech fallback ordering.
 *
 * Run: node --test scripts/verify/media.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { isRawPcmMimeType, sampleRateFromMimeType, pcmToWav, toPlayableAudio } from "../../functions/ai-gateway/src/audio.js";

register("./ts-resolve-hooks.mjs", import.meta.url);

const { decideSpeechMode, speechFallbackReason } = await import("../../src/lib/ai/speech-mode.ts");

/* -------------------------------------------------------------------------- */
/* WAV container                                                              */
/* -------------------------------------------------------------------------- */

test("raw PCM mime types are detected, container formats are not", () => {
  assert.equal(isRawPcmMimeType("audio/L16;codec=pcm;rate=24000"), true);
  assert.equal(isRawPcmMimeType("audio/l16"), true);
  assert.equal(isRawPcmMimeType("audio/wav"), false);
  assert.equal(isRawPcmMimeType(undefined), false);
});

test("the sample rate is parsed from the mime type", () => {
  assert.equal(sampleRateFromMimeType("audio/L16;codec=pcm;rate=24000"), 24_000);
  assert.equal(sampleRateFromMimeType("audio/L16;rate=16000"), 16_000);
  assert.equal(sampleRateFromMimeType("audio/L16"), 24_000, "falls back to 24 kHz");
});

test("pcmToWav writes a valid RIFF/WAVE header", () => {
  const pcm = Buffer.alloc(1000, 7);
  const wav = pcmToWav(pcm, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });

  assert.equal(wav.length, pcm.length + 44, "header must be exactly 44 bytes");
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(12, 16).toString("ascii"), "fmt ");
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");

  assert.equal(wav.readUInt32LE(4), 36 + pcm.length, "RIFF chunk size");
  assert.equal(wav.readUInt32LE(16), 16, "PCM fmt chunk size");
  assert.equal(wav.readUInt16LE(20), 1, "format must be PCM (1)");
  assert.equal(wav.readUInt16LE(22), 1, "channels");
  assert.equal(wav.readUInt32LE(24), 24_000, "sample rate");
  assert.equal(wav.readUInt16LE(32), 2, "block align = channels * bits/8");
  assert.equal(wav.readUInt32LE(28), 48_000, "byte rate = sampleRate * blockAlign");
  assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data chunk size");
});

test("pcmToWav preserves the sample payload after the header", () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const wav = pcmToWav(pcm);
  assert.deepEqual([...wav.subarray(44)], [1, 2, 3, 4]);
});

test("toPlayableAudio wraps raw PCM into audio/wav", () => {
  const base64 = Buffer.alloc(200, 3).toString("base64");
  const playable = toPlayableAudio(base64, "audio/L16;codec=pcm;rate=24000");
  assert.equal(playable.mimeType, "audio/wav", "a browser cannot play headerless PCM");
  const decoded = Buffer.from(playable.base64, "base64");
  assert.equal(decoded.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(decoded.length, 244);
});

test("toPlayableAudio leaves an already-playable format untouched", () => {
  const base64 = Buffer.alloc(64, 9).toString("base64");
  const playable = toPlayableAudio(base64, "audio/mpeg");
  assert.equal(playable.mimeType, "audio/mpeg");
  assert.equal(playable.base64, base64, "no re-encoding when no wrapping is needed");
});

/* -------------------------------------------------------------------------- */
/* Speech fallback ordering                                                   */
/* -------------------------------------------------------------------------- */

test("the provider wins when it produced audio", () => {
  assert.equal(decideSpeechMode({ providerOk: true, browserSupported: true, browserSpoke: true }), "provider");
});

test("the device voice is used when the provider failed", () => {
  assert.equal(decideSpeechMode({ providerOk: false, browserSupported: true, browserSpoke: true }), "browser");
});

test("text only is used when neither produced audio", () => {
  assert.equal(decideSpeechMode({ providerOk: false, browserSupported: true, browserSpoke: false }), "text-only");
});

test("unsupported is reported when the browser cannot speak at all", () => {
  assert.equal(decideSpeechMode({ providerOk: false, browserSupported: false, browserSpoke: false }), "unsupported");
});

test("a failed provider never escalates to a blocking error", () => {
  // Every combination must resolve to a mode; none of them may throw or be undefined.
  for (const providerOk of [true, false]) {
    for (const browserSupported of [true, false]) {
      for (const browserSpoke of [true, false]) {
        const mode = decideSpeechMode({ providerOk, browserSupported, browserSpoke });
        assert.ok(["provider", "browser", "text-only", "unsupported"].includes(mode), `unexpected mode ${mode}`);
      }
    }
  }
});

test("only the no-audio modes carry a reason", () => {
  assert.equal(speechFallbackReason("provider", "ms"), undefined);
  assert.equal(speechFallbackReason("browser", "ms"), undefined);
  assert.ok(speechFallbackReason("text-only", "ms"), "text-only must explain itself");
  assert.ok(speechFallbackReason("unsupported", "ms"), "unsupported must explain itself");
});

test("the fallback reason names the language when the device has no voice for it", () => {
  const reason = speechFallbackReason("text-only", "tet");
  assert.match(reason, /tet/, "the student should know which language has no voice");
});
