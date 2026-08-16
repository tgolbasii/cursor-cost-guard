#!/usr/bin/env node
import { copyFile, chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cursorRoot,
  DEFAULT_CONFIG,
  deepMerge,
  PACKAGE_VERSION,
  readJson,
  validateConfig,
  writeJsonAtomic,
} from './payload/token-saver/lib.mjs';

const EVENTS = [
  'sessionStart',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'afterAgentThought',
  'afterAgentResponse',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'beforeReadFile',
  'sessionEnd',
];

const V010_DEFAULTS = Object.freeze({
  charsPerToken: 4,
  hardMaximumTurnsWithoutCompaction: 35,
  maxProjectedCacheReadCostPerTurnUsd: 0.1,
  maxProjectedTotalCostPerTurnUsd: 0.3,
  maxSingleAttachmentBytes: 524288,
  maxTotalAttachmentBytes: 1048576,
  maxDirectFileReadBytes: 524288,
});

const V020_V030_DEFAULTS = Object.freeze({
  minimumTurnsBeforeCostGate: 8,
  hardMaximumTurnsWithoutCompaction: 20,
  maxEstimatedCarriedTokens: 100000,
  maxMinutesWithoutCompaction: 90,
  minimumTurnsBeforeTimeGate: 12,
  maxProjectedCacheReadCostPerTurnUsd: 0.05,
  maxProjectedTotalCostPerTurnUsd: 0.15,
});

function migrateKnownDefaults(existing) {
  const migrated = structuredClone(existing || {});
  const knownDefaults =
    migrated.packageVersion === '0.1.0' || !migrated.packageVersion
      ? V010_DEFAULTS
      : ['0.2.0', '0.3.0'].includes(migrated.packageVersion)
        ? V020_V030_DEFAULTS
        : null;
  for (const [key, oldDefault] of Object.entries(knownDefaults || {})) {
    if (migrated[key] === oldDefault) delete migrated[key];
  }
  return migrated;
}

function parseArgs(argv) {
  const options = { profile: 'teams-third-party', mode: 'observe', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--profile') options.profile = argv[++index];
    else if (value === '--observe') options.mode = 'observe';
    else if (value === '--enforce') options.mode = 'enforce';
    else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  const profiles = ['individual', 'teams-third-party', 'auto-cost', 'cursor-model'];
  if (!profiles.includes(options.profile)) throw new Error(`--profile must be one of: ${profiles.join(', ')}`);
  return options;
}

function usage() {
  console.log(`Install Cursor Cost Guard

Usage: node install.mjs [options]
  --profile <name>  individual | teams-third-party | auto-cost | cursor-model
  --observe         collect estimates without blocking (default)
  --enforce         block requests that exceed configured limits
  --dry-run         show targets without writing
`);
}

function hookDefinition(event, root) {
  const definition = { command: `node ${path.join(root, 'hooks', 'token-budget.mjs')}`, timeout: 5 };
  if (event === 'beforeSubmitPrompt') definition.matcher = 'UserPromptSubmit';
  if (event === 'beforeReadFile') definition.matcher = 'Read';
  if (event === 'beforeSubmitPrompt' || event === 'beforeReadFile') definition.failClosed = false;
  return definition;
}

function mergeHooks(existing, root) {
  const result = existing && typeof existing === 'object' ? structuredClone(existing) : {};
  result.version ||= 1;
  result.hooks ||= {};
  for (const event of EVENTS) {
    const current = Array.isArray(result.hooks[event]) ? result.hooks[event] : [];
    result.hooks[event] = [
      ...current.filter((entry) => !String(entry?.command || '').includes('token-budget.mjs')),
      hookDefinition(event, root),
    ];
  }
  return result;
}

async function copyWithMode(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  await chmod(target, 0o755).catch(() => {});
}

async function backupIfPresent(target, backupRoot) {
  try {
    await readFile(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const relative = path.relative(cursorRoot(), target);
  const backup = path.join(backupRoot, relative);
  await mkdir(path.dirname(backup), { recursive: true });
  await copyFile(target, backup);
  return backup;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return usage();
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`Node 20+ is required; found ${process.version}`);

  const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
  const root = cursorRoot();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(root, 'token-saver', 'backups', `install-${stamp}`);
  const targets = {
    hook: path.join(root, 'hooks', 'token-budget.mjs'),
    lib: path.join(root, 'token-saver', 'lib.mjs'),
    ctl: path.join(root, 'token-saver', 'token-saverctl.mjs'),
    select: path.join(root, 'token-saver', 'select-context.mjs'),
    capped: path.join(root, 'token-saver', 'capped-command.mjs'),
    handoff: path.join(root, 'token-saver', 'save-handoff.mjs'),
    skill: path.join(root, 'skills', 'token-handoff', 'SKILL.md'),
    config: path.join(root, 'token-saver', 'config.json'),
    hooksConfig: path.join(root, 'hooks.json'),
    manifest: path.join(root, 'token-saver', 'install-manifest.json'),
  };
  if (options.dryRun) {
    console.log(JSON.stringify({ root, profile: options.profile, mode: options.mode, targets }, null, 2));
    return;
  }

  await mkdir(backupRoot, { recursive: true });
  const backups = [];
  for (const target of Object.values(targets).filter((value) => value !== targets.manifest)) {
    const backup = await backupIfPresent(target, backupRoot);
    if (backup) backups.push(backup);
  }

  const sources = {
    hook: path.join(sourceRoot, 'payload', 'hooks', 'token-budget.mjs'),
    lib: path.join(sourceRoot, 'payload', 'token-saver', 'lib.mjs'),
    ctl: path.join(sourceRoot, 'payload', 'token-saver', 'token-saverctl.mjs'),
    select: path.join(sourceRoot, 'payload', 'token-saver', 'select-context.mjs'),
    capped: path.join(sourceRoot, 'payload', 'token-saver', 'capped-command.mjs'),
    handoff: path.join(sourceRoot, 'payload', 'token-saver', 'save-handoff.mjs'),
    skill: path.join(sourceRoot, 'payload', 'skills', 'token-handoff', 'SKILL.md'),
  };
  for (const key of ['hook', 'lib', 'ctl', 'select', 'capped', 'handoff', 'skill']) {
    await copyWithMode(sources[key], targets[key]);
  }

  const existingConfig = (await readJson(targets.config, {})) || {};
  const config = deepMerge(DEFAULT_CONFIG, migrateKnownDefaults(existingConfig));
  config.billingProfile = options.profile;
  config.mode = options.mode;
  config.packageVersion = PACKAGE_VERSION;
  const configErrors = validateConfig(config);
  if (configErrors.length) throw new Error(`Generated invalid config: ${configErrors.join('; ')}`);
  await writeJsonAtomic(targets.config, config);

  const hooks = mergeHooks(await readJson(targets.hooksConfig, {}), root);
  await writeJsonAtomic(targets.hooksConfig, hooks);
  await mkdir(path.join(root, 'token-saver', 'state'), { recursive: true });
  await mkdir(path.join(root, 'token-saver', 'handoffs'), { recursive: true });
  await mkdir(path.join(root, 'token-saver', 'logs'), { recursive: true });

  await writeJsonAtomic(targets.manifest, {
    version: 1,
    packageVersion: PACKAGE_VERSION,
    installedAt: new Date().toISOString(),
    root,
    billingProfile: options.profile,
    mode: options.mode,
    hookCommand: `node ${targets.hook}`,
    installedFiles: Object.values(targets).filter((value) => value !== targets.hooksConfig),
    backupRoot,
    backups,
  });

  console.log(`Cursor Cost Guard ${PACKAGE_VERSION} installed.`);
  console.log(`Billing profile: ${options.profile}`);
  console.log(`Mode: ${options.mode}`);
  console.log(`Config: ${targets.config}`);
  console.log(`Validate: node ${targets.ctl} validate-config`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
