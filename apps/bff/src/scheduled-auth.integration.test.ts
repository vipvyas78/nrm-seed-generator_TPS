/**
 * The scheduled-tasks routes: who may call them, and what an unsigned or replayed request gets.
 *
 *   DATABASE_URL=postgresql://buildflow:buildflow@localhost:5433/buildflow \
 *     pnpm --filter @tps/bff exec vitest run src/scheduled-auth.integration.test.ts
 *
 * WHY THIS IS TESTED SO HARD. infra/docker/nginx-web.conf forwards every /tps-api/ path, so
 * these routes are reachable from the internet. What stands between a stranger and "email every
 * subcontractor on every tender" or "mark this firm as having declined" is the bearer AND the
 * signature - and a route that quietly stopped checking one of them would still work perfectly
 * for its legitimate caller. Nothing else would notice.
 *
 * The routes are called with `app.inject`, so the real Fastify parsing, the raw-body capture the
 * signature covers, and the real handlers all run. Nothing is emailed: no mail provider is
 * configured, and no organisation in this database has reminders switched on for this test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { signInboundRequest } from './inboundEmail.js';

const { DATABASE_URL } = process.env;

const TOKEN = 'scheduled-token-0123456789';
const SECRET = 'scheduled-signing-secret-0123456789abcdef';

/**
 * A config environment. A value of `undefined` REMOVES the variable: "unset" has to mean absent,
 * because an empty string is not unset - it would fail the secret's minimum length.
 */
const baseEnv = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    AUTH_DISABLED: 'true',
    TOKEN_ENCRYPTION_KEY: 'x'.repeat(32),
    DATABASE_URL: DATABASE_URL!,
    LOG_LEVEL: 'silent',
    // Test mode OFF: `asOf` must be ignored, which one case below relies on.
    TEST_EMAIL_FLAG: 'N',
    // Whatever the developer's shell has set must not leak in and change what is under test.
    SCHEDULED_TASKS_TOKEN: undefined,
    SCHEDULED_TASKS_SIGNING_SECRET: undefined
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]; else env[key] = value;
  }
  return env;
};

describe('the scheduled-tasks routes', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  let app: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => {
    app = await createApp(loadConfig(baseEnv({ SCHEDULED_TASKS_TOKEN: TOKEN, SCHEDULED_TASKS_SIGNING_SECRET: SECRET })));
  });
  afterAll(async () => { await app?.close(); });

  const RUN = '/internal/scheduled/itt-reminders/run';
  const PENDING = '/internal/scheduled/itt-replies/pending';
  const VERDICTS = '/internal/scheduled/itt-replies/verdicts';

  /** A correctly signed request, the way novamerx-scheduled-tasks builds one. */
  function signed(url: string, payload: unknown, over: { token?: string; timestamp?: string; signBody?: string; sendBody?: string } = {}) {
    const body = over.sendBody ?? JSON.stringify(payload);
    const timestamp = over.timestamp ?? String(Math.floor(Date.now() / 1000));
    return app.inject({
      method: 'POST', url, payload: body,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${over.token ?? TOKEN}`,
        'x-tps-timestamp': timestamp,
        'x-tps-signature': signInboundRequest(SECRET, timestamp, over.signBody ?? body)
      }
    });
  }

  it.each([RUN, PENDING])('accepts a correctly signed request to %s', async (url) => {
    const response = await signed(url, {});
    expect(response.statusCode).toBe(200);
  });

  it('accepts a signed request whose body is empty', async () => {
    // The scheduler may POST with no payload at all; the signature then covers zero bytes.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({
      method: 'POST', url: RUN, payload: '',
      headers: {
        'content-type': 'application/json', authorization: `Bearer ${TOKEN}`,
        'x-tps-timestamp': timestamp, 'x-tps-signature': signInboundRequest(SECRET, timestamp, '')
      }
    });
    expect(response.statusCode).toBe(200);
  });

  describe.each([RUN, PENDING, VERDICTS])('%s refuses', (url) => {
    it('a request with no credentials at all', async () => {
      const response = await app.inject({ method: 'POST', url, payload: '{}', headers: { 'content-type': 'application/json' } });
      expect(response.statusCode).toBe(401);
    });

    it('the right signature under the wrong bearer', async () => {
      expect((await signed(url, {}, { token: 'a-different-token-0123456789' })).statusCode).toBe(401);
    });

    it('the right bearer with no signature - a leaked token alone is not enough', async () => {
      const response = await app.inject({
        method: 'POST', url, payload: '{}',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe('BAD_SIGNATURE');
    });

    it('a body that was changed after it was signed', async () => {
      const response = await signed(url, {}, { signBody: '{"a":1}', sendBody: '{"a":2}' });
      expect(response.statusCode).toBe(401);
      expect(response.json().message).toMatch(/mismatch/);
    });

    it('a signature made with the wrong secret', async () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await app.inject({
        method: 'POST', url, payload: '{}',
        headers: {
          'content-type': 'application/json', authorization: `Bearer ${TOKEN}`,
          'x-tps-timestamp': timestamp, 'x-tps-signature': signInboundRequest('not-the-secret-0123456789abcdefghij', timestamp, '{}')
        }
      });
      expect(response.statusCode).toBe(401);
    });

    // The window is refused in BOTH directions. A one-sided window would let a captured
    // request be replayed for as long as a forged clock claimed.
    it.each([[-10 * 60, 'ten minutes old'], [10 * 60, 'ten minutes in the future']] as Array<[number, string]>)('a request %s seconds from now (%s)', async (skew) => {
      const timestamp = String(Math.floor(Date.now() / 1000) + skew);
      const response = await signed(url, {}, { timestamp });
      expect(response.statusCode).toBe(401);
      expect(response.json().message).toMatch(/stale/);
    });
  });

  it('validates the verdicts it is given', async () => {
    const bad = { verdicts: [{ messageId: 'not-a-uuid', verdict: 'maybe', confidence: 2 }] };
    expect((await signed(VERDICTS, bad)).statusCode).toBe(422);
  });

  it('answers an unknown message without error, and applies nothing', async () => {
    const good = { verdicts: [{
      messageId: '00000000-0000-4000-8000-000000000000', verdict: 'will_tender', confidence: 0.99,
      evidence: 'yes', model: 'test'
    }] };
    const response = await signed(VERDICTS, good);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcomes).toEqual([
      { messageId: '00000000-0000-4000-8000-000000000000', applied: false, reason: 'unknown_message' }
    ]);
  });

  it('ignores a caller-chosen asOf outside test mode', async () => {
    // `asOf` is how a four-week timeline is simulated, and it must not be a way for a caller
    // to move the clock on a live deployment.
    const response = await signed(RUN, { asOf: '2020-01-01T00:00:00.000Z' });
    expect(response.statusCode).toBe(200);
    expect(new Date(response.json().asOf).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  describe('when the secrets are not both configured', () => {
    it('does not register the routes at all', async () => {
      const bare = await createApp(loadConfig(baseEnv()));
      try {
        const response = await bare.inject({ method: 'POST', url: RUN, payload: '{}', headers: { 'content-type': 'application/json' } });
        // Absent, not merely unauthorised: with nothing configured there is no route to attack.
        expect(response.statusCode).toBe(404);
      } finally {
        await bare.close();
      }
    });

    it.each([
      [{ SCHEDULED_TASKS_TOKEN: TOKEN }, 'a token with no signing secret'],
      [{ SCHEDULED_TASKS_SIGNING_SECRET: SECRET }, 'a signing secret with no token']
    ] as Array<[Record<string, string>, string]>)('refuses to boot with %s', (env) => {
      // Half-configured is the dangerous state: a bearer alone would still serve the route.
      expect(() => loadConfig(baseEnv(env))).toThrow(/must be set together/);
    });
  });
});
