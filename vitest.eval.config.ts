import { defineConfig } from 'vitest/config';

/**
 * The strategist evaluation, kept out of `npm test` on purpose.
 *
 * It calls a real model over the network and costs real money, so it must
 * never run as part of the ordinary suite. Answers are cached on disk, which
 * makes a re-run free, but a cache miss is a paid call and the timeout has to
 * allow for a model that thinks before it answers.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/eval/**/*.eval.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // One selection at a time, so the printed report reads in draft order.
    fileParallelism: false,
    maxConcurrency: 1,
  },
});
