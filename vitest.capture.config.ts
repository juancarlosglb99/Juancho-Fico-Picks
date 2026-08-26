import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/capture/**/*.run.ts'],
    testTimeout: 600_000,
  },
});
