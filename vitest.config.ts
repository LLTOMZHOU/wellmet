import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./test-support/cloudflare-workers.ts', import.meta.url)) },
  },
  test: {
    // Process the OAuth library through Vite so its runtime import uses the stand-in above.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
