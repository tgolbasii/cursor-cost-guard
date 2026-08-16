import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  DEFAULT_CONFIG,
  conversationHash,
  deepMerge,
  effectiveRates,
  estimateNextTurn,
  readJson,
  reasoningEffortFromPayload,
  resolveModel,
  validateConfig,
  writeJsonAtomic,
} from '../payload/token-saver/lib.mjs';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const hook = path.join(projectRoot, 'payload', 'hooks', 'token-budget.mjs');

async function sandbox(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-cost-guard-hooks-'));
  await mkdir(path.join(root, 'token-saver'), { recursive: true });
  await writeJsonAtomic(
    path.join(root, 'token-saver', 'config.json'),
    deepMerge(DEFAULT_CONFIG, { mode: 'enforce', ...overrides }),
  );
  return root;
}

function invoke(root, payload) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CURSOR_TOKEN_SAVER_HOME: root },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim() || '{}');
}

async function latestState(root) {
  const stateDir = path.join(root, 'token-saver', 'state');
  const names = await import('node:fs/promises').then(({ readdir }) => readdir(stateDir));
  const name = names.find((value) => value.endsWith('.json'));
  return readJson(path.join(stateDir, name));
}

const base = (event, extra = {}) => ({
  hook_event_name: event,
  conversation_id: 'conversation-test',
  generation_id: `generation-${Math.random()}`,
  model: 'claude-sonnet-5',
  ...extra,
});

test('hard turn gate blocks only after accepted limit and permits summarize', async () => {
  const root = await sandbox({ hardMaximumTurnsWithoutCompaction: 2, minimumTurnsBeforeCostGate: 99 });
  try {
    assert.equal(invoke(root, base('beforeSubmitPrompt', { prompt: 'one' })).continue, true);
    assert.equal(invoke(root, base('beforeSubmitPrompt', { prompt: 'two' })).continue, true);
    const blocked = invoke(root, base('beforeSubmitPrompt', { prompt: 'three' }));
    assert.equal(blocked.continue, false);
    assert.match(blocked.user_message, /2 prompts/);
    assert.equal(invoke(root, base('beforeSubmitPrompt', { prompt: '/summarize' })).continue, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('per-conversation limits block and write a local anomaly alert', async () => {
  const root = await sandbox({ maxEstimatedSessionCostUsd: 10, minimumTurnsBeforeCostGate: 99 });
  const hash = conversationHash('conversation-test');
  try {
    await writeJsonAtomic(path.join(root, 'token-saver', 'conversation-limits.json'), {
      [hash]: { maxSessionCostUsd: 0.000001, updatedAt: new Date().toISOString() },
    });
    const result = invoke(root, base('beforeSubmitPrompt', { model: 'composer-2.5', prompt: 'limited' }));
    assert.equal(result.continue, false);
    assert.match(result.user_message, /conversation limit/);
    const alerts = await readFile(path.join(root, 'token-saver', 'anomalies.jsonl'), 'utf8');
    assert.match(alerts, /prompt-blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preCompact recalibrates carried counters and preserves a fixed-context floor', async () => {
  const root = await sandbox({ hardMaximumTurnsWithoutCompaction: 1, minimumTurnsBeforeCostGate: 99 });
  try {
    invoke(root, base('beforeSubmitPrompt', { prompt: 'secret-one' }));
    assert.equal(invoke(root, base('beforeSubmitPrompt', { prompt: 'blocked' })).continue, false);
    const compact = invoke(root, base('preCompact', {
      trigger: 'manual',
      context_usage_percent: 55,
      context_tokens: 55000,
      context_window_size: 100000,
      message_count: 12,
      messages_to_compact: 8,
      is_first_compaction: true,
    }));
    assert.match(compact.user_message, /recalibrated/);
    assert.match(compact.user_message, /54,996-token fixed-context floor/);
    assert.equal(invoke(root, base('beforeSubmitPrompt', { prompt: 'after' })).continue, true);
    const state = await latestState(root);
    assert.equal(state.acceptedPromptsTotal, 2);
    assert.equal(state.promptsSinceCompaction, 1);
    assert.equal(state.compactions.length, 1);
    assert.equal(state.calibratedFixedContextTokens, 54996);
    assert.equal(state.postCompactionFloorTokens, 54996);
    assert.equal(state.lastEstimate.carriedTokens, 54996);
    assert.doesNotMatch(JSON.stringify(state), /secret-one/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tool inputs and failed-tool errors affect carried context without storing content', async () => {
  const root = await sandbox({
    charsPerToken: 1,
    maxEstimatedCarriedTokens: 20,
    hardMaximumTurnsWithoutCompaction: 99,
    minimumTurnsBeforeCostGate: 99,
  });
  const toolInput = { command: 'private-command-value' };
  try {
    invoke(root, base('preToolUse', { tool_name: 'run_terminal_cmd', tool_input: toolInput }));
    invoke(root, base('postToolUseFailure', { error_message: 'private-error-value' }));
    const result = invoke(root, base('beforeSubmitPrompt', { prompt: 'continue' }));
    assert.equal(result.continue, false);
    const state = await latestState(root);
    assert.equal(state.toolInputCharsSinceCompaction, JSON.stringify(toolInput).length);
    assert.equal(state.failedToolCharsSinceCompaction, 'private-error-value'.length);
    assert.equal(state.toolCallsStartedTotal, 1);
    assert.equal(state.toolCallsFailedTotal, 1);
    assert.doesNotMatch(JSON.stringify(state), /private-command-value|private-error-value/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fifty small tool calls in one turn remain allowed and are fully counted', async () => {
  const root = await sandbox({
    hardMaximumToolCallsPerTurn: 160,
    maxToolCharsPerTurn: 100000,
    maxEstimatedCarriedTokensDuringTurn: 999999,
    maxEstimatedIntraTurnCacheReadCostPerTurnUsd: 1,
    maxEstimatedSessionCostUsd: 10,
  });
  try {
    assert.equal(invoke(root, base('beforeSubmitPrompt', { model: 'gpt-5.6-luna', prompt: 'work' })).continue, true);
    for (let index = 0; index < 50; index += 1) {
      const before = invoke(root, base('preToolUse', {
        model: 'gpt-5.6-luna',
        tool_name: 'Read',
        tool_input: { path: `f${index}` },
      }));
      assert.equal(before.permission, 'allow');
      invoke(root, base('postToolUse', { model: 'gpt-5.6-luna', tool_output: 'small-result' }));
    }
    const state = await latestState(root);
    assert.equal(state.toolCallsCurrentTurn, 50);
    assert.equal(state.toolCallsStartedTotal, 50);
    assert.equal(state.toolCallsSucceededTotal, 50);
    assert.ok(state.estimatedInternalCacheReadCostUsd > 0);
    const beforeFinalContinuation = state.estimatedInternalCacheReadCostUsd;
    invoke(root, base('afterAgentResponse', { model: 'gpt-5.6-luna', text: 'done' }));
    assert.ok((await latestState(root)).estimatedInternalCacheReadCostUsd > beforeFinalContinuation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default Luna profile stops a realistic fifty-call payload loop before call fifty', async () => {
  const root = await sandbox();
  try {
    invoke(root, base('beforeSubmitPrompt', { model: 'gpt-5.6-luna', prompt: 'implement the task' }));
    let denied = null;
    for (let index = 1; index <= 50; index += 1) {
      const before = invoke(root, base('preToolUse', {
        model: 'gpt-5.6-luna',
        tool_name: 'Read',
        tool_input: { query: 'i'.repeat(180) },
      }));
      if (before.permission === 'deny') {
        denied = { index, message: before.user_message };
        break;
      }
      invoke(root, base('postToolUse', {
        model: 'gpt-5.6-luna',
        tool_output: 'o'.repeat(2000),
      }));
    }
    assert.ok(denied);
    assert.equal(denied.index, 33);
    assert.match(denied.message, /repeated cache reads/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('emergency tool-call ceiling denies the next tool before execution', async () => {
  const root = await sandbox({
    hardMaximumToolCallsPerTurn: 2,
    maxToolCharsPerTurn: 999999,
    maxEstimatedCarriedTokensDuringTurn: 999999,
    maxEstimatedIntraTurnCacheReadCostPerTurnUsd: 10,
    maxEstimatedSessionCostUsd: 10,
  });
  try {
    invoke(root, base('beforeSubmitPrompt', { model: 'gpt-5.6-luna', prompt: 'work' }));
    for (let index = 0; index < 2; index += 1) {
      assert.equal(invoke(root, base('preToolUse', {
        model: 'gpt-5.6-luna', tool_input: { call: index },
      })).permission, 'allow');
      invoke(root, base('postToolUse', { model: 'gpt-5.6-luna', tool_output: 'ok' }));
    }
    const denied = invoke(root, base('preToolUse', {
      model: 'gpt-5.6-luna', tool_input: { call: 3 },
    }));
    assert.equal(denied.permission, 'deny');
    assert.match(denied.user_message, /tool call 3 exceeds the emergency limit of 2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tool loop is denied mid-turn when accumulated tool payload is too large', async () => {
  const root = await sandbox({
    maxToolCharsPerTurn: 1000,
    maxEstimatedCarriedTokensDuringTurn: 999999,
    maxEstimatedIntraTurnCacheReadCostPerTurnUsd: 10,
    maxEstimatedSessionCostUsd: 10,
  });
  try {
    invoke(root, base('beforeSubmitPrompt', { model: 'gpt-5.6-luna', prompt: 'work' }));
    for (let index = 0; index < 2; index += 1) {
      assert.equal(invoke(root, base('preToolUse', {
        model: 'gpt-5.6-luna',
        tool_input: { payload: 'i'.repeat(80) },
      })).permission, 'allow');
      invoke(root, base('postToolUse', { model: 'gpt-5.6-luna', tool_output: 'o'.repeat(400) }));
    }
    const denied = invoke(root, base('preToolUse', {
      model: 'gpt-5.6-luna',
      tool_input: { payload: 'i'.repeat(80) },
    }));
    assert.equal(denied.permission, 'deny');
    assert.match(denied.user_message, /tool inputs and outputs/);
    const state = await latestState(root);
    assert.equal(state.toolCallsCurrentTurn, 2);
    assert.equal(state.toolCallsDeniedTotal, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repeated internal cache-read estimate can stop a tool loop', async () => {
  const root = await sandbox({
    minimumToolCallsBeforeIntraTurnCostGate: 0,
    maxEstimatedIntraTurnCacheReadCostPerTurnUsd: 0.0001,
    maxToolCharsPerTurn: 999999,
    maxEstimatedCarriedTokensDuringTurn: 999999,
    maxEstimatedSessionCostUsd: 10,
  });
  try {
    invoke(root, base('beforeSubmitPrompt', { model: 'gpt-5.6-luna', prompt: 'work' }));
    assert.equal(invoke(root, base('preToolUse', {
      model: 'gpt-5.6-luna', tool_input: { command: 'one' },
    })).permission, 'allow');
    invoke(root, base('postToolUse', { model: 'gpt-5.6-luna', tool_output: 'x'.repeat(3000) }));
    const denied = invoke(root, base('preToolUse', {
      model: 'gpt-5.6-luna', tool_input: { command: 'two' },
    }));
    assert.equal(denied.permission, 'deny');
    assert.match(denied.user_message, /repeated cache reads/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cumulative session estimate is enforced from the first prompt', async () => {
  const root = await sandbox({ maxEstimatedSessionCostUsd: 0.001 });
  try {
    const blocked = invoke(root, base('beforeSubmitPrompt', { model: 'gpt-5.6-luna', prompt: 'work' }));
    assert.equal(blocked.continue, false);
    assert.match(blocked.user_message, /session estimate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('contextual turn gate requires both prompt count and carried context', async () => {
  const root = await sandbox({
    minimumTurnsBeforeContextualTurnGate: 2,
    minEstimatedCarriedTokensForTurnGate: 100,
    hardMaximumTurnsWithoutCompaction: 35,
    maxEstimatedCarriedTokens: 999999,
    maxProjectedCacheReadCostPerTurnUsd: 10,
    maxProjectedTotalCostPerTurnUsd: 10,
    maxEstimatedSessionCostUsd: 10,
  });
  try {
    assert.equal(invoke(root, base('beforeSubmitPrompt', { prompt: 'x'.repeat(300) })).continue, true);
    assert.equal(invoke(root, base('beforeSubmitPrompt', { prompt: 'x'.repeat(300) })).continue, true);
    const blocked = invoke(root, base('beforeSubmitPrompt', { prompt: 'next' }));
    assert.equal(blocked.continue, false);
    assert.match(blocked.user_message, /2 prompts and 200 carried tokens/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reasoning counts as output but not carried context by default', async () => {
  const root = await sandbox({
    charsPerToken: 3,
    hardMaximumTurnsWithoutCompaction: 99,
    minimumTurnsBeforeCostGate: 99,
  });
  try {
    const generationId = 'reasoning-generation';
    invoke(root, base('afterAgentThought', { generation_id: generationId, text: 'sensitive-thought'.repeat(2) }));
    invoke(root, base('afterAgentResponse', { generation_id: generationId, text: 'answer' }));
    invoke(root, base('beforeSubmitPrompt', { prompt: 'next' }));
    const state = await latestState(root);
    assert.equal(state.lastEstimate.carriedTokens, 2);
    assert.equal(state.lastEstimate.expectedOutputTokens, 14);
    assert.equal(state.totalThinkingChars, 34);
    assert.doesNotMatch(JSON.stringify(state), /sensitive-thought/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reasoning can be included in carried context explicitly', async () => {
  const root = await sandbox({
    charsPerToken: 3,
    countThoughtsAsCarriedContext: true,
    hardMaximumTurnsWithoutCompaction: 99,
    minimumTurnsBeforeCostGate: 99,
  });
  try {
    invoke(root, base('afterAgentThought', { text: 'x'.repeat(30) }));
    invoke(root, base('beforeSubmitPrompt', { prompt: 'next' }));
    const state = await latestState(root);
    assert.equal(state.lastEstimate.carriedTokens, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('subagent hooks track lifecycle only and never store task text', async () => {
  const root = await sandbox();
  try {
    invoke(root, base('subagentStart', { task: 'highly-sensitive-subagent-task' }));
    invoke(root, base('subagentStop', { task: 'highly-sensitive-subagent-task' }));
    const state = await latestState(root);
    assert.equal(state.subagentStartsTotal, 1);
    assert.equal(state.subagentStopsTotal, 1);
    assert.equal(state.subagentsActive, 0);
    assert.doesNotMatch(JSON.stringify(state), /highly-sensitive-subagent-task/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cost gate uses effective Teams cache-read rate', async () => {
  const root = await sandbox({
    billingProfile: 'teams-third-party',
    minimumTurnsBeforeCostGate: 0,
    maxProjectedCacheReadCostPerTurnUsd: 0.001,
    maxProjectedTotalCostPerTurnUsd: 10,
  });
  try {
    invoke(root, base('postToolUse', { tool_output: 'x'.repeat(40000) }));
    const result = invoke(root, base('beforeSubmitPrompt', { prompt: 'continue' }));
    assert.equal(result.continue, false);
    assert.match(result.user_message, /\$0\.450\/M/);
    assert.match(result.user_message, /cache-read charge/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown model does not cause a cost block', async () => {
  const root = await sandbox({
    minimumTurnsBeforeCostGate: 0,
    maxProjectedCacheReadCostPerTurnUsd: 0,
    maxProjectedTotalCostPerTurnUsd: 0,
  });
  try {
    invoke(root, base('postToolUse', { model: 'unknown-future-model', tool_output: 'x'.repeat(10000) }));
    const result = invoke(root, base('beforeSubmitPrompt', { model: 'unknown-future-model', prompt: 'continue' }));
    assert.equal(result.continue, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auto-cost profile uses Auto Cost rates regardless of routed model name', async () => {
  const root = await sandbox({
    billingProfile: 'auto-cost',
    minimumTurnsBeforeCostGate: 0,
    maxProjectedCacheReadCostPerTurnUsd: 0.001,
    maxProjectedTotalCostPerTurnUsd: 10,
  });
  try {
    invoke(root, base('postToolUse', { model: 'opaque-routed-model', tool_output: 'x'.repeat(40000) }));
    const result = invoke(root, base('beforeSubmitPrompt', { model: 'opaque-routed-model', prompt: 'continue' }));
    assert.equal(result.continue, false);
    assert.match(result.user_message, /Model: auto-cost/);
    assert.match(result.user_message, /\$0\.250\/M/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fast model aliases resolve before their cheaper base models', async () => {
  const root = await sandbox({
    billingProfile: 'cursor-model',
    minimumTurnsBeforeCostGate: 0,
    maxProjectedCacheReadCostPerTurnUsd: 10,
    maxProjectedTotalCostPerTurnUsd: 0,
  });
  try {
    const result = invoke(root, base('beforeSubmitPrompt', {
      model_id: 'composer-2.5-fast',
      model: 'composer-2.5-fast',
      prompt: 'continue',
    }));
    assert.equal(result.continue, false);
    assert.match(result.user_message, /Model: composer-2\.5-fast/);
    assert.match(result.user_message, /Effective cache-read rate: \$0\.500\/M/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GPT-5.6 Fast variants use documented 2x rates plus the Teams token rate', () => {
  const config = deepMerge(DEFAULT_CONFIG, { billingProfile: 'teams-third-party' });
  const cases = [
    ['gpt-5.6-luna-fast', 0.65, 0.29, 2.65],
    ['gpt-5.6-terra-fast', 4.25, 0.65, 24.25],
    ['gpt-5.6-sol-fast', 10.25, 1.25, 60.25],
  ];
  for (const [name, input, cacheRead, output] of cases) {
    const model = resolveModel(config, name);
    assert.equal(model.key, name);
    const rates = effectiveRates(config, model);
    assert.equal(rates.input, input);
    assert.equal(rates.cacheRead, cacheRead);
    assert.equal(rates.output, output);
  }
});

test('reasoning Max does not imply legacy Max Mode pricing', () => {
  const config = deepMerge(DEFAULT_CONFIG, {
    billingProfile: 'teams-third-party',
    regionalDataResidencyUpliftPercent: 10,
  });
  const state = {
    outputTokenSamples: [],
    thoughtTokenSamples: [],
    outputTokenSamplesByProfile: {},
    thoughtTokenSamplesByProfile: {},
  };
  const estimate = estimateNextTurn({
    config,
    state,
    modelName: 'gpt-5.6-luna-max',
    reasoningEffort: 'max',
  });
  assert.equal(estimate.reasoningEffort, 'max');
  assert.equal(estimate.legacyMaxMode, false);
  assert.equal(estimate.rates.modelMultiplier, 1.1);
  assert.ok(Math.abs(estimate.rates.cacheRead - 0.272) < 1e-12);
});

test('regional and explicitly enabled legacy Max uplifts apply before the Teams token rate', () => {
  const config = deepMerge(DEFAULT_CONFIG, {
    billingProfile: 'teams-third-party',
    regionalDataResidencyUpliftPercent: 10,
    legacyMaxModePricingEnabled: true,
    legacyMaxModeUpliftPercent: 20,
  });
  const model = resolveModel(config, 'claude-sonnet-5-thinking-max');
  const rates = effectiveRates(config, model, { legacyMaxMode: true });
  assert.equal(rates.modelMultiplier, 1.32);
  assert.ok(Math.abs(rates.cacheRead - 0.514) < Number.EPSILON);
  assert.ok(Math.abs(rates.output - 13.45) < 1e-12);
});

test('reasoning effort is read from explicit hook fields or parameterized model names', () => {
  assert.equal(reasoningEffortFromPayload({ reasoning_effort: 'xhigh' }), 'extra-high');
  assert.equal(reasoningEffortFromPayload({ model: 'gpt-5.6-luna-high' }), 'high');
  assert.equal(reasoningEffortFromPayload({ model: 'gpt-5.6-luna' }), null);
});

test('output calibration is isolated by model and reasoning effort when exposed', async () => {
  const root = await sandbox({
    charsPerToken: 1,
    defaultExpectedOutputTokens: 2000,
    maxProjectedCacheReadCostPerTurnUsd: 10,
    maxProjectedTotalCostPerTurnUsd: 10,
    maxEstimatedSessionCostUsd: 10,
  });
  try {
    const generationId = 'medium-generation';
    invoke(root, base('beforeSubmitPrompt', {
      model: 'gpt-5.6-luna',
      reasoning_effort: 'medium',
      prompt: 'work',
    }));
    invoke(root, base('afterAgentResponse', {
      model: 'gpt-5.6-luna',
      reasoning_effort: 'medium',
      generation_id: generationId,
      text: 'x'.repeat(400),
    }));
    invoke(root, base('beforeSubmitPrompt', {
      model: 'gpt-5.6-luna',
      reasoning_effort: 'medium',
      prompt: 'continue',
    }));
    let state = await latestState(root);
    assert.equal(state.lastEstimate.expectedOutputTokens, 400);
    assert.equal(state.lastEstimate.outputEstimateSource, 'model-effort-profile');
    assert.equal(state.lastEstimate.sampleProfileKey, 'gpt-5.6-luna::medium');

    invoke(root, base('beforeSubmitPrompt', {
      model: 'gpt-5.6-luna',
      reasoning_effort: 'high',
      prompt: 'switch effort',
    }));
    state = await latestState(root);
    assert.equal(state.lastEstimate.expectedOutputTokens, 2000);
    assert.equal(state.lastEstimate.outputEstimateSource, 'default');
    assert.equal(state.lastEstimate.sampleProfileKey, 'gpt-5.6-luna::high');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hard carried-token gate applies even when pricing is unknown', async () => {
  const root = await sandbox({
    maxEstimatedCarriedTokens: 100,
    minimumTurnsBeforeCostGate: 99,
    hardMaximumTurnsWithoutCompaction: 99,
  });
  try {
    invoke(root, base('postToolUse', { model: 'unknown-model', tool_output: 'x'.repeat(301) }));
    const result = invoke(root, base('beforeSubmitPrompt', { model: 'unknown-model', prompt: 'continue' }));
    assert.equal(result.continue, false);
    assert.match(result.user_message, /estimated carried context 101 tokens exceeds 100/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('time gate requires both elapsed time and the minimum prompt count', async () => {
  const root = await sandbox({
    maxMinutesWithoutCompaction: 90,
    minimumTurnsBeforeTimeGate: 1,
    minimumTurnsBeforeCostGate: 99,
    hardMaximumTurnsWithoutCompaction: 99,
    maxEstimatedCarriedTokens: 999999,
  });
  try {
    assert.equal(invoke(root, base('beforeSubmitPrompt', { prompt: 'one' })).continue, true);
    const stateDir = path.join(root, 'token-saver', 'state');
    const [name] = await import('node:fs/promises').then(({ readdir }) => readdir(stateDir));
    const stateFile = path.join(stateDir, name);
    const state = await readJson(stateFile);
    state.compactionWindowStartedAt = new Date(Date.now() - 91 * 60000).toISOString();
    await writeJsonAtomic(stateFile, state);
    const blocked = invoke(root, base('beforeSubmitPrompt', { prompt: 'two' }));
    assert.equal(blocked.continue, false);
    assert.match(blocked.user_message, /91 minutes and 1 prompts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configuration validation rejects negative gates and uplifts', () => {
  const config = deepMerge(DEFAULT_CONFIG, {
    maxProjectedCacheReadCostPerTurnUsd: -1,
    regionalDataResidencyUpliftPercent: -10,
  });
  const errors = validateConfig(config).join('\n');
  assert.match(errors, /maxProjectedCacheReadCostPerTurnUsd/);
  assert.match(errors, /regionalDataResidencyUpliftPercent/);
});

test('configuration validation rejects non-boolean accounting switches', () => {
  const config = deepMerge(DEFAULT_CONFIG, { countToolInputs: 'yes' });
  assert.match(validateConfig(config).join('\n'), /countToolInputs must be a boolean/);
});

test('configuration validation rejects non-boolean legacy Max pricing switch', () => {
  const config = deepMerge(DEFAULT_CONFIG, { legacyMaxModePricingEnabled: 'yes' });
  assert.match(validateConfig(config).join('\n'), /legacyMaxModePricingEnabled must be a boolean/);
});

test('oversized attachments and direct reads are blocked', async () => {
  const root = await sandbox({
    maxSingleAttachmentBytes: 10,
    maxTotalAttachmentBytes: 20,
    maxDirectFileReadBytes: 10,
    minimumTurnsBeforeCostGate: 99,
  });
  const attachment = path.join(root, 'large.txt');
  await writeFile(attachment, '12345678901');
  try {
    const attached = invoke(root, base('beforeSubmitPrompt', {
      prompt: 'read this',
      attachments: [{ type: 'file', file_path: attachment }],
    }));
    assert.equal(attached.continue, false);
    const read = invoke(root, base('beforeReadFile', { file_path: attachment, content: '12345678901' }));
    assert.equal(read.permission, 'deny');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('observation mode never denies a direct file read', async () => {
  const root = await sandbox({ mode: 'observe', maxDirectFileReadBytes: 10 });
  try {
    const read = invoke(root, base('beforeReadFile', { file_path: '/large.txt', content: 'x'.repeat(1000) }));
    assert.equal(read.permission, 'allow');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('break-glass file bypasses enforcement', async () => {
  const root = await sandbox({ maxPromptChars: 1 });
  try {
    await writeFile(path.join(root, 'token-saver', 'disabled'), 'test\n');
    assert.equal(invoke(root, base('beforeSubmitPrompt', { prompt: 'far too long' })).continue, true);
    assert.equal(invoke(root, base('beforeReadFile', { file_path: '/large.txt', content: 'x'.repeat(1000) })).permission, 'allow');
    assert.equal(invoke(root, base('preToolUse', { tool_input: { command: 'test' } })).permission, 'allow');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
