import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadConfigFromFile } from 'vite';

async function base(mode, configuredBase) {
  const previous = process.env.VITE_BASE_PATH;
  try {
    if (configuredBase === undefined) delete process.env.VITE_BASE_PATH;
    else process.env.VITE_BASE_PATH = configuredBase;
    const result = await loadConfigFromFile({ command: mode === 'production' ? 'build' : 'serve', mode }, 'vite.config.ts');
    return result.config.base;
  } finally {
    if (previous === undefined) delete process.env.VITE_BASE_PATH;
    else process.env.VITE_BASE_PATH = previous;
  }
}

test('custom-domain production assets default to the domain root', async () => {
  assert.equal(await base('production'), '/');
});

test('a GitHub project-site build can explicitly retain its project prefix', async () => {
  assert.equal(await base('production', '/multiapp/'), '/multiapp/');
});

test('local development stays at root even with a production prefix', async () => {
  assert.equal(await base('development', '/multiapp/'), '/');
});

test('Pages resolves the actual site base before building and runs domain regressions', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('uses: actions/configure-pages@v5') < workflow.indexOf('run: npm run check'));
  assert.match(workflow, /id: pages\s+uses: actions\/configure-pages@v5/);
  assert.ok(workflow.includes('VITE_BASE_PATH: ${{ steps.pages.outputs.base_path }}/'));
  assert.ok(workflow.split('\n').some(line => /^\s*- run: deno test/.test(line) && line.includes('tests/cloud-custom-domain.test.ts')));
});
