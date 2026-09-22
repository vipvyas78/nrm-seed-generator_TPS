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
    // Tests live under tests/unit (vitest) and tests/e2e (Playwright) rather than beside
    // src/ or under it — issue #48's test relocation. The exclude is still needed for the
    // same reason it always was: vitest's default glob would otherwise also collect the
    // Playwright specs, which import @playwright/test, and fail with "Playwright Test did
    // not expect test() to be called here" while still reporting the rest as passed.
    // Playwright owns tests/e2e (its testDir); vitest owns tests/unit.
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**']
  }
});
