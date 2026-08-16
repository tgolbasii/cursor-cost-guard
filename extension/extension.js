const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const root = process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), '.cursor');
const saver = path.join(root, 'token-saver');
const stateDir = path.join(saver, 'state');
const limitsFile = path.join(saver, 'conversation-limits.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function formatUsd(value) { return `$${Number(value || 0).toFixed(3)}`; }

class Conversations {
  constructor() { this._emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this._emitter.event; }
  refresh() { this._emitter.fire(); }
  getTreeItem(item) { return item; }
  getChildren() {
    const limits = readJson(limitsFile, {});
    let files = [];
    try { files = fs.readdirSync(stateDir).filter((file) => file.endsWith('.json')); } catch {}
    return files.map((file) => readJson(path.join(stateDir, file), null)).filter(Boolean)
      .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
      .map((state) => {
        const limit = limits[state.conversationHash];
        const label = `${state.conversationHash.slice(0, 8)}  ${formatUsd(state.estimatedSessionCostUsd)}`;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = `${state.lastModel || 'unknown'} · ${state.acceptedPromptsTotal || 0} prompts`;
        item.tooltip = `Estimated: ${formatUsd(state.estimatedSessionCostUsd)}${limit?.maxSessionCostUsd ? ` / limit ${formatUsd(limit.maxSessionCostUsd)}` : ''}\nLast seen: ${state.lastSeenAt}`;
        item.contextValue = state.conversationHash;
        return item;
      });
  }
}

function runControl(args) {
  const control = path.join(saver, 'token-saverctl.mjs');
  childProcess.execFile(process.execPath, [control, ...args], { env: process.env }, (error, stdout, stderr) => {
    if (error) vscode.window.showErrorMessage(stderr || error.message);
    else vscode.window.showInformationMessage(stdout.trim());
  });
}

function activate(context) {
  const provider = new Conversations();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'cursorCostGuard.refresh';
  status.show();
  const refresh = () => {
    const config = readJson(path.join(saver, 'config.json'), {});
    const billing = readJson(path.join(saver, 'billing.json'), {});
    const usage = billing.usedUsd == null ? 'n/a' : formatUsd(billing.usedUsd);
    status.text = `$(pulse) Cursor ${usage}${billing.quotaUsed != null ? ` · ${billing.quotaUsed}/${billing.quotaLimit || '?'}` : ''}`;
    status.tooltip = `Mode: ${config.mode || 'unknown'}\nReset: ${billing.resetAt || 'not reconciled'}\nClick to refresh.`;
    provider.refresh();
  };
  const watcher = fs.existsSync(saver) ? fs.watch(saver, { recursive: true }, refresh) : null;
  context.subscriptions.push(status, vscode.window.registerTreeDataProvider('cursorCostGuard.conversations', provider));
  context.subscriptions.push(vscode.commands.registerCommand('cursorCostGuard.refresh', refresh));
  context.subscriptions.push(vscode.commands.registerCommand('cursorCostGuard.refreshBilling', () => runControl(['billing', 'refresh'])));
  context.subscriptions.push(vscode.commands.registerCommand('cursorCostGuard.setConversationLimit', async () => {
    const hash = await vscode.window.showInputBox({ prompt: 'Conversation hash' });
    const usd = await vscode.window.showInputBox({ prompt: 'Maximum estimated session cost in USD' });
    if (hash && usd) runControl(['limit', 'set', hash, usd]);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('cursorCostGuard.clearConversationLimit', async () => {
    const hash = await vscode.window.showInputBox({ prompt: 'Conversation hash' });
    if (hash) runControl(['limit', 'clear', hash]);
  }));
  refresh();
  const timer = setInterval(refresh, 30000);
  context.subscriptions.push({ dispose: () => { clearInterval(timer); watcher?.close(); } });
}

exports.activate = activate;
exports.deactivate = () => {};
