import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the tender dashboard.
 *
 * THE BFF IS NOT RUN, AND NEITHER IS POSTGRES. Every `/api/**` call is fulfilled by
 * `page.route` from a fixture in the spec. That is a deliberate trade: what these
 * tests are for is the page's own behaviour — that a pending package offers an
 * approval control and a confirmed one does not, that the control opens the Step 1
 * editor for THAT package alone, and that confirming sends the selection the server
 * expects — and none of that is a question about SQL. The SQL half is covered where
 * it can actually be exercised, by the integration tests under apps/bff against a
 * live database.
 *
 * It also means these run in CI with nothing but node, and cannot go red because a
 * dev database drifted.
 *
 * OIDC IS LEFT UNCONFIGURED ON PURPOSE. `auth.ts` builds a UserManager only when
 * VITE_OIDC_AUTHORITY and VITE_OIDC_CLIENT_ID are set; with neither, `accessToken()`
 * resolves undefined and the app renders without a sign-in redirect. Nothing is
 * stubbed to achieve that — it is the app's own behaviour when it is not told where
 * to authenticate.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5198',
    trace: 'retain-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The port is pinned so the intercept pattern and the base URL cannot drift apart,
    // and `--strictPort` makes a clash an error rather than a silent move to the next
    // port that every route match would then miss. 5198 rather than BuildFlow's 5199,
    // so the two repos' suites can run side by side.
    //
    // `localhost`, not `127.0.0.1`: vite binds the hostname rather than the address,
    // and on Windows `localhost` resolves to ::1, so a 127.0.0.1 health check never
    // connects and the run dies on "Timed out waiting for config.webServer" with the
    // server sitting there serving fine.
    command: 'npx vite --port 5198 --strictPort',
    url: 'http://localhost:5198',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
