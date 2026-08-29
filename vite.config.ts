/**
 * Build configuration, targeting Node.
 *
 * The project was scaffolded onto Cloudflare Workers, and this used to run
 * route handlers inside workerd through `@cloudflare/vite-plugin`. That is
 * incompatible with where the product is going in two ways at once: the
 * deployment target is DigitalOcean App Platform, which is a Node runtime, and
 * user accounts need a TCP connection to Postgres, which workerd does not have
 * without Hyperdrive in front of it.
 *
 * `vinext` supports both platforms, so the fix was to stop asking for the one
 * we do not want. What that costs is the Cloudflare deploy path; what it buys
 * is that the same runtime serves `npm run dev`, `vinext start`, and the
 * container in Phase C - and that an ordinary Postgres driver, an ordinary
 * session cookie and ordinary Node crypto all simply work.
 *
 * `output: 'standalone'` in `next.config.ts` emits `dist/standalone/server.js`,
 * a self-contained Node server, which is what the production image runs.
 */
import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

export default defineConfig({
  css: { postcss: { plugins: [tailwindcss()] } },
  server: isCodexSeatbeltSandbox
    ? { watch: { useFsEvents: false, usePolling: true } }
    : undefined,
  plugins: [vinext(), sites()],
});
