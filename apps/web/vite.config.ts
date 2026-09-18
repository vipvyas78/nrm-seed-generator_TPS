import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Also mounted at /tps/ on the shared dev.novamerx.ai tunnel (infra/docker/nginx-web.conf
  // serves the same build under both / and /tps/), so asset URLs must be prefix-aware.
  base: '/tps/',
  // Vite defaults envDir to this package, which holds no .env — the repo has a single
  // root .env, the same one the BFF reads via --env-file=../../.env. Without this the dev
  // server sees no VITE_DEV_* at all, so the web client sends no dev auth headers and
  // every request to the BFF comes back 401. Docker is unaffected: Dockerfile.web passes
  // the values as build ARGs.
  envDir: '../..',
  server: { port: 5175 },
  build: { sourcemap: true },
  test: {
    // Vitest's default include is every *.test.ts / *.spec.ts under the package, which takes
    // in the Playwright specs in e2e/ — they import @playwright/test, so vitest collects them
    // and fails with "Playwright Test did not expect test() to be called here" while still
    // reporting the rest as passed. Playwright owns e2e/ (its testDir); vitest owns src/.
    include: ['src/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**']
  }
});
