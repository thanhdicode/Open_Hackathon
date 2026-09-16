/**
 * Tests for the headless-render fallback's decision logic.
 *
 * `looksLikeShell` is the only part of render.mjs that can be tested without a
 * browser and a network, and it is also the part that decides whether an
 * expensive render happens at all. Getting it wrong is costly in both
 * directions: too eager and every source pays for a browser launch, too shy and
 * the six client-rendered countries stay empty.
 *
 * The thresholds are pinned against real measurements rather than invented
 * numbers, so a future change that loosens them has to argue with the data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeShell, SHELL_BYTES_FLOOR, SHELL_TEXT_CEILING } from "./render.mjs";

test("a real client-rendered shell is detected", () => {
  // Measured 2026-09-16, before rendering: evisa.moip.gov.mm served 124,285
  // bytes and 34 characters of text.
  assert.equal(looksLikeShell({ text: "x".repeat(34), bytes: 124_285 }), true);
  // immigration.gov.kh: 175 characters from a real page load.
  assert.equal(looksLikeShell({ text: "x".repeat(175), bytes: 90_000 }), true);
  // gov.bn/services/Immigration.aspx: 70 characters.
  assert.equal(looksLikeShell({ text: "x".repeat(70), bytes: 95_116 }), true);
});

test("a productive source is never treated as a shell", () => {
  // my-bnm: 6,229 characters from 277,042 bytes.
  assert.equal(looksLikeShell({ text: "x".repeat(6_229), bytes: 277_042 }), false);
  // sg-ica: a normal government page.
  assert.equal(looksLikeShell({ text: "x".repeat(9_500), bytes: 120_000 }), false);
});

test("a genuinely short page is not a shell just because it is small", () => {
  // The bytes floor exists for this case: a 300-byte page with 200 characters of
  // text is a short page, not a JavaScript shell. Rendering it would be waste.
  assert.equal(looksLikeShell({ text: "x".repeat(200), bytes: 300 }), false);
});

test("a small shell is still detected — the floor was lowered for exactly this", () => {
  // Measured 2026-09-16: kh-moeys serves 3,426 bytes and 49 characters. At the
  // original 20,000-byte floor this was skipped and the render never ran, so
  // Cambodia's education ministry stayed empty.
  assert.equal(looksLikeShell({ text: "x".repeat(49), bytes: 3_426 }), true);
  assert.equal(looksLikeShell({ text: "x".repeat(44), bytes: 4_337 }), true);
});

test("a large page with plenty of text is not a shell even if the text is small in share", () => {
  // 1,200 characters from 1.2 MB is a low ratio but well past the ceiling — a
  // page that big with that much text is not an empty SPA.
  assert.equal(looksLikeShell({ text: "x".repeat(1_200), bytes: 1_176_183 }), false);
});

test("missing or empty text with real bytes is a shell", () => {
  assert.equal(looksLikeShell({ text: null, bytes: 100_000 }), true);
  assert.equal(looksLikeShell({ text: "", bytes: 100_000 }), true);
});

test("missing bytes is never a shell", () => {
  // No bytes means the fetch itself failed, which is a different failure and
  // must not be answered by launching a browser.
  assert.equal(looksLikeShell({ text: "", bytes: 0 }), false);
  assert.equal(looksLikeShell({ text: "", bytes: null }), false);
  assert.equal(looksLikeShell({}), false);
});

test("the thresholds are the measured ones", () => {
  assert.equal(SHELL_TEXT_CEILING, 500);
  assert.equal(SHELL_BYTES_FLOOR, 2_000);
});
