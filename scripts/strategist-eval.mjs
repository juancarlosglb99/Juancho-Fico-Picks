#!/usr/bin/env node
/**
 * Runs the strategist against selections from the saved corpus.
 *
 *     npm run strategist:eval -- <draftId>               the disputed selections
 *     npm run strategist:eval -- <draftId> 69 89         specific selections
 *     npm run strategist:eval -- <draftId> --all         every selection we own
 *     npm run strategist:eval -- <draftId> --list        find them, call nothing
 *     npm run strategist:eval -- <draftId> 69 --refresh  ignore the cache
 *     npm run strategist:eval -- <draftId> 69 --blind    hide the deterministic verdict
 *     npm run strategist:eval -- <draftId> 69 --concise  ask for the short response contract
 *
 * Nothing here touches the live recommendation path. The strategist's answer is
 * computed, put through the guardrails and printed for comparison against First
 * Seed and our deterministic engine - never applied.
 *
 * Answers are cached by the exact payload sent, so a re-run costs nothing until
 * the playbook, the brief or the compression changes.
 *
 * The key is read from the environment, or from a gitignored `.env.local`:
 *
 *     ANTHROPIC_API_KEY=sk-ant-...
 *     JUANCHO_STRATEGIST_MODEL=claude-opus-5    # optional
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Loads a local env file without adding a dependency, and never overrides the shell. */
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

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const positional = args.filter((arg) => !arg.startsWith('--'));
const [draftId, ...picks] = positional;

if (!draftId) {
  console.error('Usage: npm run strategist:eval -- <draftId> [pickNumbers...] [--all|--list|--refresh]');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY && !flags.has('--list')) {
  console.error(
    'ANTHROPIC_API_KEY is not set.\n' +
      '  export it in your shell, or put it in .env.local (gitignored):\n' +
      '    ANTHROPIC_API_KEY=sk-ant-...\n' +
      '  Or run with --list to find the disputed selections without calling anything.',
  );
  process.exit(2);
}

const result = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'vitest.eval.config.ts', '--reporter=verbose'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      JUANCHO_EVAL_DRAFT: draftId,
      JUANCHO_EVAL_PICKS: picks.join(','),
      JUANCHO_EVAL_ALL: flags.has('--all') ? '1' : '',
      JUANCHO_EVAL_LIST: flags.has('--list') ? '1' : '',
      JUANCHO_EVAL_REFRESH: flags.has('--refresh') ? '1' : '',
      JUANCHO_EVAL_BLIND: flags.has('--blind') ? '1' : '',
      JUANCHO_EVAL_CONCISE: flags.has('--concise') ? '1' : '',
    },
  },
);
process.exit(result.status ?? 1);
