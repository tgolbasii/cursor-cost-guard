#!/usr/bin/env node
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const options = { context: 4, maxMatches: 12, maxChars: 16000, query: null, paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--context') options.context = Number(argv[++index]);
    else if (value === '--max-matches') options.maxMatches = Number(argv[++index]);
    else if (value === '--max-chars') options.maxChars = Number(argv[++index]);
    else if (!options.query) options.query = value;
    else options.paths.push(value);
  }
  if (!options.query || !Number.isFinite(options.context) || !Number.isFinite(options.maxMatches) || !Number.isFinite(options.maxChars)) {
    throw new Error('Usage: select-context.mjs [--context 4] [--max-matches 12] [--max-chars 16000] <query> [path ...]');
  }
  if (!options.paths.length) options.paths.push('.');
  return options;
}

function bounded(text, maxChars) {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[truncated locally at ${maxChars.toLocaleString()} characters]\n`;
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const args = [
    '--line-number',
    '--with-filename',
    '--no-heading',
    '--color', 'never',
    '--context', String(options.context),
    '--max-count', String(options.maxMatches),
    '--', options.query,
    ...options.paths,
  ];
  const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  const errors = [];
  let length = 0;
  child.stdout.on('data', (chunk) => {
    if (length < options.maxChars * 2) chunks.push(chunk);
    length += chunk.length;
  });
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0 && code !== 1) throw new Error(Buffer.concat(errors).toString('utf8') || `rg exited ${code}`);
  const raw = Buffer.concat(chunks).toString('utf8');
  const matchLines = raw.split(/\r?\n/);
  let matches = 0;
  const selected = [];
  for (const line of matchLines) {
    if (/^.+:\d+:/.test(line)) matches += 1;
    if (matches > options.maxMatches) break;
    selected.push(line);
  }
  process.stdout.write(bounded(selected.join('\n'), options.maxChars));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
