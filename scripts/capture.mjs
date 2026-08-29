#!/usr/bin/env node
/**
 * Thin wrapper so `npm run capture -- <draft> <username>` reads naturally.
 * Everything real happens in scripts/capture-mock.ts, executed through vitest
 * because the project has no other TypeScript runner.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: npm run capture -- "<draft link or id>" "<sleeper username>"');
  process.exit(1);
}

const result = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'vitest.capture.config.ts', '--reporter=verbose'],
  { stdio: 'inherit', env: { ...process.env, CAPTURE_ARGS: args.join(' ') } },
);
process.exit(result.status ?? 1);
