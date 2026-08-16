import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function run(script, root, args = []) {
  const result = spawnSync(process.execPath, [path.join(projectRoot, script), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, CURSOR_CONFIG_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('installer merges hooks and uninstaller preserves unrelated hooks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-install-'));
  await mkdir(root, { recursive: true });
  const original = {
    version: 1,
    hooks: {
      beforeSubmitPrompt: [{ command: './hooks/existing.sh' }],
      afterFileEdit: [{ command: './hooks/format.sh' }],
    },
  };
  await writeFile(path.join(root, 'hooks.json'), `${JSON.stringify(original, null, 2)}\n`);
  try {
    run('install.mjs', root, ['--profile', 'individual']);
    const installed = JSON.parse(await readFile(path.join(root, 'hooks.json'), 'utf8'));
    assert.equal(installed.hooks.beforeSubmitPrompt.filter((entry) => entry.command === './hooks/existing.sh').length, 1);
    assert.equal(installed.hooks.beforeSubmitPrompt.filter((entry) => entry.command.includes('token-budget.mjs')).length, 1);
    for (const event of ['preToolUse', 'postToolUseFailure', 'afterAgentThought', 'subagentStart', 'subagentStop']) {
      assert.equal(installed.hooks[event].filter((entry) => entry.command.includes('token-budget.mjs')).length, 1);
    }
    assert.equal(installed.hooks.afterFileEdit.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(root, 'token-saver', 'config.json'), 'utf8')).billingProfile, 'individual');
    assert.match(await readFile(path.join(root, 'skills', 'token-handoff', 'SKILL.md'), 'utf8'), /disable-model-invocation: true/);

    run('uninstall.mjs', root);
    const uninstalled = JSON.parse(await readFile(path.join(root, 'hooks.json'), 'utf8'));
    assert.deepEqual(uninstalled.hooks.beforeSubmitPrompt, [{ command: './hooks/existing.sh' }]);
    assert.deepEqual(uninstalled.hooks.afterFileEdit, [{ command: './hooks/format.sh' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dry-run performs no writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-dry-'));
  try {
    run('install.mjs', root, ['--dry-run']);
    await assert.rejects(readFile(path.join(root, 'hooks.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installer defaults to observation and migrates untouched 0.1 limits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-migrate-'));
  await mkdir(path.join(root, 'token-saver'), { recursive: true });
  await writeFile(path.join(root, 'token-saver', 'config.json'), `${JSON.stringify({
    packageVersion: '0.1.0',
    charsPerToken: 4,
    hardMaximumTurnsWithoutCompaction: 35,
    maxProjectedCacheReadCostPerTurnUsd: 0.1,
    maxProjectedTotalCostPerTurnUsd: 0.3,
    maxSingleAttachmentBytes: 524288,
    maxTotalAttachmentBytes: 1048576,
    maxDirectFileReadBytes: 524288,
    customSettingPreserved: true,
  }, null, 2)}\n`);
  try {
    run('install.mjs', root, ['--profile', 'teams-third-party']);
    const config = JSON.parse(await readFile(path.join(root, 'token-saver', 'config.json'), 'utf8'));
    assert.equal(config.packageVersion, '0.5.0');
    assert.equal(config.mode, 'observe');
    assert.equal(config.charsPerToken, 3);
    assert.equal(config.hardMaximumTurnsWithoutCompaction, 35);
    assert.equal(config.maxEstimatedCarriedTokens, 80000);
    assert.equal(config.maxProjectedCacheReadCostPerTurnUsd, 0.02);
    assert.equal(config.maxSingleAttachmentBytes, 131072);
    assert.equal(config.customSettingPreserved, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('upgrade from 0.2 preserves user limits and unrelated configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-upgrade-'));
  await mkdir(path.join(root, 'token-saver'), { recursive: true });
  await writeFile(path.join(root, 'token-saver', 'config.json'), `${JSON.stringify({
    packageVersion: '0.2.0',
    hardMaximumTurnsWithoutCompaction: 14,
    maxEstimatedCarriedTokens: 76543,
    minimumFixedContextTokens: 4321,
    customSettingPreserved: { useful: true },
  }, null, 2)}\n`);
  try {
    run('install.mjs', root, ['--profile', 'teams-third-party']);
    const config = JSON.parse(await readFile(path.join(root, 'token-saver', 'config.json'), 'utf8'));
    assert.equal(config.packageVersion, '0.5.0');
    assert.equal(config.hardMaximumTurnsWithoutCompaction, 14);
    assert.equal(config.maxEstimatedCarriedTokens, 76543);
    assert.equal(config.minimumFixedContextTokens, 4321);
    assert.deepEqual(config.customSettingPreserved, { useful: true });
    assert.equal(config.countToolInputs, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('upgrade from 0.3 migrates only untouched defaults to Luna profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-v030-'));
  await mkdir(path.join(root, 'token-saver'), { recursive: true });
  await writeFile(path.join(root, 'token-saver', 'config.json'), `${JSON.stringify({
    packageVersion: '0.3.0',
    minimumTurnsBeforeCostGate: 8,
    hardMaximumTurnsWithoutCompaction: 20,
    maxEstimatedCarriedTokens: 100000,
    maxMinutesWithoutCompaction: 90,
    minimumTurnsBeforeTimeGate: 12,
    maxProjectedCacheReadCostPerTurnUsd: 0.05,
    maxProjectedTotalCostPerTurnUsd: 0.15,
    maxPromptChars: 12345,
    customSettingPreserved: true,
  }, null, 2)}\n`);
  try {
    run('install.mjs', root, ['--profile', 'teams-third-party']);
    const config = JSON.parse(await readFile(path.join(root, 'token-saver', 'config.json'), 'utf8'));
    assert.equal(config.packageVersion, '0.5.0');
    assert.equal(config.minimumTurnsBeforeCostGate, 0);
    assert.equal(config.hardMaximumTurnsWithoutCompaction, 35);
    assert.equal(config.maxEstimatedCarriedTokens, 80000);
    assert.equal(config.maxProjectedCacheReadCostPerTurnUsd, 0.02);
    assert.equal(config.maxPromptChars, 12345);
    assert.equal(config.customSettingPreserved, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('upgrade from 0.4 adds Fast models and leaves legacy Max pricing disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-v040-'));
  await mkdir(path.join(root, 'token-saver'), { recursive: true });
  await writeFile(path.join(root, 'token-saver', 'config.json'), `${JSON.stringify({
    packageVersion: '0.4.0',
    maxEstimatedSessionCostUsd: 0.75,
    customSettingPreserved: true,
  }, null, 2)}\n`);
  try {
    run('install.mjs', root, ['--profile', 'teams-third-party']);
    const config = JSON.parse(await readFile(path.join(root, 'token-saver', 'config.json'), 'utf8'));
    assert.equal(config.packageVersion, '0.5.0');
    assert.equal(config.maxEstimatedSessionCostUsd, 0.75);
    assert.equal(config.legacyMaxModePricingEnabled, false);
    assert.equal(config.models['gpt-5.6-luna-fast'].output, 2.4);
    assert.equal(config.models['gpt-5.6-terra-fast'].output, 24);
    assert.equal(config.models['gpt-5.6-sol-fast'].output, 60);
    assert.equal(config.customSettingPreserved, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
