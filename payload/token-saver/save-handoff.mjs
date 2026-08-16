#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cursorRoot, pathsFor } from './lib.mjs';

const REQUIRED = [
  'Current goal',
  'Accepted decisions',
  'Modified files',
  'Validation completed',
  'Unresolved issues',
  'Next action',
];

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const fileArg = process.argv[2];
  const content = (fileArg ? await readFile(fileArg, 'utf8') : await stdinText()).trim();
  if (!content) throw new Error('Provide handoff Markdown on stdin or as a file argument.');
  if (content.length > 8000) throw new Error(`Handoff is ${content.length} characters; maximum is 8000.`);
  const missing = REQUIRED.filter((heading) => !new RegExp(`^#{1,3}\\s+${heading}\\s*$`, 'im').test(content));
  if (missing.length) throw new Error(`Missing required headings: ${missing.join(', ')}`);
  const dir = pathsFor(cursorRoot()).handoffs;
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(dir, `${stamp}.md`);
  await writeFile(output, `${content}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(output);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
