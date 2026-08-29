#!/usr/bin/env node
/**
 * Sweeps the First Seed anchor weight across the saved corpus.
 *
 *     npm run tune:consensus
 *
 * Prints starting-lineup points for Juancho against the First Seed-only
 * baseline at each weight, so the anchor is chosen from evidence rather than
 * taste. Re-run whenever mocks are added.
 */
import { spawnSync } from 'node:child_process';

const weights = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['0', '5', '10', '15', '20', '25', '40'];

console.log('weight  draft   juancho  firstSeed     delta  followed');
for (const weight of weights) {
  const result = spawnSync(
    'npx',
    [
      'vitest', 'run', '--config', 'vitest.config.ts',
      'tests/regression/consensus-sweep.test.ts', '--reporter=verbose',
    ],
    { env: { ...process.env, JUANCHO_CONSENSUS_WEIGHT: weight }, encoding: 'utf8' },
  );
  for (const line of `${result.stdout}`.split('\n')) {
    if (line.includes('[sweep')) console.log(line.trim());
  }
}
