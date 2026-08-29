import type { NextConfig } from 'next';

/**
 * `standalone` emits `dist/standalone/server.js` - a Node server with its own
 * `node_modules` and `public` beside it. That single directory is the whole
 * production artefact, which is what makes the container in Phase C small and
 * its start command a single `node`.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
};

export default nextConfig;
