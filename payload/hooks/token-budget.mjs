#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  attachmentStats,
  cleanOldStates,
  conversationLimit,
  conversationHash,
  cursorRoot,
  estimatedCarriedChars,
  estimateNextTurn,
  exists,
  formatUsd,
  isReadAllowlisted,
  loadConfig,
  modelNameFromPayload,
  pathsFor,
  reasoningEffortFromPayload,
  recordAnomaly,
  samplingProfileKey,
  validateConfig,
  withStateLock,
  writeJsonAtomic,
} from '../token-saver/lib.mjs';

const CONTROL_COMMANDS = new Set([
  '/summarize',
  '/compress',
  '/clear',
  '/new',
  '/new-chat',
  '/newchat',
  '/fork',
]);

function emit(value = {}) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function noteAnomaly(root, config, payload, kind, details) {
  if (config.anomalyAlerts?.enabled === false) return;
  await recordAnomaly(root, {
    kind,
    conversationHash: conversationHash(payload.conversation_id),
    model: modelNameFromPayload(payload) || null,
    ...details,
  });
}

async function inputPayload() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

function isControlCommand(prompt) {
  const command = String(prompt || '').trim().split(/\s+/, 1)[0].toLowerCase();
  return CONTROL_COMMANDS.has(command);
}

function serializedChars(value) {
  try {
    return JSON.stringify(value ?? null).length;
  } catch {
    return String(value ?? '').length;
  }
}

function blockMessage(reasons, estimate) {
  const lines = ['Cursor Cost Guard blocked this request:', ...reasons.map((reason) => `- ${reason}`)];
  if (estimate?.knownPricing) {
    lines.push(
      '',
      `Model: ${estimate.modelKey}`,
      `Reasoning effort: ${estimate.reasoningEffort || 'not exposed by Cursor hook'}`,
      `Output estimate source: ${estimate.outputEstimateSource}`,
      `Estimated carried context: ${estimate.carriedTokens.toLocaleString()} tokens`,
      `Calibrated fixed-context floor: ${estimate.fixedContextTokens.toLocaleString()} tokens`,
      `Effective cache-read rate: $${estimate.rates.cacheRead.toFixed(3)}/M`,
      `Projected cache-read charge: ${formatUsd(estimate.cacheReadCostUsd)}`,
      `Projected output charge: ${formatUsd(estimate.expectedOutputCostUsd)}`,
      `Projected total next-turn charge: ${formatUsd(estimate.projectedTotalCostUsd)}`,
    );
  } else {
    lines.push('', `Pricing is unknown for model: ${estimate?.modelName || 'unknown'}`);
  }
  lines.push(
    '',
    'Run /summarize (or /compress) and resend. If the job changed, run /token-handoff and then /new.',
    'If manual summarization is unavailable in Cursor desktop, start a new chat.',
    `Break-glass: create ${pathsFor().disabled}`,
  );
  return lines.join('\n');
}

function toolBlockMessage(reasons, state, estimate) {
  return [
    'Cursor Cost Guard stopped this tool loop:',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    `Allowed tool calls in this turn: ${(state.toolCallsCurrentTurn || 0).toLocaleString()}`,
    `Estimated carried context: ${(estimate?.carriedTokens || 0).toLocaleString()} tokens`,
    `Estimated repeated cache reads this turn: ${formatUsd(state.estimatedIntraTurnCacheReadCostUsd || 0)}`,
    'Summarize the result already obtained, reduce tool output, or ask the user to continue in a new turn.',
  ].join('\n');
}

async function sessionStart(payload, root) {
  await withStateLock(root, payload.conversation_id || payload.session_id, async (state, file) => {
    state.lastSeenAt = new Date().toISOString();
    await writeJsonAtomic(file, state);
  });
  emit({});
}

async function beforeSubmitPrompt(payload, root, config) {
  if (await exists(pathsFor(root).disabled)) return emit({ continue: true });
  const prompt = String(payload.prompt || '');
  if (isControlCommand(prompt)) return emit({ continue: true });

  const attachments = await attachmentStats(payload.attachments || []);
  const totalAttachmentBytes = attachments.reduce((sum, item) => sum + item.bytes, 0);
  const largestAttachment = attachments.reduce((largest, item) => Math.max(largest, item.bytes), 0);
  const modelName = modelNameFromPayload(payload);
  const reasoningEffort = reasoningEffortFromPayload(payload, modelName);

  await withStateLock(root, payload.conversation_id, async (state, file) => {
    const estimate = estimateNextTurn({
      config,
      state,
      modelName,
      reasoningEffort,
      promptChars: prompt.length,
      attachmentBytes: totalAttachmentBytes,
    });
    const reasons = [];
    if (prompt.length > config.maxPromptChars) {
      reasons.push(`prompt has ${prompt.length.toLocaleString()} characters; limit is ${config.maxPromptChars.toLocaleString()}`);
    }
    if (largestAttachment > config.maxSingleAttachmentBytes) {
      reasons.push(`an attachment is ${largestAttachment.toLocaleString()} bytes; limit is ${config.maxSingleAttachmentBytes.toLocaleString()}`);
    }
    if (totalAttachmentBytes > config.maxTotalAttachmentBytes) {
      reasons.push(`attachments total ${totalAttachmentBytes.toLocaleString()} bytes; limit is ${config.maxTotalAttachmentBytes.toLocaleString()}`);
    }
    if (state.promptsSinceCompaction >= config.hardMaximumTurnsWithoutCompaction) {
      reasons.push(`${state.promptsSinceCompaction} prompts have been accepted since compaction`);
    }
    if (
      state.promptsSinceCompaction >= config.minimumTurnsBeforeContextualTurnGate &&
      estimate.carriedTokens >= config.minEstimatedCarriedTokensForTurnGate
    ) {
      reasons.push(
        `${state.promptsSinceCompaction} prompts and ${estimate.carriedTokens.toLocaleString()} carried tokens have accumulated since compaction`,
      );
    }
    if (estimate.carriedTokens > config.maxEstimatedCarriedTokens) {
      reasons.push(`estimated carried context ${estimate.carriedTokens.toLocaleString()} tokens exceeds ${config.maxEstimatedCarriedTokens.toLocaleString()}`);
    }
    const windowStartedAt = Date.parse(state.compactionWindowStartedAt || state.createdAt);
    const minutesWithoutCompaction = Number.isFinite(windowStartedAt)
      ? (Date.now() - windowStartedAt) / 60000
      : 0;
    if (
      state.promptsSinceCompaction >= config.minimumTurnsBeforeTimeGate &&
      minutesWithoutCompaction >= config.maxMinutesWithoutCompaction
    ) {
      reasons.push(`${Math.floor(minutesWithoutCompaction)} minutes and ${state.promptsSinceCompaction} prompts have elapsed since compaction`);
    }
    if (state.promptsSinceCompaction >= config.minimumTurnsBeforeCostGate && estimate.knownPricing) {
      if (estimate.cacheReadCostUsd > config.maxProjectedCacheReadCostPerTurnUsd) {
        reasons.push(`projected cache-read charge ${formatUsd(estimate.cacheReadCostUsd)} exceeds ${formatUsd(config.maxProjectedCacheReadCostPerTurnUsd)}`);
      }
      if (estimate.projectedTotalCostUsd > config.maxProjectedTotalCostPerTurnUsd) {
        reasons.push(`projected total next-turn charge ${formatUsd(estimate.projectedTotalCostUsd)} exceeds ${formatUsd(config.maxProjectedTotalCostPerTurnUsd)}`);
      }
    }
    const limit = await conversationLimit(root, conversationHash(payload.conversation_id));
    if (limit?.maxSessionCostUsd > 0 && (state.estimatedSessionCostUsd || 0) + estimate.projectedTotalCostUsd > limit.maxSessionCostUsd) {
      reasons.push(`conversation limit ${formatUsd(limit.maxSessionCostUsd)} would be exceeded`);
    }
    if (limit?.maxPromptsSinceCompaction > 0 && state.promptsSinceCompaction >= limit.maxPromptsSinceCompaction) {
      reasons.push(`conversation limit of ${limit.maxPromptsSinceCompaction} prompts since compaction would be exceeded`);
    }
    if (
      estimate.knownPricing &&
      (state.estimatedSessionCostUsd || 0) + estimate.projectedTotalCostUsd > config.maxEstimatedSessionCostUsd
    ) {
      reasons.push(
        `projected session estimate ${formatUsd((state.estimatedSessionCostUsd || 0) + estimate.projectedTotalCostUsd)} exceeds ${formatUsd(config.maxEstimatedSessionCostUsd)}`,
      );
    }

    state.lastSeenAt = new Date().toISOString();
    state.lastModel = modelName || state.lastModel;
    state.currentReasoningEffort = reasoningEffort;
    state.lastReasoningEffort = reasoningEffort;
    state.lastEstimate = estimate;
    const enforcing = config.mode === 'enforce';
    if (reasons.length && enforcing) {
      await noteAnomaly(root, config, payload, 'prompt-blocked', { reasons, projectedTotalCostUsd: estimate.projectedTotalCostUsd });
      await writeJsonAtomic(file, state);
      emit({ continue: false, user_message: blockMessage(reasons, estimate) });
      return;
    }

    if (estimate.knownPricing && estimate.projectedTotalCostUsd >= config.maxProjectedTotalCostPerTurnUsd * config.anomalyAlerts.projectedCostFraction) {
      await noteAnomaly(root, config, payload, 'high-projected-cost', { projectedTotalCostUsd: estimate.projectedTotalCostUsd });
    }

    state.promptsSinceCompaction += 1;
    state.acceptedPromptsTotal += 1;
    state.promptCharsSinceCompaction += prompt.length;
    state.attachmentBytesSinceCompaction += totalAttachmentBytes;
    state.totalPromptChars += prompt.length;
    state.totalAttachmentBytes += totalAttachmentBytes;
    state.toolCallsCurrentTurn = 0;
    state.toolInputCharsCurrentTurn = 0;
    state.toolOutputCharsCurrentTurn = 0;
    state.failedToolCharsCurrentTurn = 0;
    state.estimatedIntraTurnCacheReadCostUsd = 0;
    state.lastToolGate = null;
    if (estimate.knownPricing) {
      state.estimatedSessionCostUsd = (state.estimatedSessionCostUsd || 0) + estimate.projectedTotalCostUsd;
      state.estimatedCacheReadCostUsd = (state.estimatedCacheReadCostUsd || 0) + estimate.cacheReadCostUsd;
      state.estimatedNewInputCostUsd = (state.estimatedNewInputCostUsd || 0) + estimate.newInputCostUsd;
      state.estimatedOutputCostUsd = (state.estimatedOutputCostUsd || 0) + estimate.expectedOutputCostUsd;
    }
    await writeJsonAtomic(file, state);
    emit({ continue: true });
  });
}

async function postToolUse(payload, root) {
  const outputChars = String(payload.tool_output || '').length;
  await withStateLock(root, payload.conversation_id, async (state, file) => {
    state.lastSeenAt = new Date().toISOString();
    state.toolCallsTotal = (state.toolCallsTotal || 0) + 1;
    state.toolCallsSucceededTotal = (state.toolCallsSucceededTotal || 0) + 1;
    state.toolCharsSinceCompaction = (state.toolCharsSinceCompaction || 0) + outputChars;
    state.totalToolChars = (state.totalToolChars || 0) + outputChars;
    state.toolOutputCharsCurrentTurn = (state.toolOutputCharsCurrentTurn || 0) + outputChars;
    await writeJsonAtomic(file, state);
  });
  emit({});
}

async function preToolUse(payload, root, config) {
  const inputChars = serializedChars(payload.tool_input);
  await withStateLock(root, payload.conversation_id, async (state, file) => {
    const now = new Date().toISOString();
    const proposedCallNumber = (state.toolCallsCurrentTurn || 0) + 1;
    const proposedToolChars =
      (state.toolInputCharsCurrentTurn || 0) +
      (state.toolOutputCharsCurrentTurn || 0) +
      (state.failedToolCharsCurrentTurn || 0) +
      inputChars;
    const proposedState = {
      ...state,
      toolInputCharsSinceCompaction: (state.toolInputCharsSinceCompaction || 0) + inputChars,
    };
    const modelName = modelNameFromPayload(payload) || state.lastModel;
    const reasoningEffort =
      reasoningEffortFromPayload(payload, modelName) || state.currentReasoningEffort || null;
    const estimate = estimateNextTurn({
      config,
      state: proposedState,
      modelName,
      reasoningEffort,
    });
    const additionalCacheReadCostUsd =
      proposedCallNumber > 1 && estimate.knownPricing ? estimate.cacheReadCostUsd : 0;
    const projectedIntraTurnCacheReadCostUsd =
      (state.estimatedIntraTurnCacheReadCostUsd || 0) + additionalCacheReadCostUsd;
    const projectedSessionCostUsd = (state.estimatedSessionCostUsd || 0) + additionalCacheReadCostUsd;
    const reasons = [];
    if (proposedCallNumber > config.hardMaximumToolCallsPerTurn) {
      reasons.push(`tool call ${proposedCallNumber} exceeds the emergency limit of ${config.hardMaximumToolCallsPerTurn}`);
    }
    if (proposedToolChars > config.maxToolCharsPerTurn) {
      reasons.push(`tool inputs and outputs in this turn exceed ${config.maxToolCharsPerTurn.toLocaleString()} characters`);
    }
    if (estimate.carriedTokens > config.maxEstimatedCarriedTokensDuringTurn) {
      reasons.push(`estimated carried context ${estimate.carriedTokens.toLocaleString()} tokens exceeds the in-turn limit of ${config.maxEstimatedCarriedTokensDuringTurn.toLocaleString()}`);
    }
    if (
      proposedCallNumber > config.minimumToolCallsBeforeIntraTurnCostGate &&
      projectedIntraTurnCacheReadCostUsd > config.maxEstimatedIntraTurnCacheReadCostPerTurnUsd
    ) {
      reasons.push(
        `estimated repeated cache reads ${formatUsd(projectedIntraTurnCacheReadCostUsd)} exceed the in-turn limit of ${formatUsd(config.maxEstimatedIntraTurnCacheReadCostPerTurnUsd)}`,
      );
    }
    if (projectedSessionCostUsd > config.maxEstimatedSessionCostUsd) {
      reasons.push(`projected session estimate ${formatUsd(projectedSessionCostUsd)} exceeds ${formatUsd(config.maxEstimatedSessionCostUsd)}`);
    }

    state.lastSeenAt = now;
    state.lastModel = modelName || state.lastModel;
    state.lastReasoningEffort = reasoningEffort;
    state.estimatedIntraTurnCacheReadCostUsd = projectedIntraTurnCacheReadCostUsd;
    state.estimatedInternalCacheReadCostUsd =
      (state.estimatedInternalCacheReadCostUsd || 0) + additionalCacheReadCostUsd;
    state.estimatedSessionCostUsd = projectedSessionCostUsd;
    state.estimatedCacheReadCostUsd = (state.estimatedCacheReadCostUsd || 0) + additionalCacheReadCostUsd;
    const enforcing = config.mode === 'enforce';
    if (reasons.length) {
      state.lastToolGate = { at: now, reasons, estimate, enforcing };
    }
    if (reasons.length && enforcing) {
      await noteAnomaly(root, config, payload, 'tool-loop-blocked', { reasons, toolCallsCurrentTurn: state.toolCallsCurrentTurn || 0 });
      state.toolCallsDeniedTotal = (state.toolCallsDeniedTotal || 0) + 1;
      await writeJsonAtomic(file, state);
      const message = toolBlockMessage(reasons, state, estimate);
      emit({ permission: 'deny', user_message: message, agent_message: message });
      return;
    }

    state.toolCallsStartedTotal = (state.toolCallsStartedTotal || 0) + 1;
    state.toolCallsCurrentTurn = proposedCallNumber;
    state.toolInputCharsSinceCompaction = (state.toolInputCharsSinceCompaction || 0) + inputChars;
    state.totalToolInputChars = (state.totalToolInputChars || 0) + inputChars;
    state.toolInputCharsCurrentTurn = (state.toolInputCharsCurrentTurn || 0) + inputChars;
    await writeJsonAtomic(file, state);
    emit({ permission: 'allow' });
  });
}

async function postToolUseFailure(payload, root) {
  const errorChars = String(payload.error_message || '').length;
  await withStateLock(root, payload.conversation_id, async (state, file) => {
    state.lastSeenAt = new Date().toISOString();
    state.toolCallsTotal = (state.toolCallsTotal || 0) + 1;
    state.toolCallsFailedTotal = (state.toolCallsFailedTotal || 0) + 1;
    state.failedToolCharsSinceCompaction = (state.failedToolCharsSinceCompaction || 0) + errorChars;
    state.totalFailedToolChars = (state.totalFailedToolChars || 0) + errorChars;
    state.failedToolCharsCurrentTurn = (state.failedToolCharsCurrentTurn || 0) + errorChars;
    await writeJsonAtomic(file, state);
  });
  emit({});
}

async function afterAgentThought(payload, root, config) {
  const chars = String(payload.text || '').length;
  const tokens = Math.ceil(chars / config.charsPerToken);
  const generationKey = conversationHash(payload.generation_id || 'unknown-generation');
  await withStateLock(root, payload.conversation_id, async (state, file) => {
    const modelName = modelNameFromPayload(payload) || state.lastModel;
    const reasoningEffort =
      reasoningEffortFromPayload(payload, modelName) || state.currentReasoningEffort || null;
    const sampleProfile = samplingProfileKey(config, modelName, reasoningEffort);
    state.lastSeenAt = new Date().toISOString();
    state.thinkingCharsSinceCompaction = (state.thinkingCharsSinceCompaction || 0) + chars;
    state.totalThinkingChars = (state.totalThinkingChars || 0) + chars;
    state.pendingThoughtTokensByGeneration ||= {};
    state.pendingThoughtTokensByGeneration[generationKey] =
      (state.pendingThoughtTokensByGeneration[generationKey] || 0) + tokens;
    state.pendingSampleProfileByGeneration ||= {};
    state.pendingSampleProfileByGeneration[generationKey] = sampleProfile;
    await writeJsonAtomic(file, state);
  });
  emit({});
}

async function afterAgentResponse(payload, root, config) {
  const chars = String(payload.text || '').length;
  const generationKey = conversationHash(payload.generation_id || 'unknown-generation');
  await withStateLock(root, payload.conversation_id, async (state, file) => {
    const modelName = modelNameFromPayload(payload) || state.lastModel;
    const reasoningEffort =
      reasoningEffortFromPayload(payload, modelName) || state.currentReasoningEffort || null;
    const sampleProfile =
      state.pendingSampleProfileByGeneration?.[generationKey] ||
      samplingProfileKey(config, modelName, reasoningEffort);
    if ((state.toolCallsCurrentTurn || 0) > 0) {
      const finalContinuation = estimateNextTurn({
        config,
        state,
        modelName,
        reasoningEffort,
      });
      if (finalContinuation.knownPricing) {
        state.estimatedIntraTurnCacheReadCostUsd =
          (state.estimatedIntraTurnCacheReadCostUsd || 0) + finalContinuation.cacheReadCostUsd;
        state.estimatedInternalCacheReadCostUsd =
          (state.estimatedInternalCacheReadCostUsd || 0) + finalContinuation.cacheReadCostUsd;
        state.estimatedSessionCostUsd =
          (state.estimatedSessionCostUsd || 0) + finalContinuation.cacheReadCostUsd;
        state.estimatedCacheReadCostUsd =
          (state.estimatedCacheReadCostUsd || 0) + finalContinuation.cacheReadCostUsd;
      }
    }
    state.lastSeenAt = new Date().toISOString();
    state.responseCharsSinceCompaction += chars;
    state.totalResponseChars += chars;
    state.outputTokenSamples.push(Math.ceil(chars / config.charsPerToken));
    state.outputTokenSamples = state.outputTokenSamples.slice(-Math.max(config.outputSampleCount, 1));
    state.outputTokenSamplesByProfile ||= {};
    state.outputTokenSamplesByProfile[sampleProfile] ||= [];
    state.outputTokenSamplesByProfile[sampleProfile].push(Math.ceil(chars / config.charsPerToken));
    state.outputTokenSamplesByProfile[sampleProfile] =
      state.outputTokenSamplesByProfile[sampleProfile].slice(-Math.max(config.outputSampleCount, 1));
    const thoughtTokens = state.pendingThoughtTokensByGeneration?.[generationKey] || 0;
    if (thoughtTokens > 0) {
      state.thoughtTokenSamples ||= [];
      state.thoughtTokenSamples.push(thoughtTokens);
      state.thoughtTokenSamples = state.thoughtTokenSamples.slice(-Math.max(config.outputSampleCount, 1));
      state.thoughtTokenSamplesByProfile ||= {};
      state.thoughtTokenSamplesByProfile[sampleProfile] ||= [];
      state.thoughtTokenSamplesByProfile[sampleProfile].push(thoughtTokens);
      state.thoughtTokenSamplesByProfile[sampleProfile] =
        state.thoughtTokenSamplesByProfile[sampleProfile].slice(-Math.max(config.outputSampleCount, 1));
      delete state.pendingThoughtTokensByGeneration[generationKey];
    }
    if (state.pendingSampleProfileByGeneration) {
      delete state.pendingSampleProfileByGeneration[generationKey];
    }
    state.lastReasoningEffort = reasoningEffort;
    await writeJsonAtomic(file, state);
  });
  emit({});
}

async function subagentStart(payload, root) {
  await withStateLock(root, payload.conversation_id, async (state, file) => {
    state.lastSeenAt = new Date().toISOString();
    state.subagentStartsTotal = (state.subagentStartsTotal || 0) + 1;
    state.subagentsActive = (state.subagentsActive || 0) + 1;
    state.subagentsSinceCompaction = (state.subagentsSinceCompaction || 0) + 1;
    await writeJsonAtomic(file, state);
  });
  emit({});
}

async function subagentStop(payload, root) {
  await withStateLock(root, payload.conversation_id, async (state, file) => {
    state.lastSeenAt = new Date().toISOString();
    state.subagentStopsTotal = (state.subagentStopsTotal || 0) + 1;
    state.subagentsActive = Math.max(0, (state.subagentsActive || 0) - 1);
    await writeJsonAtomic(file, state);
  });
  emit({});
}

async function preCompact(payload, root, config) {
  let retainedFloor = config.minimumFixedContextTokens || 0;
  await withStateLock(root, payload.conversation_id, async (state, file) => {
    const now = new Date().toISOString();
    const localEstimatedTokens = Math.ceil(estimatedCarriedChars(state, config) / config.charsPerToken);
    const observedContextTokens = Number(payload.context_tokens);
    let calibratedResidualTokens = state.calibratedFixedContextTokens || retainedFloor;
    if (config.calibrateFromPreCompact && Number.isFinite(observedContextTokens)) {
      calibratedResidualTokens = Math.max(
        config.minimumFixedContextTokens || 0,
        Math.round(observedContextTokens) - localEstimatedTokens,
      );
      state.calibratedFixedContextTokens = calibratedResidualTokens;
      state.lastObservedContextTokens = Math.round(observedContextTokens);
      state.calibrationCount = (state.calibrationCount || 0) + 1;
    }
    retainedFloor = config.preserveCalibratedFloorAfterCompaction
      ? Math.max(config.minimumFixedContextTokens || 0, calibratedResidualTokens)
      : config.minimumFixedContextTokens || 0;
    state.compactions.push({
      at: now,
      trigger: payload.trigger,
      contextUsagePercent: payload.context_usage_percent,
      contextTokens: payload.context_tokens,
      contextWindowSize: payload.context_window_size,
      messageCount: payload.message_count,
      messagesToCompact: payload.messages_to_compact,
      isFirstCompaction: payload.is_first_compaction,
      localEstimatedTokens,
      calibratedResidualTokens,
      retainedFixedContextFloorTokens: retainedFloor,
    });
    state.promptsSinceCompaction = 0;
    state.promptCharsSinceCompaction = 0;
    state.responseCharsSinceCompaction = 0;
    state.toolCharsSinceCompaction = 0;
    state.toolInputCharsSinceCompaction = 0;
    state.failedToolCharsSinceCompaction = 0;
    state.thinkingCharsSinceCompaction = 0;
    state.attachmentBytesSinceCompaction = 0;
    state.subagentsSinceCompaction = 0;
    state.pendingThoughtTokensByGeneration = {};
    state.pendingSampleProfileByGeneration = {};
    state.toolCallsCurrentTurn = 0;
    state.toolInputCharsCurrentTurn = 0;
    state.toolOutputCharsCurrentTurn = 0;
    state.failedToolCharsCurrentTurn = 0;
    state.estimatedIntraTurnCacheReadCostUsd = 0;
    state.lastToolGate = null;
    state.currentReasoningEffort = null;
    state.postCompactionFloorTokens = retainedFloor;
    state.compactionWindowStartedAt = now;
    state.lastEstimate = null;
    state.lastSeenAt = now;
    await writeJsonAtomic(file, state);
  });
  emit({
    user_message: `Cursor Cost Guard recalibrated this conversation and retained a ${retainedFloor.toLocaleString()}-token fixed-context floor.`,
  });
}

async function beforeReadFile(payload, root, config) {
  if (config.mode !== 'enforce') return emit({ permission: 'allow' });
  const filePath = payload.file_path;
  const bytes = Buffer.byteLength(String(payload.content || ''), 'utf8');
  const allowed = filePath ? await isReadAllowlisted(root, filePath, config) : false;
  if (bytes > config.maxDirectFileReadBytes && !allowed) {
    return emit({
      permission: 'deny',
      user_message: `Direct read blocked: ${path.basename(filePath || 'file')} is ${bytes.toLocaleString()} bytes. Use rg, bounded ranges, or select-context. Add an exact file or directory path to ${path.join(root, config.readAllowlistFile)} to allow it.`,
    });
  }
  emit({ permission: 'allow' });
}

async function sessionEnd(payload, root, config) {
  await withStateLock(root, payload.conversation_id || payload.session_id, async (state, file) => {
    state.endedAt = new Date().toISOString();
    state.lastSeenAt = state.endedAt;
    await writeJsonAtomic(file, state);
  });
  await cleanOldStates(root, config.stateRetentionDays);
  emit({});
}

async function main() {
  const payload = await inputPayload();
  const root = cursorRoot();
  const config = await loadConfig(root);
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Invalid token-saver config: ${errors.join('; ')}`);
  if (await exists(pathsFor(root).disabled)) {
    if (payload.hook_event_name === 'beforeSubmitPrompt') return emit({ continue: true });
    if (['preToolUse', 'beforeReadFile', 'subagentStart'].includes(payload.hook_event_name)) {
      return emit({ permission: 'allow' });
    }
    return emit({});
  }
  switch (payload.hook_event_name) {
    case 'sessionStart': return sessionStart(payload, root);
    case 'beforeSubmitPrompt': return beforeSubmitPrompt(payload, root, config);
    case 'preToolUse': return preToolUse(payload, root, config);
    case 'postToolUse': return postToolUse(payload, root);
    case 'postToolUseFailure': return postToolUseFailure(payload, root);
    case 'afterAgentThought': return afterAgentThought(payload, root, config);
    case 'afterAgentResponse': return afterAgentResponse(payload, root, config);
    case 'subagentStart': return subagentStart(payload, root);
    case 'subagentStop': return subagentStop(payload, root);
    case 'preCompact': return preCompact(payload, root, config);
    case 'beforeReadFile': return beforeReadFile(payload, root, config);
    case 'sessionEnd': return sessionEnd(payload, root, config);
    default: return emit({});
  }
}

main().catch(async (error) => {
  try {
    const root = cursorRoot();
    await import('node:fs/promises').then(({ mkdir, appendFile }) =>
      mkdir(pathsFor(root).logs, { recursive: true }).then(() =>
        appendFile(path.join(pathsFor(root).logs, 'hook-errors.log'), `${new Date().toISOString()} ${error.stack || error.message}\n`),
      ),
    );
  } catch {}
  // Cursor hooks are intentionally fail-open: malformed local state must not lock the user out.
  emit({});
});
