import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('caption canvas and workflow browser regressions have one repeatable command', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:qr-caption-browser'],
    'node scripts/test-qr-caption-browser.mjs && node scripts/test-qr-caption-ui-browser.mjs');
});

test('Pages runs the persisted store-name API regression', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const commands = workflow.split('\n').filter((line) => /^\s*- run: deno test\b/.test(line));
  assert.ok(commands.some((line) => line.includes('tests/cloud-qr-store-name.test.ts')),
    'the store-name API regression must run in the published Pages build');
});
