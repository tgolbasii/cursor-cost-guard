# Cursor Cost Guard

A deterministic, cost-aware guard for Cursor Agent. It uses local hooks and scripts for everything mechanically enforceable and includes one manual semantic skill for compact handoffs.

## What it does

- Estimates the next request's carried-context, new-input, and output charges using the selected model and billing profile.
- Separates observed output calibration by model and reasoning effort when Cursor exposes the effort parameter.
- Blocks prompts when configured cost, size, or turn limits are exceeded.
- Allows `/summarize`, `/compress`, `/new`, and related control commands through the gate.
- Measures tool inputs, tool outputs, failed-tool errors, reasoning output, and subagent lifecycle events through Cursor hooks.
- Stops runaway tool loops before the next tool executes when their count, payload, carried context, repeated-cache estimate, or session estimate exceeds a hard budget.
- Calibrates an otherwise-unobservable fixed-context floor from `preCompact.context_tokens` and retains that floor after compaction.
- Blocks direct Agent reads of large files while leaving Cursor Tab alone.
- Tracks counts and sizes only. It never stores prompts, responses, thoughts, tool inputs/results/errors, files, or subagent task text.
- Guard hooks make no network or model calls; the optional billing refresh only calls the endpoint you explicitly configure.

## Status bar and dashboard

The optional `extension/` folder contains a dependency-free Cursor/VS Code extension. Install it with `Extensions: Install from Location...` and select `extension/` to get a status bar showing reconciled usage/quota and a per-conversation cost tree. It also provides commands to set or clear conversation limits and refresh billing.

For a browser dashboard instead:

```bash
node ~/.cursor/token-saver/token-saverctl.mjs dashboard 4173
```

The dashboard binds to `127.0.0.1` and exposes local conversation estimates, limits, quota/reset data, and recent anomaly alerts. It does not transmit data.

## Billing reconciliation and alerts

Billing is opt-in and endpoint-agnostic because Cursor's usage endpoints and authentication vary by plan. Configure an authenticated JSON endpoint in `~/.cursor/token-saver/config.json`:

```json
{
  "billing": {
    "endpoint": "https://your-approved-cursor-usage-endpoint",
    "tokenEnv": "CURSOR_USAGE_TOKEN",
    "timeoutMs": 5000
  }
}
```

The endpoint may return `usedUsd`, `limitUsd`, `quotaUsed`, `quotaLimit`, and `resetAt` directly, or under a `usage`/`data` object. Set the token in the environment and run:

```bash
export CURSOR_USAGE_TOKEN=...
node ~/.cursor/token-saver/token-saverctl.mjs billing refresh
```

Set per-conversation limits using the hash shown by `status --all`:

```bash
node ~/.cursor/token-saver/token-saverctl.mjs limit set <conversation-hash> 0.10 20
node ~/.cursor/token-saver/token-saverctl.mjs limit clear <conversation-hash>
```

High projected costs and enforced prompt/tool blocks are recorded locally in `~/.cursor/token-saver/anomalies.jsonl`. View them with `token-saverctl.mjs anomalies`. Alerts are local-only and can be disabled with `anomalyAlerts.enabled: false`.

It does **not** claim a real cache hit. Estimates use the cache-read scenario until you reconcile them with Cursor's usage dashboard.

## Requirements

- Cursor with hooks and Agent Skills support.
- Node.js 20 or newer available in Cursor's process environment.
- `rg` (ripgrep) for the optional bounded-context utility.

## Install

Extract this directory, open a terminal in it, and choose the correct billing profile:

```bash
node install.mjs --dry-run --profile teams-third-party
node install.mjs --profile teams-third-party
```

Profiles:

- `teams-third-party`: adds Cursor's $0.25/M token rate to eligible third-party model rates.
- `individual`: uses provider/model rates without that surcharge.
- `auto-cost`: for Cursor Auto Cost pricing.
- `cursor-model`: for first-party Cursor models that are exempt from the surcharge.

Installation starts in observation mode by default:

```bash
node install.mjs --profile teams-third-party --observe
```

Use `--enforce` only when you intentionally want blocking enabled immediately.
Observation mode records prompt and tool estimates but does not deny prompts, tool executions, or direct file reads.

The installer merges `~/.cursor/hooks.json`, backs up overwritten files, and does not change your model, permissions, sandbox, MCP servers, or editor settings. Set `CURSOR_CONFIG_DIR` before installation if Cursor uses a non-default configuration directory.

## Verify

```bash
node ~/.cursor/token-saver/token-saverctl.mjs validate-config
node ~/.cursor/token-saver/token-saverctl.mjs status
```

Cursor normally reloads hook configuration automatically. Open a new Agent conversation if an existing one does not emit hook events.

## Controls

```bash
node ~/.cursor/token-saver/token-saverctl.mjs status --all
node ~/.cursor/token-saver/token-saverctl.mjs observe
node ~/.cursor/token-saver/token-saverctl.mjs enforce
node ~/.cursor/token-saver/token-saverctl.mjs disable
node ~/.cursor/token-saver/token-saverctl.mjs enable
node ~/.cursor/token-saver/token-saverctl.mjs reset
node ~/.cursor/token-saver/token-saverctl.mjs profile individual
node ~/.cursor/token-saver/token-saverctl.mjs prices
```

The break-glass file is `~/.cursor/token-saver/disabled`; while present, hooks allow guarded actions and skip accounting. Hook failures are fail-open and are recorded locally under `~/.cursor/token-saver/logs/`.

## Utilities

Bounded search:

```bash
node ~/.cursor/token-saver/select-context.mjs "authentication failed" src test
```

Capped command output, with the complete result retained locally:

```bash
node ~/.cursor/token-saver/capped-command.mjs --max-chars 16000 -- npm test
```

Semantic handoffs are deliberately manual. Invoke `/token-handoff` in Cursor Agent. The skill saves the result under `~/.cursor/token-saver/handoffs/` and recommends a new chat.

## Configuration

Edit `~/.cursor/token-saver/config.json`. Important defaults:

- Cost gates apply from the first accepted prompt.
- Contextual turn gate after 20 prompts when carried context is at least 60,000 tokens.
- Absolute gate after 35 prompts without compaction.
- Hard estimated carried-context gate: 80,000 tokens.
- Time gate after 120 minutes only when at least 15 prompts were accepted since compaction.
- Projected cache-read gate: $0.02 per next turn.
- Projected total-turn gate: $0.04.
- Cumulative estimated session-cost gate: $0.50.
- Tool-loop cost gate begins after 8 allowed tool calls in the current turn.
- Emergency tool-call ceiling: 160 calls in one turn.
- Tool input/output/error budget: 180,000 characters in one turn.
- In-turn carried-context limit: 80,000 tokens.
- Repeated internal cache-read estimate limit: $0.10 per turn.
- Prompt limit: 24,000 characters.
- Single attachment/direct read limit: 128 KiB.
- Aggregate attachment limit: 256 KiB.
- Token estimate: 3 characters per token, deliberately conservative for code-heavy context.
- Tool inputs and failed-tool errors count toward carried context by default.
- Reasoning text counts toward estimated output usage but not carried context by default.
- Modern reasoning `Max` does not receive Cursor's legacy Max Mode 20% uplift.
- Legacy request-based Max Mode pricing is disabled by default and must be enabled explicitly with `legacyMaxModePricingEnabled`.
- `preCompact.context_tokens` calibrates the fixed context that hooks cannot observe, including system instructions, rules, skill metadata, and tool/MCP schemas.
- After compaction, the calibrated fixed-context component is retained instead of resetting the estimate to zero.

Related configuration switches are `countToolInputs`, `countFailedToolErrors`, `countThoughtsAsOutput`, `countThoughtsAsCarriedContext`, `calibrateFromPreCompact`, `minimumFixedContextTokens`, and `preserveCalibratedFloorAfterCompaction`. Keep the defaults through an observation session before changing them. `minimumFixedContextTokens` is a manual lower bound for installations that need a conservative floor before the first compaction supplies calibration data.

The raw 160-call ceiling is only an emergency failsafe; normal enforcement is size-, context-, and cost-aware. Fifty small tool calls can remain allowed, while fewer large calls can be stopped. Cursor's Spring 2026 Developer Habits Report recorded a mean of about 145 tool calls per Agent session, but did not publish a per-turn average, so the package does not pretend that a lower per-turn average is known: https://cursor.com/hi/insights

The repeated-cache estimate accounts for additional model continuations between tool calls under the cache-read scenario. The initial model request is already included at prompt submission; each later tool-selection continuation and the final response continuation add another estimated cache read. It also does not disable MCP servers automatically; that would change Cursor capabilities and remains an explicit user decision.

The regression suite verifies both sides of this policy: 50 very small tool calls remain allowed, while the default Luna profile stops a loop with roughly 200 input characters and 2,000 output characters per tool before call 33 when its repeated-cache estimate crosses $0.10.

Pricing is a dated snapshot from Cursor's model-pricing page and includes the documented Fast variants, including the 2x GPT-5.6 Luna, Terra, and Sol Fast tiers. Review it when Cursor changes model prices. Unknown models never trigger a cost-only block; mechanical carried-context, size, time, and turn limits still apply.

Set `regionalDataResidencyUpliftPercent` to `10` only if your Cursor account uses eligible regional data residency. Modern Low/Medium/High/Extra High/Max reasoning selections use the model's normal per-token rates; higher efforts cost more by consuming more tokens and steps. The separate 20% legacy Max Mode uplift applies only on legacy request-based plans. Set `legacyMaxModePricingEnabled` to `true` only when that older billing mode actually applies. Both uplifts are applied before the Teams Cursor Token Rate.

## Reasoning-effort guidance

The guard does not select a model or reasoning effort. CursorBench 3.2 evaluates ambiguous, multi-file tasks from real Cursor sessions, so its averages are useful routing evidence but not safe hard limits for every repository:

| GPT-5.6 Luna effort | CursorBench score | Average task cost | Tokens | Steps |
| --- | ---: | ---: | ---: | ---: |
| Low | 37.6% | $0.03 | 3,209 | 17 |
| Medium | 47.7% | $0.08 | 7,095 | 28 |
| High | 56.8% | $0.16 | 15,141 | 40 |
| Extra High | 57.7% | $0.23 | 22,480 | 48 |
| Max | 61.1% | $0.39 | 87,973 | 61 |

Practical routing: use Medium for small deterministic changes, High as the everyday default, usually skip Extra High, and use Max for genuinely difficult or ambiguous multi-file work. The Teams Cursor Token Rate adds $0.25 per million third-party tokens; at the benchmark token totals this adds about $0.0008, $0.0018, $0.0038, $0.0056, and $0.022 respectively. Sources: https://cursor.com/evals and https://cursor.com/docs/models-and-pricing

When Cursor supplies an effort field or a parameterized model name, observed response and reasoning samples are stored under separate model-effort keys. A new effort starts with `defaultExpectedOutputTokens` instead of inheriting a cheaper effort's recent output average. If Cursor exposes only the base model, the status reports effort as unknown and uses the unknown-profile/global history; the guard never guesses an effort from benchmark averages.

To allow a large direct read, add an absolute file or directory path to:

```text
~/.cursor/token-saver/read-allowlist
```

## Uninstall

Preview removal:

```bash
node uninstall.mjs --dry-run
```

Remove hooks and installed code while retaining state, handoffs, logs, and backups:

```bash
node uninstall.mjs
```

Remove all retained Cursor Cost Guard data as well:

```bash
node uninstall.mjs --purge-data
```

Uninstall removes only hook entries whose command references `token-budget.mjs`; unrelated hook entries remain intact.

## Important limitations

- Cursor does not expose a pre-response maximum-output-token field through hooks, so response length can only be measured after generation.
- Cursor hook payloads are not guaranteed to expose reasoning effort or Fast selection in every product/version. Effort-specific calibration and Fast pricing are exact only when the payload carries the parameterized effort or `-fast` model identifier; otherwise the guard reports the parameter as unknown instead of guessing.
- Generic tool input, output, and failure text can be measured but not universally rewritten safely. This package does not rewrite arbitrary shell commands or MCP result structures.
- A denied `preToolUse` stops the tool execution, but the model request that selected that attempted tool has already occurred. Its estimated repeated cache-read cost is still recorded.
- Tool-loop enforcement only covers events Cursor emits. Cursor documents `preToolUse` for Shell, Read, Write, MCP, Task, and other tools, but hook coverage can differ across IDE, CLI, cloud, and product versions.
- Cursor hooks do not expose the full system prompt, User/Project Rules, skill metadata, or serialized MCP/tool schemas on every request. The package infers their combined residual from `preCompact.context_tokens`; estimates before the first usable calibration can therefore be low unless `minimumFixedContextTokens` is configured.
- Subagent start/stop events are counted without re-counting task text. Task arguments and returned results are already covered by the generic pre/post-tool hooks when Cursor emits them.
- Reasoning text is treated as output usage. It is excluded from carried context by default because Cursor does not guarantee that exposed reasoning blocks are replayed into the next model request.
- Cursor controls actual prompt caching. Local estimates cannot prove which tokens were billed as cache reads.
- Cost estimates assume carried input receives the documented cache-read rate. Cache misses or writes can cost more.
- `preCompact` fires before compaction; Cursor does not expose the exact post-compaction token total. The retained value is the calibrated unobserved fixed-context floor, not a claim about the summary's exact size.
