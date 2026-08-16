import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const saver = path.join(projectRoot, 'payload', 'token-saver');

test('manual skill is concise and manually invoked', async () => {
  const text = await readFile(path.join(projectRoot, 'payload', 'skills', 'token-handoff', 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: token-handoff\n/m);
  assert.match(text, /disable-model-invocation: true/);
  assert.ok(text.split(/\r?\n/).length < 100);
});

test('save-handoff validates headings and persists bounded content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-handoff-'));
  const content = `# Current goal\nShip guard\n# Accepted decisions\nMechanical first\n# Modified files\n- hook\n# Validation completed\n- tests\n# Unresolved issues\n- none\n# Next action\nInstall\n`;
  try {
    const result = spawnSync(process.execPath, [path.join(saver, 'save-handoff.mjs')], {
      input: content,
      encoding: 'utf8',
      env: { ...process.env, CURSOR_TOKEN_SAVER_HOME: root },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim();
    assert.equal(await readFile(output, 'utf8'), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('select-context returns bounded matching passages', async (t) => {
  if (spawnSync('rg', ['--version']).status !== 0) return t.skip('rg unavailable');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-select-'));
  await writeFile(path.join(root, 'sample.txt'), 'alpha\nneedle one\nbeta\nneedle two\ngamma\n');
  try {
    const result = spawnSync(process.execPath, [path.join(saver, 'select-context.mjs'), '--context', '0', '--max-matches', '1', 'needle', root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /needle one/);
    assert.doesNotMatch(result.stdout, /needle two/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capped-command limits returned output and preserves full log', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-cap-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(saver, 'capped-command.mjs'),
      '--max-chars', '1000', '--',
      process.execPath, '-e', 'process.stdout.write("x".repeat(5000))',
    ], {
      encoding: 'utf8',
      env: { ...process.env, CURSOR_TOKEN_SAVER_HOME: root },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /characters omitted/);
    assert.ok(result.stdout.length < 1300);
    const logs = await readdir(path.join(root, 'token-saver', 'logs'));
    const full = await readFile(path.join(root, 'token-saver', 'logs', logs[0]), 'utf8');
    assert.equal(full.length, 5000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
