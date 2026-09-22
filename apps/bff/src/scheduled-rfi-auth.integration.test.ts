/**
 * The four /internal/scheduled/rfi/* routes (issue #41): who may call them, and
 * that they simply do not exist without their own prerequisites.
 *
 *   DATABASE_URL=postgresql://buildflow:buildflow@localhost:5433/buildflow \
 *     pnpm --filter @tps/bff exec vitest run src/scheduled-rfi-auth.integration.test.ts
 *
 * Same auth doctrine as scheduled-auth.integration.test.ts (bearer AND signature,
 * because infra/docker/nginx-web.conf forwards every /tps-api/ path) — this file
 * adds the one thing that doctrine's own tests cannot cover: these routes have a
 * SECOND, independent prerequisite (BUILDFLOW_BASE_URL + BUILDFLOW_DOCUMENT_LINKS_TOKEN,
 * i.e. rfiDb being constructed at all), so a deployment with reminders working but
 * RFI drafting not configured must show the reminder routes and hide these ones —
 * never the reverse, and never a 500 where a 404 is the honest answer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { signInboundRequest } from './inboundEmail.js';

const { DATABASE_URL } = process.env;

const TOKEN = 'scheduled-token-0123456789';
const SECRET = 'scheduled-signing-secret-0123456789abcdef';

const baseEnv = (extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    AUTH_DISABLED: 'true',
    TOKEN_ENCRYPTION_KEY: 'x'.repeat(32),
    DATABASE_URL: DATABASE_URL!,
    LOG_LEVEL: 'silent',
    TEST_EMAIL_FLAG: 'N',
    SCHEDULED_TASKS_TOKEN: undefined,
    SCHEDULED_TASKS_SIGNING_SECRET: undefined,
    BUILDFLOW_BASE_URL: undefined,
    BUILDFLOW_DOCUMENT_LINKS_TOKEN: undefined
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]; else env[key] = value;
  }
  return env;
};

describe('the RFI scheduled-tasks routes', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const PENDING_EXTRACTION = '/internal/scheduled/rfi/pending-extraction';
  const QUESTIONS = '/internal/scheduled/rfi/questions';
  const PENDING_DRAFTS = '/internal/scheduled/rfi/pending-drafts';
  const DRAFTS = '/internal/scheduled/rfi/drafts';

  function signed(app: Awaited<ReturnType<typeof createApp>>, url: string, payload: unknown, over: { token?: string } = {}) {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return app.inject({
      method: 'POST', url, payload: body,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${over.token ?? TOKEN}`,
        'x-tps-timestamp': timestamp,
        'x-tps-signature': signInboundRequest(SECRET, timestamp, body)
      }
    });
  }

  describe('when both the scheduled-tasks pair AND the BuildFlow pair are configured', () => {
    let app: Awaited<ReturnType<typeof createApp>>;
    beforeAll(async () => {
      app = await createApp(loadConfig(baseEnv({
        SCHEDULED_TASKS_TOKEN: TOKEN, SCHEDULED_TASKS_SIGNING_SECRET: SECRET,
        BUILDFLOW_BASE_URL: 'https://buildflow.example.invalid', BUILDFLOW_DOCUMENT_LINKS_TOKEN: 'a-buildflow-token'
      })));
    });
    afterAll(async () => { await app?.close(); });

    it('accepts a correctly signed empty-body request to pending-extraction', async () => {
      const response = await signed(app, PENDING_EXTRACTION, {});
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('messages');
    });

    it('accepts a correctly signed empty-body request to pending-drafts', async () => {
      const response = await signed(app, PENDING_DRAFTS, {});
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty('questions');
    });

    it('refuses an unsigned request to any of the four routes', async () => {
      for (const url of [PENDING_EXTRACTION, QUESTIONS, PENDING_DRAFTS, DRAFTS]) {
        const response = await app.inject({ method: 'POST', url, payload: '{}', headers: { 'content-type': 'application/json' } });
        expect(response.statusCode, url).toBe(401);
      }
    });

    it('refuses the right signature under the wrong bearer token', async () => {
      const response = await signed(app, PENDING_EXTRACTION, {}, { token: 'wrong-token' });
      expect(response.statusCode).toBe(401);
    });

    it('validates the shape of a questions payload and refuses a malformed one', async () => {
      const response = await signed(app, QUESTIONS, { extractions: [{ messageId: 'not-a-uuid', questions: [] }] });
      expect(response.statusCode).toBe(422);
    });

    it('validates the shape of a drafts payload and refuses a malformed one', async () => {
      const response = await signed(app, DRAFTS, { drafts: [{ questionId: 'not-a-uuid', status: 'not-a-real-status' }] });
      expect(response.statusCode).toBe(422);
    });

    it('accepts a well-formed empty questions/drafts batch', async () => {
      expect((await signed(app, QUESTIONS, { extractions: [] })).statusCode).toBe(200);
      expect((await signed(app, DRAFTS, { drafts: [] })).statusCode).toBe(200);
    });
  });

  describe('when the scheduled-tasks pair is set but the BuildFlow pair is not', () => {
    it('does not register the RFI routes at all — a 404, never a 500', async () => {
      const app = await createApp(loadConfig(baseEnv({ SCHEDULED_TASKS_TOKEN: TOKEN, SCHEDULED_TASKS_SIGNING_SECRET: SECRET })));
      try {
        const response = await signed(app, PENDING_EXTRACTION, {});
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });

    it('still registers the (unrelated) reminder routes — a half-configured deployment loses only RFI drafting', async () => {
      const app = await createApp(loadConfig(baseEnv({ SCHEDULED_TASKS_TOKEN: TOKEN, SCHEDULED_TASKS_SIGNING_SECRET: SECRET })));
      try {
        const response = await signed(app, '/internal/scheduled/itt-reminders/run', {});
        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  describe('when neither pair is configured', () => {
    it('none of the routes exist', async () => {
      const app = await createApp(loadConfig(baseEnv()));
      try {
        const response = await signed(app, PENDING_EXTRACTION, {});
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
      }
    });
  });
});
