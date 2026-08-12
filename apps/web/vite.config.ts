import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Vite defaults envDir to this package, which holds no .env — the repo has a single
  // root .env, the same one the BFF reads via --env-file=../../.env. Without this the dev
  // server sees no VITE_DEV_* at all, so the web client sends no dev auth headers and
  // every request to the BFF comes back 401. Docker is unaffected: Dockerfile.web passes
  // the values as build ARGs.
  envDir: '../..',
  server: { port: 5175 },
  build: { sourcemap: true }
});
