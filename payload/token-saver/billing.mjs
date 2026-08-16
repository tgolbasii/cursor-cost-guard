import { loadConfig, pathsFor, writeJsonAtomic } from './lib.mjs';

export async function refreshBilling(root) {
  const config = await loadConfig(root);
  const endpoint = String(config.billing?.endpoint || '').trim();
  if (!endpoint) throw new Error('Set billing.endpoint before refreshing Cursor billing data.');
  const token = config.billing?.tokenEnv ? process.env[config.billing.tokenEnv] : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.billing.timeoutMs);
  try {
    const response = await fetch(endpoint, {
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Billing endpoint returned HTTP ${response.status}`);
    const body = await response.json();
    const data = body.usage || body.data || body;
    const billing = {
      fetchedAt: new Date().toISOString(),
      source: endpoint,
      usedUsd: numberOrNull(data.usedUsd ?? data.used_usd ?? data.spend ?? data.total),
      limitUsd: numberOrNull(data.limitUsd ?? data.limit_usd ?? data.budget),
      quotaUsed: numberOrNull(data.quotaUsed ?? data.quota_used ?? data.used),
      quotaLimit: numberOrNull(data.quotaLimit ?? data.quota_limit ?? data.quota),
      resetAt: data.resetAt || data.reset_at || data.nextResetAt || null,
      raw: data,
    };
    await writeJsonAtomic(pathsFor(root).billing, billing);
    return billing;
  } finally {
    clearTimeout(timer);
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refreshBilling(process.env.CURSOR_CONFIG_DIR || undefined)
    .then((value) => console.log(JSON.stringify(value, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
