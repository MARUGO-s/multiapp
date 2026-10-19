// Read-only static smoke. Every API request is intercepted; no business writes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

const root = resolve('dist');
let server;
const origin = process.env.DOMAIN_SMOKE_URL || await new Promise(resolveOrigin => {
  server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = resolve(root, '.' + path);
      if (!file.startsWith(root + '/')) throw new Error('invalid path');
      const data = await readFile(file);
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  }).listen(0, '127.0.0.1', () => resolveOrigin(`http://127.0.0.1:${server.address().port}/`));
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [], failedAssets = [], intercepted = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('response', res => { if (res.status() >= 400 && new URL(res.url()).origin === new URL(origin).origin) failedAssets.push(res.url()); });
    await page.route('https://*.supabase.co/**', async route => {
      intercepted.push({ method: route.request().method(), path: new URL(route.request().url()).pathname });
      const scan = route.request().url().endsWith('/scan');
      await route.fulfill({ status: scan ? 410 : 404, contentType: 'application/json', body: JSON.stringify({ error: scan ? '検証用QRは停止中です' : '検証用ファイルはありません' }) });
    });
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'ログインして開く', exact: true }).waitFor();
    await page.getByPlaceholder('ログインIDを入力').fill('domain-smoke-no-submit');
    assert.equal(await page.getByPlaceholder('ログインIDを入力').inputValue(), 'domain-smoke-no-submit');
    assert.equal(intercepted.length, 0, 'logged-out UI must not issue business API calls');
    await page.goto(new URL('?s=q#DomainTest12', origin).href, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'このQRコードは停止中です', exact: true }).waitFor();
    assert.equal(intercepted.filter(x => x.path.endsWith('/scan')).length, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(failedAssets, []);
    results.push({ viewport, loginRendered: true, inputRetained: true, trackingScriptLoaded: true, realBusinessWrites: 0 });
    await context.close();
  }
  console.log(JSON.stringify({ origin, results }, null, 2));
} finally {
  await browser.close();
  if (server) await new Promise(done => server.close(done));
}
