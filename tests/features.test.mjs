import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { refreshBilling } from '../payload/token-saver/billing.mjs';

test('billing refresh normalizes usage and quota data without storing the token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-billing-'));
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-token');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ usage: { usedUsd: 1.25, limitUsd: 5, quotaUsed: 12, quotaLimit: 500, resetAt: '2026-09-01T00:00:00Z' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await writeFile(path.join(root, 'token-saver-config.json'), '');
    await writeFile(path.join(root, 'config.json'), '');
    await import('../payload/token-saver/lib.mjs').then(({ writeJsonAtomic, pathsFor, DEFAULT_CONFIG }) =>
      writeJsonAtomic(pathsFor(root).config, { ...DEFAULT_CONFIG, billing: { endpoint: `http://127.0.0.1:${port}`, tokenEnv: 'TEST_CURSOR_TOKEN', timeoutMs: 1000 } }));
    process.env.TEST_CURSOR_TOKEN = 'test-token';
    const result = await refreshBilling(root);
    assert.equal(result.usedUsd, 1.25);
    assert.equal(result.quotaLimit, 500);
    assert.doesNotMatch(await readFile(path.join(root, 'token-saver', 'billing.json'), 'utf8'), /test-token/);
  } finally {
    delete process.env.TEST_CURSOR_TOKEN;
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
