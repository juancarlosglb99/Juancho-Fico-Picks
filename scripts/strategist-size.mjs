#!/usr/bin/env node
/**
 * Breaks the strategist prompt down by section.
 *
 *     npm run strategist:size [draftId] [pickNo]
 *
 * Uses the API's own token counter, which is a cheap call and not a generation.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    process.env[key] = raw.replace(/^["']|["']$/g, '');
  }
}
loadEnvFile(resolve('.env.local'));

const [draftId, pickNo] = process.argv.slice(2);
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set (shell or .env.local).');
  process.exit(2);
}
const result = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'vitest.eval.config.ts', 'tests/eval/context-size.eval.ts', '--reporter=verbose'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(draftId ? { JUANCHO_SIZE_DRAFT: draftId } : {}),
      ...(pickNo ? { JUANCHO_SIZE_PICK: pickNo } : {}),
    },
  },
);
process.exit(result.status ?? 1);
