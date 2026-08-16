#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { loadConfig, pathsFor, readJson } from './lib.mjs';

const root = process.env.CURSOR_CONFIG_DIR || undefined;
const paths = pathsFor(root);
const port = Number(process.argv[2] || 4173);

async function snapshot() {
  const config = await loadConfig(root);
  const billing = await readJson(paths.billing, null);
  const limits = await readJson(paths.limits, {});
  const conversations = [];
  try {
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(paths.state);
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      const state = await readJson(`${paths.state}/${name}`, null);
      if (state) conversations.push({ ...state, limit: limits[state.conversationHash] || null });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  conversations.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  let anomalies = [];
  try {
    anomalies = (await readFile(paths.anomalies, 'utf8')).trim().split('\n').filter(Boolean).slice(-50).map(JSON.parse).reverse();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { version: config.packageVersion, mode: config.mode, billing, conversations, anomalies };
}

const html = `<!doctype html><meta charset="utf-8"><title>Cursor Cost Guard</title>
<style>body{font:14px system-ui;margin:2rem;max-width:1100px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.5rem;text-align:left}.muted{color:#666}.warn{color:#a50}.bad{color:#b00}</style>
<h1>Cursor Cost Guard</h1><p id="summary" class="muted">Loading…</p><h2>Conversations</h2><table><thead><tr><th>Hash</th><th>Model</th><th>Prompts</th><th>Estimated cost</th><th>Limit</th><th>Last seen</th></tr></thead><tbody id="conversations"></tbody></table><h2>Alerts</h2><pre id="alerts" class="muted"></pre>
<script>async function refresh(){const d=await fetch('/api/status').then(r=>r.json());const b=d.billing||{};document.querySelector('#summary').textContent='Mode: '+d.mode+' · Billing: '+(b.usedUsd==null?'not reconciled':('$'+b.usedUsd+' / '+(b.limitUsd==null?'?':('$'+b.limitUsd))+' · reset '+(b.resetAt||'unknown')));document.querySelector('#conversations').innerHTML=d.conversations.map(c=>'<tr><td>'+c.conversationHash+'</td><td>'+((c.lastModel)||'unknown')+'</td><td>'+c.acceptedPromptsTotal+'</td><td>$'+(c.estimatedSessionCostUsd||0).toFixed(4)+'</td><td>'+(c.limit?.maxSessionCostUsd?'$'+c.limit.maxSessionCostUsd:'—')+'</td><td>'+c.lastSeenAt+'</td></tr>').join('');document.querySelector('#alerts').textContent=d.anomalies.map(a=>a.at+' '+a.kind+' '+JSON.stringify(a.reasons||'')).join('\n')||'No alerts';}refresh();setInterval(refresh,15000);</script>`;

createServer(async (request, response) => {
  if (request.url === '/api/status') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(await snapshot()));
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
}).listen(port, '127.0.0.1', () => console.log(`Cursor Cost Guard dashboard: http://127.0.0.1:${port}`));
