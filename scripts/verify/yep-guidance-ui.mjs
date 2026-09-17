/** UI-only QA: Appwrite is intercepted; no real account/data writes or AI calls. */
import { chromium } from "@playwright/test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { completeOnboarding } from "./lib/onboarding.mjs"

const BASE = process.env.BASE_URL || "http://127.0.0.1:5173"
const OUT = "docs/evidence/yep-guidance"
mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  reducedMotion: "reduce",
})
const page = await context.newPage()
page.setDefaultTimeout(10000)
const results = []
const errors = []
const apiCalls = []
page.on("pageerror", (error) => errors.push(error.message))
await context.route(
  /\/v1\/(account|tablesdb|storage|functions)(\/|\?|$)/,
  async (route) => {
    const url = new URL(route.request().url())
    const headers = {
      "access-control-allow-origin": new URL(BASE).origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers":
        route.request().headers()["access-control-request-headers"] ||
        "content-type,x-appwrite-project,x-appwrite-response-format,x-sdk-name,x-sdk-platform,x-sdk-language,x-sdk-version",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    }
    let status = 200
    let body = {}
    if (url.pathname.endsWith("/account"))
      body = {
        $id: "yep-ui-qa",
        name: "Minh",
        email: "",
        status: true,
        prefs: {},
        emailVerification: false,
        phoneVerification: false,
      }
    else if (url.pathname.endsWith("/sessions/current"))
      body = { $id: "qa-session", provider: "anonymous", current: true }
    else if (/\/rows$/.test(url.pathname) && route.request().method() === "GET")
      body = { total: 0, rows: [] }
    else if (
      /\/rows\/[^/]+$/.test(url.pathname) &&
      route.request().method() === "GET"
    ) {
      status = 404
      body = {
        code: 404,
        message: "UI fixture has no stored row",
        type: "row_not_found",
      }
    } else
      body = { $id: "yep-ui-qa", total: 0, rows: [], sessions: [], prefs: {} }
    await route.fulfill({
      status,
      headers,
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  },
)
await context.route(/\/api\//, (route) => {
  apiCalls.push(route.request().url())
  return route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "UI-only QA" }),
  })
})

async function snap(name) {
  await page.screenshot({ path: `${OUT}/${name}.png` })
}
async function measure(name) {
  const metrics = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    overflow: document.documentElement.scrollWidth > innerWidth,
    popover: (() => {
      const el = document.querySelector(".yep-tour")
      if (!el) return null
      const r = el.getBoundingClientRect()
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        buttons: [...el.querySelectorAll("button")]
          .filter((b) => b.getBoundingClientRect().width)
          .map((b) => ({
            width: b.getBoundingClientRect().width,
            height: b.getBoundingClientRect().height,
          })),
      }
    })(),
  }))
  assert.equal(metrics.overflow, false, `${name}: horizontal overflow`)
  if (metrics.popover) {
    const r = metrics.popover
    assert.ok(
      r.left >= 0 &&
        r.top >= 0 &&
        r.right <= metrics.width + 1 &&
        r.bottom <= metrics.height + 1,
      `${name}: popover outside viewport ${JSON.stringify(r)}`,
    )
    for (const b of r.buttons)
      assert.ok(
        b.width >= 44 && b.height >= 44,
        `${name}: undersized tour control`,
      )
  }
  results.push({ name, ...metrics })
}
async function tab(name) {
  await page
    .locator('nav[aria-label="Primary"]:visible')
    .getByRole("button", { name, exact: true })
    .click()
}
async function runTour(screen, screenshot = false) {
  const replay = page
    .locator(`[data-yep-guide="${screen}"] [data-yep-replay]`)
    .first()
  await replay.click()
  await page.locator(".yep-tour").waitFor()
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab")
    assert.ok(
      await page
        .locator(".yep-tour")
        .evaluate((el) => el.contains(document.activeElement)),
      `${screen}: keyboard focus escaped guide`,
    )
  }
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(150)
    for (let key = 0; key < 8; key++) {
      await page.keyboard.press("Tab")
      assert.ok(
        await page
          .locator(".yep-tour")
          .evaluate((el) => el.contains(document.activeElement)),
        `${screen}: keyboard focus escaped guide at step ${i + 1}`,
      )
    }
    await measure(`${screen}-tour-${i + 1}`)
    if (screenshot && i === 0) await snap(`${screen}-tour-390`)
    const next = page.locator(".yep-tour .driver-popover-next-btn")
    const done = (await next.innerText()) === "Got it"
    await next.click()
    if (done) break
  }
  await page.locator(".yep-tour").waitFor({ state: "detached" })
  await page.waitForFunction(
    (screen) =>
      document.querySelector(
        `[data-yep-guide="${screen}"] [data-yep-replay]`,
      ) === document.activeElement,
    screen,
    { timeout: 3000 },
  )
}

try {
  /*
   * `networkidle` is unreliable against a *dev* server: Vite keeps a long-lived HMR
   * socket and streams module requests, so the network never goes idle and the 10s
   * default expires before the app paints. `domcontentloaded` plus the explicit
   * welcome-CTA wait below is the honest signal for "the app is up".
   */
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 })
  /*
   * Wait for the real welcome CTA, not the pre-rebuild "Try YapYep".
   *
   * The 3-step onboarding (Phase 6 §4) kept only `Start my journey`, and a cold
   * dev server compiles modules on first request — so this needs its own generous
   * timeout rather than the file-wide 10s, which expired before the flow painted
   * and reported a harness failure on a flow that works.
   */
  await page
    .getByRole("button", { name: /Start my journey|Try YapYep/ })
    .first()
    .waitFor({ timeout: 60_000 })
  await snap("welcome-390")
  await page.setViewportSize({ width: 320, height: 568 })
  await measure("welcome-320-short")
  await page
    .getByRole("button", { name: /Start my journey|Try YapYep/ })
    .first()
    .scrollIntoViewIfNeeded()
  await snap("welcome-320-short")
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(
    await completeOnboarding(page, { maxSteps: 90 }),
    "onboarding did not complete",
  )
  await page.locator('[data-yep-guide="today"]').waitFor()
  await snap("today-390")
  await tab("Passport")
  await snap("passport-390")
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport)
    for (const [name, screen] of [
      ["Today", "today"],
      ["Passport", "passport"],
      ["Lens", "lens"],
      ["Explore", "explore"],
      ["Connect", "connect"],
    ]) {
      await tab(name)
      await measure(`${screen}-${viewport.width}x${viewport.height}`)
      await runTour(screen, viewport.width === 390)
      /*
       * Progress goes to stdout per screen.
       *
       * Results are only written at the very end, so a stall anywhere in this
       * sweep — 8 viewports x 5 screens x up to 8 tour steps — produced a log with
       * nothing but the npm banner and no indication of which screen hung. That
       * made a harness stall indistinguishable from a slow run.
       */
      console.log(`  ok ${screen} @ ${viewport.width}x${viewport.height}`)
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })

  /*
   * Checkpoint the viewport/tour sweep before the destructive-overlay checks.
   *
   * Everything from here on deliberately drives tours into broken states (hiding
   * targets, resizing the visual viewport, tab-changing mid-tour) and one of those
   * crashes the renderer after a long run ("Target crashed"). Because results were
   * only written at the very end, that crash discarded 40 passing measurements and
   * left the run looking like a total failure. The sweep is the load-bearing
   * evidence, so it is persisted as soon as it is complete.
   */
  writeFileSync(
    `${OUT}/ui-results.json`,
    JSON.stringify(
      { status: "PARTIAL", stage: "viewport-and-tour-sweep-complete", results, errors, apiCalls },
      null,
      2,
    ),
  )
  console.log(`  checkpoint: ${results.length} sweep checks written`)

  await tab("Lens")
  await page.locator('[data-yep-guide="lens"] [data-yep-replay]').click()
  await page.keyboard.press("Escape")
  await page.locator(".yep-tour").waitFor({ state: "detached" })
  results.push({ name: "escape-closes-tour", pass: true })

  // Removed/hidden targets close safely and do not leave pointer-blocking overlays.
  await page.locator('[data-yep-guide="lens"] [data-yep-replay]').click()
  await page
    .locator('[data-yep="intro"]')
    .evaluate((el) => (el.style.display = "none"))
  await page.locator(".yep-tour").waitFor({ state: "detached" })
  await page
    .locator('[data-yep="intro"]')
    .evaluate((el) => (el.style.display = ""))
  assert.equal(
    await page
      .locator("body")
      .evaluate((el) => el.classList.contains("driver-active")),
    false,
  )
  results.push({ name: "hidden-target-cleans-up", pass: true })

  // Route cleanup: trigger normal tab handler directly because tours disable outside clicks.
  await page.locator('[data-yep-guide="lens"] [data-yep-replay]').click()
  await page
    .locator('nav[aria-label="Primary"]:visible')
    .getByRole("button", { name: "Passport", exact: true })
    .evaluate((el) => el.click())
  await page.locator(".yep-tour").waitFor({ state: "detached" })
  results.push({ name: "tab-change-cleans-up", pass: true })

  await tab("Today")
  await page.getByRole("button", { name: "Practice", exact: true }).click()
  await runTour("sim", true)
  await page.getByRole("button", { name: "Back", exact: true }).last().click()
  await page.getByRole("button", { name: "Ask", exact: true }).click()
  await runTour("study", true)
  await page.getByRole("button", { name: "Back", exact: true }).last().click()
  await page.getByText("Living Greenbook", { exact: true }).click()
  await runTour("greenbook", true)
  await page
    .getByRole("button", { name: "Ask this Greenbook", exact: true })
    .click()
  await runTour("ask", true)
  assert.equal(
    await page.locator('[data-yep="question"]').inputValue(),
    "",
    "tour changed question input",
  )
  await page.getByRole("button", { name: "Back", exact: true }).last().click()
  await page.getByRole("button", { name: "Back", exact: true }).last().click()
  await tab("Lens")
  await page.locator('[data-yep="modes"] button').nth(4).click()
  await runTour("conversation", true)

  await tab("Passport")
  const codes = [
    "BN",
    "KH",
    "ID",
    "LA",
    "MY",
    "MM",
    "PH",
    "SG",
    "TH",
    "TL",
    "VN",
  ]
  for (const code of codes) {
    await page.locator("header").first().locator("button").first().click()
    const overlay = page.locator('div[class*="absolute inset-0 z-40"]').last()
    if (code === "VN") {
      await overlay.getByRole("button", { name: /From/ }).click()
      await overlay.locator(".grid.grid-cols-4 button").nth(8).click() // TH origin allows VN destination.
      await overlay.getByRole("button", { name: /To/ }).click()
    }
    await overlay
      .locator(".grid.grid-cols-4 button")
      .nth(codes.indexOf(code))
      .click()
    await overlay.getByRole("button", { name: "Back", exact: true }).click()
    const mascot = page.locator(
      `[data-yep-guide="passport"] [data-mascot-country="${code}"]`,
    )
    await mascot.waitFor()
    await page.waitForFunction(
      (code) =>
        document.querySelector(
          `[data-yep-guide="passport"] [data-mascot-country="${code}"] img`,
        )?.naturalWidth > 0,
      code,
    )
    await measure(`passport-heritage-${code}`)
    await snap(`passport-${code}-390`)
  }

  await tab("Today")
  await page
    .getByRole("button", { name: "Profile", exact: true })
    .last()
    .click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await runTour("help", true)
  await page.getByRole("button", { name: "About YapYep", exact: true }).click()
  await measure("about-390")
  await snap("about-390")

  // Final check: a simulated keyboard shrink, not a physical-device keyboard test.
  await page.getByRole("button", { name: "Back", exact: true }).last().click()
  await page.locator('[data-yep-guide="help"] [data-yep-replay]').click()
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, "height", {
      configurable: true,
      value: innerHeight * 0.5,
    })
    visualViewport.dispatchEvent(new Event("resize"))
  })
  await page.locator(".yep-tour").waitFor({ state: "detached" })
  assert.equal(
    await page
      .locator("body")
      .evaluate((el) => el.classList.contains("driver-active")),
    false,
  )
  results.push({ name: "simulated-keyboard-resize-closes-tour", pass: true })

  assert.deepEqual(errors, [], "browser runtime errors")
  assert.equal(apiCalls.length, 0, "tours must not call AI APIs")
  writeFileSync(
    `${OUT}/ui-results.json`,
    JSON.stringify({ status: "PASS", results, errors, apiCalls }, null, 2),
  )
  console.log(
    `PASS ${results.length} UI measurements/checks; no runtime errors or AI calls`,
  )
} catch (error) {
  await snap("failure").catch(() => {})
  writeFileSync(
    `${OUT}/ui-results.json`,
    JSON.stringify(
      { status: "FAIL", reason: error.message, results, errors, apiCalls },
      null,
      2,
    ),
  )
  throw error
} finally {
  await browser.close()
}
