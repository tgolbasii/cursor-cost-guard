#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cursorRoot,
  DEFAULT_CONFIG,
  deepMerge,
  exists,
  loadConfig,
  pathsFor,
  readJson,
  validateConfig,
  writeJsonAtomic,
} from './lib.mjs';

const root = cursorRoot();
const paths = pathsFor(root);

function usage(exitCode = 0) {
  const text = `Cursor Cost Guard control

Usage:
  token-saverctl.mjs status [--all]
  token-saverctl.mjs observe
  token-saverctl.mjs enforce
  token-saverctl.mjs enable
  token-saverctl.mjs disable
  token-saverctl.mjs reset [--all]
  token-saverctl.mjs validate-config
  token-saverctl.mjs profile <individual|teams-third-party|auto-cost|cursor-model>
  token-saverctl.mjs prices
`;
  process[exitCode ? 'stderr' : 'stdout'].write(text);
  process.exitCode = exitCode;
}

async function stateFiles() {
  try {
    const names = await readdir(paths.state);
    const records = [];
    for (const name of names.filter((value) => value.endsWith('.json'))) {
      const file = path.join(paths.state, name);
      const state = await readJson(file, null);
      if (state) records.push({ file, state });
    }
    return records.sort((a, b) => String(b.state.lastSeenAt).localeCompare(String(a.state.lastSeenAt)));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function summarizeState(record) {
  const state = record.state;
  return {
    conversationHash: state.conversationHash,
    lastSeenAt: state.lastSeenAt,
    promptsSinceCompaction: state.promptsSinceCompaction,
    acceptedPromptsTotal: state.acceptedPromptsTotal,
    toolCallsTotal: state.toolCallsTotal,
    toolCallsStartedTotal: state.toolCallsStartedTotal || 0,
    toolCallsSucceededTotal: state.toolCallsSucceededTotal || 0,
    toolCallsFailedTotal: state.toolCallsFailedTotal || 0,
    toolCallsDeniedTotal: state.toolCallsDeniedTotal || 0,
    toolCallsCurrentTurn: state.toolCallsCurrentTurn || 0,
    toolCharsCurrentTurn:
      (state.toolInputCharsCurrentTurn || 0) +
      (state.toolOutputCharsCurrentTurn || 0) +
      (state.failedToolCharsCurrentTurn || 0),
    estimatedIntraTurnCacheReadCostUsd: state.estimatedIntraTurnCacheReadCostUsd || 0,
    estimatedInternalCacheReadCostUsd: state.estimatedInternalCacheReadCostUsd || 0,
    lastToolGate: state.lastToolGate || null,
    subagentStartsTotal: state.subagentStartsTotal || 0,
    subagentStopsTotal: state.subagentStopsTotal || 0,
    subagentsActive: state.subagentsActive || 0,
    totalToolInputChars: state.totalToolInputChars || 0,
    totalToolOutputChars: state.totalToolChars || 0,
    totalFailedToolChars: state.totalFailedToolChars || 0,
    totalThinkingChars: state.totalThinkingChars || 0,
    calibratedFixedContextTokens: state.calibratedFixedContextTokens || 0,
    postCompactionFloorTokens: state.postCompactionFloorTokens || 0,
    lastObservedContextTokens: state.lastObservedContextTokens ?? null,
    calibrationCount: state.calibrationCount || 0,
    compactionCount: state.compactions?.length || 0,
    lastModel: state.lastModel,
    currentReasoningEffort: state.currentReasoningEffort || null,
    lastReasoningEffort: state.lastReasoningEffort || null,
    sampledOutputProfiles: Object.keys(state.outputTokenSamplesByProfile || {}),
    estimatedSessionCostUsd: state.estimatedSessionCostUsd || 0,
    estimatedCacheReadCostUsd: state.estimatedCacheReadCostUsd || 0,
    estimatedNewInputCostUsd: state.estimatedNewInputCostUsd || 0,
    estimatedOutputCostUsd: state.estimatedOutputCostUsd || 0,
    lastEstimate: state.lastEstimate,
  };
}

async function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || command === '-h') return usage();
  if (command === 'enable') {
    await rm(paths.disabled, { force: true });
    console.log('Cursor Cost Guard enabled.');
    return;
  }
  if (command === 'observe' || command === 'enforce') {
    const existing = (await readJson(paths.config, {})) || {};
    await writeJsonAtomic(paths.config, deepMerge(DEFAULT_CONFIG, { ...existing, mode: command }));
    console.log(`Cursor Cost Guard mode set to ${command}.`);
    return;
  }
  if (command === 'disable') {
    await mkdir(paths.saver, { recursive: true });
    await writeFile(paths.disabled, `${new Date().toISOString()}\n`, 'utf8');
    console.log(`Cursor Cost Guard disabled via ${paths.disabled}`);
    return;
  }
  if (command === 'validate-config') {
    const config = await loadConfig(root);
    const errors = validateConfig(config);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`Valid config: ${paths.config}`);
    }
    return;
  }
  if (command === 'profile') {
    const profile = args[0];
    const allowed = ['individual', 'teams-third-party', 'auto-cost', 'cursor-model'];
    if (!allowed.includes(profile)) throw new Error(`Profile must be one of: ${allowed.join(', ')}`);
    const existing = (await readJson(paths.config, {})) || {};
    await writeJsonAtomic(paths.config, deepMerge(DEFAULT_CONFIG, { ...existing, billingProfile: profile }));
    console.log(`Billing profile set to ${profile}.`);
    return;
  }
  if (command === 'prices') {
    const config = await loadConfig(root);
    console.log(JSON.stringify({
      pricingUpdatedAt: config.pricingUpdatedAt,
      pricingSource: config.pricingSource,
      billingProfile: config.billingProfile,
      models: config.models,
    }, null, 2));
    return;
  }
  if (command === 'status') {
    const records = await stateFiles();
    const selected = args.includes('--all') ? records : records.slice(0, 1);
    console.log(JSON.stringify({
      enabled: !(await exists(paths.disabled)),
      root,
      config: await loadConfig(root),
      conversations: selected.map(summarizeState),
    }, null, 2));
    return;
  }
  if (command === 'reset') {
    const records = await stateFiles();
    const selected = args.includes('--all') ? records : records.slice(0, 1);
    for (const record of selected) await rm(record.file, { force: true });
    console.log(`Reset ${selected.length} conversation state file(s).`);
    return;
  }
  usage(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
