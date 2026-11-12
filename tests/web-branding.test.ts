import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Bot HQ browser tab uses the requested ZoeyBot title', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.equal(html.match(/<title>([^<]+)<\/title>/)?.[1], 'ZoeyBot');
});
