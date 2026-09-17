import { test } from "node:test"
import assert from "node:assert/strict"
import { register } from "node:module"
register("./ts-resolve-hooks.mjs", import.meta.url)
const {
  visibleTourSteps,
  readGuideDismissed,
  writeGuideDismissed,
  TOURS,
  COUNTRY_OUTFITS,
} = await import("../../src/lib/yep-guidance.ts")

test("scoped tour excludes hidden and missing targets, preserves order", () => {
  const visible = {
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ width: 44, height: 44 }),
  }
  const hidden = {
    checkVisibility: () => false,
    getBoundingClientRect: () => ({ width: 44, height: 44 }),
  }
  const root = {
    querySelector: (s) =>
      s === "#visible" ? visible : s === "#hidden" ? hidden : null,
  }
  const entries = [
    { selector: "#missing", title: "missing", description: "" },
    { selector: "#hidden", title: "hidden", description: "" },
    { selector: "#visible", title: "valid", description: "safe" },
  ]
  const steps = visibleTourSteps(root, entries)
  assert.equal(steps.length, 1)
  assert.equal(steps[0].element, visible)
  assert.equal(steps[0].popover.title, "valid")
})

test("private mode storage never breaks guidance", () => {
  const blocked = {
    getItem() {
      throw new Error("blocked")
    },
    setItem() {
      throw new Error("blocked")
    },
  }
  assert.equal(readGuideDismissed("lens", blocked), false)
  assert.doesNotThrow(() => writeGuideDismissed("lens", blocked))
  const values = new Map()
  const storage = {
    getItem: (k) => values.get(k),
    setItem: (k, v) => values.set(k, v),
  }
  writeGuideDismissed("lens", storage)
  assert.equal(readGuideDismissed("lens", storage), true)
  assert.equal(readGuideDismissed("passport", storage), false)
})

test("all eleven host-country outfits have unique cells and source labels", () => {
  assert.deepEqual(Object.keys(COUNTRY_OUTFITS).sort(), [
    "BN",
    "ID",
    "KH",
    "LA",
    "MM",
    "MY",
    "PH",
    "SG",
    "TH",
    "TL",
    "VN",
  ])
  assert.equal(
    new Set(Object.values(COUNTRY_OUTFITS).map((v) => v.cell)).size,
    11,
  )
  for (const entry of Object.values(COUNTRY_OUTFITS)) {
    assert.ok(entry.cell >= 0 && entry.cell < 11)
    assert.ok(entry.label.length > 3)
    assert.match(entry.source, /^https:\/\//)
  }
  assert.match(COUNTRY_OUTFITS.SG.label, /Peranakan/)
})

test("guides stay short and use screen-scoped anchors", () => {
  for (const steps of Object.values(TOURS)) {
    assert.ok(steps.length >= 2 && steps.length <= 4)
    for (const step of steps) assert.match(step.selector, /^\[data-yep=/)
  }
})
