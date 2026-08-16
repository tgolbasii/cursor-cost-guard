#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { cursorRoot, pathsFor } from './lib.mjs';

function parseArgs(argv) {
  let maxChars = 16000;
  const separator = argv.indexOf('--');
  const before = separator >= 0 ? argv.slice(0, separator) : [];
  const command = separator >= 0 ? argv.slice(separator + 1) : argv;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === '--max-chars') maxChars = Number(before[++index]);
  }
  if (!command.length || !Number.isFinite(maxChars) || maxChars < 1000) {
    throw new Error('Usage: capped-command.mjs [--max-chars 16000] -- <command> [args ...]');
  }
  return { maxChars, executable: command[0], args: command.slice(1) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const logDir = pathsFor(cursorRoot()).logs;
  await mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logDir, `${stamp}-${process.pid}.log`);
  const stream = createWriteStream(logFile, { flags: 'wx' });
  const child = spawn(options.executable, options.args, { stdio: ['inherit', 'pipe', 'pipe'] });
  const headLimit = Math.floor(options.maxChars * 0.6);
  const tailLimit = options.maxChars - headLimit;
  let head = '';
  let tail = '';
  let total = 0;
  const consume = (label) => (chunk) => {
    const text = `${label}${chunk.toString('utf8')}`;
    stream.write(text);
    total += text.length;
    if (head.length < headLimit) head += text.slice(0, headLimit - head.length);
    tail = `${tail}${text}`.slice(-tailLimit);
  };
  child.stdout.on('data', consume(''));
  child.stderr.on('data', consume('[stderr] '));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  await new Promise((resolve) => stream.end(resolve));
  if (total <= options.maxChars) process.stdout.write(head + tail.slice(Math.max(0, total - head.length)));
  else {
    process.stdout.write(`${head}\n\n[${(total - options.maxChars).toLocaleString()} characters omitted; full output: ${logFile}]\n\n${tail}`);
  }
  process.exitCode = Number(code) || 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
