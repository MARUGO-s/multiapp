import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForBrowserState } from '../scripts/wait-for-browser-state.mjs';

test('async browser polling awaits false observations and returns the successful snapshot', async () => {
  let reads = 0;
  const page = { evaluate: async (predicate) => await predicate() };
  const result = await waitForBrowserState(page, async () => {
    await Promise.resolve();
    return ++reads < 3 ? false : { files: ['original'], revision: 3 };
  }, { timeout: 1000, interval: 1 });
  assert.deepEqual(result, { files: ['original'], revision: 3 });
  assert.equal(reads, 3);
});
test('async browser polling rejects an unresolved observation and a truthy result after the overall deadline', async () => {
  const pending = { evaluate: () => new Promise(() => {}) };
  await assert.rejects(waitForBrowserState(pending, () => true, { timeout: 10, interval: 1 }), /Timed out/);
  const late = { evaluate: () => new Promise(resolve => setTimeout(() => resolve({ files: ['late'] }), 30)) };
  await assert.rejects(waitForBrowserState(late, () => true, { timeout: 5, interval: 1 }), /Timed out/);
});

test('async browser polling fails closed on deadline and evaluation errors', async () => {
  const page = { evaluate: async (predicate) => await predicate() };
  await assert.rejects(waitForBrowserState(page, async () => false, { timeout: 5, interval: 1 }), /Timed out/);
  await assert.rejects(waitForBrowserState(page, async () => { throw Error('storage failed'); }), /storage failed/);
});
