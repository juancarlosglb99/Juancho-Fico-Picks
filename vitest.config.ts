import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The `@/…` specifier the application imports itself by, so a component can
  // be pulled into a test without rewriting its imports.
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // `.tsx` so a component can be rendered and asserted on. Rendering to
    // static markup needs no DOM, so the environment stays `node`.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
