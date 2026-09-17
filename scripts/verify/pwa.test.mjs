import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/pwa.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const pwa = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
test('install cooldown survives unavailable storage and expires after seven days', () => {
  const now = Date.now();
  assert.equal(pwa.installationDismissed(now, { getItem: () => String(now - 1000) }), true);
  assert.equal(pwa.installationDismissed(now, { getItem: () => String(now - pwa.INSTALL_COOLDOWN_MS) }), false);
  assert.equal(pwa.installationDismissed(now, { getItem: () => null }), false);
  assert.equal(pwa.installationDismissed(now, { getItem: () => { throw Error('blocked'); } }), false);
  assert.doesNotThrow(() => pwa.dismissInstallation({ setItem: () => { throw Error('blocked'); } }));
});
test('iOS installation instructions also cover desktop-identifying iPads', () => {
  assert.equal(pwa.isIosBrowser('iPhone Safari', 'iPhone', 5), true);
  assert.equal(pwa.isIosBrowser('Macintosh Safari', 'MacIntel', 5), true);
  assert.equal(pwa.isIosBrowser('Macintosh Safari', 'MacIntel', 0), false);
  assert.equal(pwa.isIosBrowser('Android Chrome', 'Linux', 5), false);
});
