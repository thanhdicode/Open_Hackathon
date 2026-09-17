import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from '@playwright/test';

// Run after pnpm build. A local fixture API proves responses are not cached.
const dist = resolve('dist');
let workerVersion = 1;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/v1/')) { response.setHeader('Content-Type', 'application/json'); response.end('{"private":"fixture"}'); return; }
    const path = resolve(dist, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!path.startsWith(dist + sep)) { response.writeHead(403).end(); return; }
    await stat(path);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
    response.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-store');
    let body = await readFile(path);
    if (url.pathname === '/sw.js') body = Buffer.concat([body, Buffer.from(`\n// QA worker revision ${workerVersion}\n`)]);
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
  // Do not touch real services or sessions in this offline shell check.
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin);
  const manifest = await (await page.request.get(`${origin}/manifest.webmanifest`)).json();
  assert.equal(manifest.name, 'YapYep'); assert.equal(manifest.id, '/');
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.scope, '/');
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512', '512x512']);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  assert.equal(await page.getByRole('button', { name: 'Install YapYep', exact: true }).count(), 0, 'No install request during first-load onboarding');
  await page.evaluate(async () => {
    assertResponse(await fetch('/v1/account'));
    assertResponse(await fetch('/v1/functions/ai', { method: 'POST', body: 'fixture' }));
    function assertResponse(response) { if (!response.ok) throw Error('fixture API unavailable'); }
  });
  const keys = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)))).flat());
  assert.ok(keys.some((url) => new URL(url).pathname === '/index.html'));
  assert.ok(keys.some((url) => new URL(url).pathname === '/brand/yep-heritage-v1.png'));
  assert.ok(keys.some((url) => new URL(url).pathname === '/brand/yep-states-v1.png'));
  assert.ok(keys.every((url) => !url.includes('/v1/') && !url.includes('/demo-media/')), 'Private/API/media resources excluded');
  workerVersion = 2;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
  assert.ok(await page.getByTestId('onboarding').count(), 'Waiting update must not force reload/navigation');
  await context.setOffline(true);
  await page.reload();
  await page.getByTestId('onboarding').waitFor();
  await page.getByText('You’re offline.', { exact: false }).waitFor();
  const privateOffline = await page.evaluate(async () => {
    try { const result = await fetch('/v1/account'); return result.ok; } catch { return false; }
  });
  assert.equal(privateOffline, false, 'Private response must not be served offline');
  console.log('PASS: manifest, first-load install gating, controlled shell reload, static-only caches, waiting update without forced reload, offline shell/private API exclusion');
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
