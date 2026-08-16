#!/usr/bin/env node
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { cursorRoot, readJson, writeJsonAtomic } from './payload/token-saver/lib.mjs';

function parseArgs(argv) {
  return { dryRun: argv.includes('--dry-run'), purgeData: argv.includes('--purge-data') };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = cursorRoot();
  const hooksFile = path.join(root, 'hooks.json');
  const hookScript = path.join(root, 'hooks', 'token-budget.mjs');
  const skillDir = path.join(root, 'skills', 'token-handoff');
  const saverDir = path.join(root, 'token-saver');
  const installedUtilities = [
    'lib.mjs',
    'token-saverctl.mjs',
    'select-context.mjs',
    'capped-command.mjs',
    'save-handoff.mjs',
    'config.json',
    'install-manifest.json',
  ].map((name) => path.join(saverDir, name));
  if (options.dryRun) {
    console.log(JSON.stringify({ hooksFile, hookScript, skillDir, installedUtilities, purgeData: options.purgeData }, null, 2));
    return;
  }

  const hooks = await readJson(hooksFile, null);
  if (hooks?.hooks) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(saverDir, 'backups', `uninstall-${stamp}`, 'hooks.json');
    await mkdir(path.dirname(backup), { recursive: true });
    await copyFile(hooksFile, backup);
    for (const [event, entries] of Object.entries(hooks.hooks)) {
      if (!Array.isArray(entries)) continue;
      hooks.hooks[event] = entries.filter((entry) => !String(entry?.command || '').includes('token-budget.mjs'));
      if (!hooks.hooks[event].length) delete hooks.hooks[event];
    }
    await writeJsonAtomic(hooksFile, hooks);
  }
  await rm(hookScript, { force: true });
  await rm(skillDir, { recursive: true, force: true });
  if (options.purgeData) await rm(saverDir, { recursive: true, force: true });
  else for (const file of installedUtilities) await rm(file, { force: true });
  console.log(`Cursor Cost Guard uninstalled.${options.purgeData ? ' State, handoffs, logs, and backups were removed.' : ' State, handoffs, logs, and backups were retained.'}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
