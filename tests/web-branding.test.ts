import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('browser tab title is exactly ZoeyBot', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.equal(html.match(/<title>([^<]+)<\/title>/)?.[1], 'ZoeyBot');
});
