import test from "node:test";
import assert from "node:assert/strict";
import { createHoldToRecordController } from "../../src/features/lens/use-hold-to-record.ts";
import { evidenceFromLocalOcr } from "../../src/lib/local-ocr.ts";

test("push-to-talk remembers a release that happens before microphone permission resolves", async () => {
  let resolveStart;
  let stopped = 0;
  const events = [];
  const start = new Promise((resolve) => { resolveStart = resolve; });
  const controller = createHoldToRecordController({
    start: () => start,
    onRecordingChange: (recording) => events.push(recording),
    onCapture: async () => events.push("captured"),
    onError: (error) => { throw error; },
  });
  const begun = controller.begin();
  await controller.end();
  resolveStart({ stop: async () => { stopped += 1; return { file: new File(["voice"], "voice.webm", { type: "audio/webm" }) }; }, cancel() {} });
  await begun;
  assert.equal(stopped, 1);
  assert.deepEqual(events, [true, false, "captured"]);
});

test("on-device OCR evidence removes repeated lines before the scan model sees them", () => {
  const result = evidenceFromLocalOcr({
    texts: [
      { text: "Nasi Lemak 10 RM", box: { ymin: 0, xmin: 0, ymax: 10, xmax: 10 }, confidence: 90 },
      { text: " nasi   lemak 10 rm ", box: { ymin: 20, xmin: 0, ymax: 30, xmax: 10 }, confidence: 80 },
      { text: "Open daily", box: { ymin: 40, xmin: 0, ymax: 50, xmax: 10 }, confidence: 90 },
    ],
    fullText: "Nasi Lemak 10 RM\nOpen daily",
    languagesUsed: ["eng"],
    durationMs: 1,
    unavailable: false,
  });
  assert.deepEqual(result?.visibleTexts.map((entry) => entry.text), ["Nasi Lemak 10 RM", "Open daily"]);
});
