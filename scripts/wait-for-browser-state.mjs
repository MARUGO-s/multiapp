// Poll evaluated async browser state; Playwright waitForFunction polls Promises as truthy.
import { setTimeout as delay } from 'node:timers/promises';

export async function waitForBrowserState(page, predicate, { timeout = 12000, interval = 25 } = {}) {
  const deadline = performance.now() + timeout;
  const timeoutError = () => new Error('Timed out waiting for committed browser state');
  let expired = false;
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(timeoutError()); }, timeout);
  });
  const poll = async () => {
    while (!expired) {
      const snapshot = await page.evaluate(predicate);
      if (expired || performance.now() >= deadline) throw timeoutError();
      if (snapshot) return snapshot;
      await delay(Math.min(interval, Math.max(0, deadline - performance.now())));
    }
    throw timeoutError();
  };
  try {
    return await Promise.race([poll(), limit]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}
