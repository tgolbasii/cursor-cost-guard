import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PACKAGE_VERSION = '0.5.0';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  packageVersion: PACKAGE_VERSION,
  pricingUpdatedAt: '2026-08-16',
  pricingSource: 'https://cursor.com/docs/models-and-pricing',
  mode: 'observe',
  billingProfile: 'teams-third-party',
  charsPerToken: 3,
  minimumTurnsBeforeCostGate: 0,
  minimumTurnsBeforeContextualTurnGate: 20,
  minEstimatedCarriedTokensForTurnGate: 60000,
  hardMaximumTurnsWithoutCompaction: 35,
  maxEstimatedCarriedTokens: 80000,
  maxMinutesWithoutCompaction: 120,
  minimumTurnsBeforeTimeGate: 15,
  maxProjectedCacheReadCostPerTurnUsd: 0.02,
  maxProjectedTotalCostPerTurnUsd: 0.04,
  maxEstimatedSessionCostUsd: 0.5,
  minimumToolCallsBeforeIntraTurnCostGate: 8,
  hardMaximumToolCallsPerTurn: 160,
  maxToolCharsPerTurn: 180000,
  maxEstimatedCarriedTokensDuringTurn: 80000,
  maxEstimatedIntraTurnCacheReadCostPerTurnUsd: 0.1,
  defaultExpectedOutputTokens: 2000,
  outputSampleCount: 5,
  countToolInputs: true,
  countFailedToolErrors: true,
  countThoughtsAsOutput: true,
  countThoughtsAsCarriedContext: false,
  calibrateFromPreCompact: true,
  minimumFixedContextTokens: 0,
  preserveCalibratedFloorAfterCompaction: true,
  maxPromptChars: 24000,
  maxSingleAttachmentBytes: 131072,
  maxTotalAttachmentBytes: 262144,
  maxDirectFileReadBytes: 131072,
  regionalDataResidencyUpliftPercent: 0,
  legacyMaxModePricingEnabled: false,
  legacyMaxModeUpliftPercent: 20,
  stateRetentionDays: 14,
  readAllowlistFile: 'token-saver/read-allowlist',
  models: {
    'auto-cost': {
      aliases: ['auto-cost', 'auto cost'],
      input: 1.25,
      cacheWrite: 1.25,
      cacheRead: 0.25,
      output: 6,
      thirdParty: false,
    },
    'composer-2.5-fast': {
      aliases: ['composer-2.5-fast', 'composer 2.5 fast'],
      input: 3,
      cacheWrite: 0,
      cacheRead: 0.5,
      output: 15,
      thirdParty: false,
    },
    'composer-2.5': {
      aliases: ['composer-2.5', 'composer 2.5'],
      input: 0.5,
      cacheWrite: 0,
      cacheRead: 0.2,
      output: 2.5,
      thirdParty: false,
    },
    'grok-4.6-fast': {
      aliases: ['grok-4.6-fast', 'grok 4.6 fast'],
      input: 4,
      cacheWrite: 0,
      cacheRead: 1,
      output: 12,
      thirdParty: false,
    },
    'grok-4.6': {
      aliases: ['grok-4.6', 'grok 4.6'],
      input: 2,
      cacheWrite: 0,
      cacheRead: 0.5,
      output: 6,
      thirdParty: false,
    },
    'grok-4.5-fast': {
      aliases: ['grok-4.5-fast', 'grok 4.5 fast'],
      input: 4,
      cacheWrite: 0,
      cacheRead: 1,
      output: 12,
      thirdParty: false,
    },
    'grok-4.5': {
      aliases: ['grok-4.5', 'grok 4.5'],
      input: 2,
      cacheWrite: 0,
      cacheRead: 0.5,
      output: 6,
      thirdParty: false,
    },
    'claude-fable-5': {
      aliases: ['claude-fable-5', 'claude fable 5', 'fable-5'],
      input: 10,
      cacheWrite: 12.5,
      cacheRead: 1,
      output: 50,
      thirdParty: true,
    },
    'claude-opus-5': {
      aliases: ['claude-opus-5', 'claude opus 5', 'opus-5'],
      input: 5,
      cacheWrite: 6.25,
      cacheRead: 0.5,
      output: 25,
      thirdParty: true,
    },
    'claude-sonnet-5': {
      aliases: ['claude-sonnet-5', 'claude sonnet 5', 'sonnet-5'],
      input: 2,
      cacheWrite: 2.5,
      cacheRead: 0.2,
      output: 10,
      thirdParty: true,
    },
    'gemini-3.1-pro': {
      aliases: ['gemini-3.1-pro', 'gemini 3.1 pro'],
      input: 2,
      cacheWrite: 0,
      cacheRead: 0.2,
      output: 12,
      thirdParty: true,
    },
    'gemini-3.7-flash': {
      aliases: ['gemini-3.7-flash', 'gemini 3.7 flash'],
      input: 0.75,
      cacheWrite: 0,
      cacheRead: 0.075,
      output: 3.5,
      thirdParty: true,
    },
    'gpt-5.6-luna-fast': {
      aliases: ['gpt-5.6-luna-fast', 'gpt 5.6 luna fast'],
      input: 0.4,
      cacheWrite: 0.5,
      cacheRead: 0.04,
      output: 2.4,
      thirdParty: true,
    },
    'gpt-5.6-luna': {
      aliases: ['gpt-5.6-luna', 'gpt 5.6 luna'],
      input: 0.2,
      cacheWrite: 0.25,
      cacheRead: 0.02,
      output: 1.2,
      thirdParty: true,
    },
    'gpt-5.6-sol-fast': {
      aliases: ['gpt-5.6-sol-fast', 'gpt 5.6 sol fast'],
      input: 10,
      cacheWrite: 12.5,
      cacheRead: 1,
      output: 60,
      thirdParty: true,
    },
    'gpt-5.6-sol': {
      aliases: ['gpt-5.6-sol', 'gpt 5.6 sol'],
      input: 5,
      cacheWrite: 6.25,
      cacheRead: 0.5,
      output: 30,
      thirdParty: true,
    },
    'gpt-5.6-terra-fast': {
      aliases: ['gpt-5.6-terra-fast', 'gpt 5.6 terra fast'],
      input: 4,
      cacheWrite: 5,
      cacheRead: 0.4,
      output: 24,
      thirdParty: true,
    },
    'gpt-5.6-terra': {
      aliases: ['gpt-5.6-terra', 'gpt 5.6 terra'],
      input: 2,
      cacheWrite: 2.5,
      cacheRead: 0.2,
      output: 12,
      thirdParty: true,
    },
  },
});

export function cursorRoot() {
  return path.resolve(
    process.env.CURSOR_TOKEN_SAVER_HOME ||
      process.env.CURSOR_CONFIG_DIR ||
      path.join(os.homedir(), '.cursor'),
  );
}

export function pathsFor(root = cursorRoot()) {
  const saver = path.join(root, 'token-saver');
  return {
    root,
    saver,
    config: path.join(saver, 'config.json'),
    disabled: path.join(saver, 'disabled'),
    state: path.join(saver, 'state'),
    logs: path.join(saver, 'logs'),
    handoffs: path.join(saver, 'handoffs'),
  };
}

export function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (!base || typeof base !== 'object') return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    result[key] =
      value && typeof value === 'object' && !Array.isArray(value) &&
      base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
        ? deepMerge(base[key], value)
        : value;
  }
  return result;
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read JSON ${file}: ${error.message}`);
  }
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

export async function loadConfig(root = cursorRoot()) {
  const existing = await readJson(pathsFor(root).config, {});
  return deepMerge(DEFAULT_CONFIG, existing);
}

export function validateConfig(config) {
  const errors = [];
  const positive = [
    'charsPerToken',
    'hardMaximumTurnsWithoutCompaction',
    'maxEstimatedCarriedTokens',
    'maxMinutesWithoutCompaction',
    'maxPromptChars',
    'maxSingleAttachmentBytes',
    'maxTotalAttachmentBytes',
    'maxDirectFileReadBytes',
    'defaultExpectedOutputTokens',
    'outputSampleCount',
    'stateRetentionDays',
    'hardMaximumToolCallsPerTurn',
    'maxToolCharsPerTurn',
    'maxEstimatedCarriedTokensDuringTurn',
    'maxEstimatedIntraTurnCacheReadCostPerTurnUsd',
    'maxEstimatedSessionCostUsd',
  ];
  for (const key of positive) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      errors.push(`${key} must be a positive number`);
    }
  }
  if (!['observe', 'enforce'].includes(config.mode)) {
    errors.push('mode must be "observe" or "enforce"');
  }
  if (!['individual', 'teams-third-party', 'auto-cost', 'cursor-model'].includes(config.billingProfile)) {
    errors.push('billingProfile is invalid');
  }
  if (!config.models || typeof config.models !== 'object') {
    errors.push('models must be an object');
  }
  const nonNegative = [
    'minimumTurnsBeforeCostGate',
    'minimumTurnsBeforeTimeGate',
    'minimumTurnsBeforeContextualTurnGate',
    'minEstimatedCarriedTokensForTurnGate',
    'minimumToolCallsBeforeIntraTurnCostGate',
    'maxProjectedCacheReadCostPerTurnUsd',
    'maxProjectedTotalCostPerTurnUsd',
    'regionalDataResidencyUpliftPercent',
    'legacyMaxModeUpliftPercent',
    'minimumFixedContextTokens',
  ];
  for (const key of nonNegative) {
    if (!Number.isFinite(config[key]) || config[key] < 0) {
      errors.push(`${key} must be a non-negative number`);
    }
  }
  const booleans = [
    'countToolInputs',
    'countFailedToolErrors',
    'countThoughtsAsOutput',
    'countThoughtsAsCarriedContext',
    'calibrateFromPreCompact',
    'preserveCalibratedFloorAfterCompaction',
    'legacyMaxModePricingEnabled',
  ];
  for (const key of booleans) {
    if (typeof config[key] !== 'boolean') errors.push(`${key} must be a boolean`);
  }
  return errors;
}

export function conversationHash(id) {
  return createHash('sha256').update(String(id || 'unknown')).digest('hex').slice(0, 24);
}

export function newState(hash) {
  const now = new Date().toISOString();
  return {
    version: 1,
    conversationHash: hash,
    createdAt: now,
    compactionWindowStartedAt: now,
    lastSeenAt: now,
    endedAt: null,
    promptsSinceCompaction: 0,
    acceptedPromptsTotal: 0,
    promptCharsSinceCompaction: 0,
    responseCharsSinceCompaction: 0,
    toolCharsSinceCompaction: 0,
    toolInputCharsSinceCompaction: 0,
    failedToolCharsSinceCompaction: 0,
    thinkingCharsSinceCompaction: 0,
    attachmentBytesSinceCompaction: 0,
    totalPromptChars: 0,
    totalResponseChars: 0,
    totalToolChars: 0,
    totalToolInputChars: 0,
    totalFailedToolChars: 0,
    totalThinkingChars: 0,
    totalAttachmentBytes: 0,
    toolCallsTotal: 0,
    toolCallsStartedTotal: 0,
    toolCallsSucceededTotal: 0,
    toolCallsFailedTotal: 0,
    toolCallsDeniedTotal: 0,
    toolCallsCurrentTurn: 0,
    toolInputCharsCurrentTurn: 0,
    toolOutputCharsCurrentTurn: 0,
    failedToolCharsCurrentTurn: 0,
    estimatedIntraTurnCacheReadCostUsd: 0,
    estimatedInternalCacheReadCostUsd: 0,
    lastToolGate: null,
    subagentStartsTotal: 0,
    subagentStopsTotal: 0,
    subagentsActive: 0,
    subagentsSinceCompaction: 0,
    outputTokenSamples: [],
    thoughtTokenSamples: [],
    outputTokenSamplesByProfile: {},
    thoughtTokenSamplesByProfile: {},
    pendingThoughtTokensByGeneration: {},
    pendingSampleProfileByGeneration: {},
    calibratedFixedContextTokens: 0,
    postCompactionFloorTokens: 0,
    lastObservedContextTokens: null,
    calibrationCount: 0,
    compactions: [],
    lastModel: null,
    currentReasoningEffort: null,
    lastReasoningEffort: null,
    lastEstimate: null,
    estimatedSessionCostUsd: 0,
    estimatedCacheReadCostUsd: 0,
    estimatedNewInputCostUsd: 0,
    estimatedOutputCostUsd: 0,
  };
}

export async function stateFor(root, conversationId) {
  const hash = conversationHash(conversationId);
  const file = path.join(pathsFor(root).state, `${hash}.json`);
  return { hash, file, state: (await readJson(file, null)) || newState(hash) };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withStateLock(root, conversationId, operation) {
  const { hash, file } = await stateFor(root, conversationId);
  await mkdir(path.dirname(file), { recursive: true });
  const lockFile = path.join(path.dirname(file), `${hash}.lock`);
  let handle;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      handle = await open(lockFile, 'wx');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockFile);
        if (Date.now() - info.mtimeMs > 10000) await rm(lockFile, { force: true });
      } catch {}
      await wait(25);
    }
  }
  if (!handle) throw new Error('Timed out acquiring token-saver state lock');
  try {
    const current = (await readJson(file, null)) || newState(hash);
    const result = await operation(current, file);
    return result;
  } finally {
    await handle.close();
    await rm(lockFile, { force: true });
  }
}

export function modelNameFromPayload(payload) {
  return [...new Set([payload.model_id, payload.model].filter(Boolean).map(String))].join(' ').trim();
}

function canonicalReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (['extra-high', 'extrahigh', 'xhigh'].includes(normalized)) return 'extra-high';
  if (['low', 'medium', 'high', 'max'].includes(normalized)) return normalized;
  return null;
}

export function reasoningEffortFromPayload(payload = {}, rawModelName = modelNameFromPayload(payload)) {
  const explicit = [
    payload.reasoning_effort,
    payload.reasoningEffort,
    payload.effort,
    payload.model_config?.reasoning_effort,
    payload.modelConfig?.reasoningEffort,
    payload.model_parameters?.reasoning_effort,
    payload.modelParameters?.reasoningEffort,
  ];
  for (const value of explicit) {
    const effort = canonicalReasoningEffort(value);
    if (effort) return effort;
  }
  const match = String(rawModelName || '').match(
    /(?:^|[\s/_-])(extra[\s_-]?high|xhigh|high|medium|low|max)(?=$|[\s/_-])/i,
  );
  return canonicalReasoningEffort(match?.[1]);
}

export function resolveModel(config, rawName) {
  const needle = String(rawName || '').toLowerCase();
  if (!needle) return null;
  const candidates = Object.entries(config.models || {}).flatMap(([key, entry]) =>
    [key, ...(entry.aliases || [])].map((alias) => ({
      key,
      entry,
      alias: String(alias).toLowerCase(),
    })),
  ).sort((a, b) => b.alias.length - a.alias.length);
  for (const candidate of candidates) {
    if (needle.includes(candidate.alias)) return { key: candidate.key, ...candidate.entry };
  }
  return null;
}

export function effectiveRates(config, model, { legacyMaxMode = false, maxMode = false } = {}) {
  if (!model) return null;
  const surcharge =
    config.billingProfile === 'teams-third-party' && model.thirdParty ? 0.25 : 0;
  const regionalMultiplier = 1 + (config.regionalDataResidencyUpliftPercent || 0) / 100;
  const applyLegacyMaxUplift = legacyMaxMode || maxMode;
  const maxMultiplier = applyLegacyMaxUplift
    ? 1 + (config.legacyMaxModeUpliftPercent || 0) / 100
    : 1;
  const modelMultiplier = regionalMultiplier * maxMultiplier;
  return {
    input: model.input * modelMultiplier + surcharge,
    cacheWrite: model.cacheWrite * modelMultiplier + surcharge,
    cacheRead: model.cacheRead * modelMultiplier + surcharge,
    output: model.output * modelMultiplier + surcharge,
    cursorTokenRate: surcharge,
    modelMultiplier,
  };
}

export function samplingProfileKey(config, modelName, reasoningEffort = null) {
  const model =
    config.billingProfile === 'auto-cost'
      ? { key: 'auto-cost', ...config.models['auto-cost'] }
      : resolveModel(config, modelName);
  const modelKey = model?.key || String(modelName || 'unknown-model').trim().toLowerCase();
  return `${modelKey || 'unknown-model'}::${reasoningEffort || 'unknown'}`;
}

export function estimatedCarriedChars(state, config = DEFAULT_CONFIG) {
  return (
    (state.promptCharsSinceCompaction || 0) +
    (state.responseCharsSinceCompaction || 0) +
    (state.toolCharsSinceCompaction || 0) +
    (config.countToolInputs ? state.toolInputCharsSinceCompaction || 0 : 0) +
    (config.countFailedToolErrors ? state.failedToolCharsSinceCompaction || 0 : 0) +
    (config.countThoughtsAsCarriedContext ? state.thinkingCharsSinceCompaction || 0 : 0) +
    (state.attachmentBytesSinceCompaction || 0)
  );
}

export function fixedContextFloorTokens(state, config = DEFAULT_CONFIG) {
  return Math.max(
    config.minimumFixedContextTokens || 0,
    state.postCompactionFloorTokens || 0,
  );
}

export function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function estimateNextTurn({
  config,
  state,
  modelName,
  reasoningEffort = null,
  promptChars = 0,
  attachmentBytes = 0,
}) {
  const model =
    config.billingProfile === 'auto-cost'
      ? { key: 'auto-cost', ...config.models['auto-cost'] }
      : resolveModel(config, modelName);
  const legacyMaxMode = config.legacyMaxModePricingEnabled === true;
  const rates = effectiveRates(config, model, { legacyMaxMode });
  const observedCarriedTokens = Math.ceil(estimatedCarriedChars(state, config) / config.charsPerToken);
  const fixedContextTokens = fixedContextFloorTokens(state, config);
  const carriedTokens = fixedContextTokens + observedCarriedTokens;
  const newInputTokens = Math.ceil((promptChars + attachmentBytes) / config.charsPerToken);
  const sampleProfileKey = samplingProfileKey(config, modelName, reasoningEffort);
  const profileOutputSamples = state.outputTokenSamplesByProfile?.[sampleProfileKey] || [];
  const profileThoughtSamples = state.thoughtTokenSamplesByProfile?.[sampleProfileKey] || [];
  const useGlobalFallback = !reasoningEffort && profileOutputSamples.length === 0;
  const outputSamples = profileOutputSamples.length
    ? profileOutputSamples
    : useGlobalFallback
      ? state.outputTokenSamples || []
      : [];
  const thoughtSamples = profileThoughtSamples.length
    ? profileThoughtSamples
    : useGlobalFallback
      ? state.thoughtTokenSamples || []
      : [];
  const sampledOutput = average(outputSamples.slice(-config.outputSampleCount));
  const sampledThoughts = config.countThoughtsAsOutput
    ? average(thoughtSamples.slice(-config.outputSampleCount))
    : 0;
  const expectedOutputTokens = Math.ceil((sampledOutput || config.defaultExpectedOutputTokens) + sampledThoughts);
  const outputEstimateSource = profileOutputSamples.length || profileThoughtSamples.length
    ? 'model-effort-profile'
    : useGlobalFallback && (state.outputTokenSamples || []).length
      ? 'global-history'
      : 'default';
  if (!model || !rates) {
    return {
      knownPricing: false,
      modelName,
      legacyMaxMode,
      reasoningEffort,
      sampleProfileKey,
      outputEstimateSource,
      carriedTokens,
      observedCarriedTokens,
      fixedContextTokens,
      newInputTokens,
      expectedOutputTokens,
    };
  }
  const cacheReadCostUsd = (carriedTokens * rates.cacheRead) / 1_000_000;
  const newInputCostUsd = (newInputTokens * rates.input) / 1_000_000;
  const expectedOutputCostUsd = (expectedOutputTokens * rates.output) / 1_000_000;
  return {
    knownPricing: true,
    modelKey: model.key,
    modelName,
    legacyMaxMode,
    reasoningEffort,
    sampleProfileKey,
    outputEstimateSource,
    rates,
    carriedTokens,
    observedCarriedTokens,
    fixedContextTokens,
    newInputTokens,
    expectedOutputTokens,
    cacheReadCostUsd,
    newInputCostUsd,
    expectedOutputCostUsd,
    projectedTotalCostUsd: cacheReadCostUsd + newInputCostUsd + expectedOutputCostUsd,
  };
}

export function formatUsd(value) {
  if (!Number.isFinite(value)) return 'unknown';
  return `$${value.toFixed(value < 0.01 ? 4 : 3)}`;
}

export async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function attachmentStats(attachments = []) {
  const files = [];
  for (const attachment of attachments) {
    if (attachment?.type !== 'file' || !attachment.file_path) continue;
    try {
      const info = await stat(attachment.file_path);
      if (info.isFile()) files.push({ path: attachment.file_path, bytes: info.size });
    } catch {
      files.push({ path: attachment.file_path, bytes: 0, unavailable: true });
    }
  }
  return files;
}

export async function isReadAllowlisted(root, filePath, config) {
  const allowlist = path.join(root, config.readAllowlistFile);
  let text;
  try {
    text = await readFile(allowlist, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const target = path.resolve(filePath);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .some((line) => {
      const allowed = path.resolve(line.replace(/^~/, os.homedir()));
      return target === allowed || target.startsWith(`${allowed}${path.sep}`);
    });
}

export async function cleanOldStates(root, retentionDays) {
  const stateDir = pathsFor(root).state;
  let entries;
  try {
    entries = await import('node:fs/promises').then(({ readdir }) => readdir(stateDir, { withFileTypes: true }));
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  const cutoff = Date.now() - retentionDays * 86400000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(stateDir, entry.name);
    const info = await stat(file);
    if (info.mtimeMs < cutoff) {
      await rm(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}
