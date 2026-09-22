/**
 * The estimator's RFI review routes (issue #48) — the first `app.inject` test for any
 * `/api/tender-prep/*` route, real PostgreSQL, real auth (`AUTH_DISABLED` dev headers,
 * the same route `auth.ts` takes when there is no OIDC provider to talk to).
 *
 *   DATABASE_URL=postgresql://buildflow:buildflow@localhost:5433/buildflow \
 *     pnpm --filter @tps/bff exec vitest run tests/integration/rfi-review-routes.integration.test.ts
 *
 * The business logic (the read model, the dispositions, the send, re-attribution) is
 * `rfi-review.integration.test.ts`'s job, exercised directly against `RfiDatabase` /
 * `TenderPrepDatabase`. What only a real HTTP round trip can prove, and what this file
 * exists for: 422 on a malformed body, 404 across an organisation boundary, 409 on a
 * cross-tender send reaching all the way through the route layer — and the one thing
 * nothing else asserts, that these routes exist WITHOUT `BUILDFLOW_BASE_URL` /
 * `BUILDFLOW_DOCUMENT_LINKS_TOKEN` configured, at the exact same time
 * `/internal/scheduled/rfi/*` 404s for lacking them. That asymmetry (rfiDb now
 * unconditionally constructed; the scheduled routes still gated on the BuildFlow pair) is
 * the whole of issue #48's wiring decision, and nothing else checks it end to end.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig, loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';

const { DATABASE_URL } = process.env;

describe('the RFI review routes', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const baseEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    NODE_ENV: 'test',
    AUTH_DISABLED: 'true',
    TOKEN_ENCRYPTION_KEY: 'x'.repeat(32),
    DATABASE_URL: DATABASE_URL!,
    LOG_LEVEL: 'silent',
    TEST_EMAIL_FLAG: 'N',
    // Deliberately unset: proves the RFI review routes exist without them, unlike the
    // /internal/scheduled/rfi/* pair, which needs both.
    SCHEDULED_TASKS_TOKEN: undefined,
    SCHEDULED_TASKS_SIGNING_SECRET: undefined,
    BUILDFLOW_BASE_URL: undefined,
    BUILDFLOW_DOCUMENT_LINKS_TOKEN: undefined
  });

  let app: Awaited<ReturnType<typeof createApp>>;
  const db = new Database(loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' }));

  const ownerExternalId = `rfi-route-owner-${randomUUID()}`;
  const strangerExternalId = `rfi-route-stranger-${randomUUID()}`;
  const ownerHeaders = { 'x-buildflow-dev-subject': 'test-estimator', 'x-buildflow-dev-organization': ownerExternalId };
  const strangerHeaders = { 'x-buildflow-dev-subject': 'test-stranger', 'x-buildflow-dev-organization': strangerExternalId };

  let ownerOrgId = '';
  let strangerOrgId = '';
  let workflowId = '';
  let foreignWorkflowId = '';
  let questionId = '';
  let foreignQuestionId = '';

  beforeAll(async () => {
    app = await createApp(loadConfig(baseEnv()));

    // provisionActor (the AUTH_DISABLED path) upserts on (oidc_issuer, external_id) — so
    // the FIRST authenticated request against each header pair mints these organisations.
    // Seeding the workflow needs the real id first, so one throwaway request per identity
    // establishes it before anything else runs.
    await app.inject({ method: 'GET', url: '/api/tender-prep/workflows', headers: ownerHeaders });
    await app.inject({ method: 'GET', url: '/api/tender-prep/workflows', headers: strangerHeaders });
    ownerOrgId = (await db.one<{ id: string }>(
      `SELECT id FROM public.bf_organizations WHERE oidc_issuer = 'buildflow-dev' AND external_id = $1`, [ownerExternalId]
    )).id;
    strangerOrgId = (await db.one<{ id: string }>(
      `SELECT id FROM public.bf_organizations WHERE oidc_issuer = 'buildflow-dev' AND external_id = $1`, [strangerExternalId]
    )).id;

    const packageId = randomUUID();
    workflowId = (await db.one<{ id: string }>(
      `INSERT INTO workflows (package_id, organization_id, step_data) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [packageId, ownerOrgId]
    )).id;
    const foreignPackageId = randomUUID();
    foreignWorkflowId = (await db.one<{ id: string }>(
      `INSERT INTO workflows (package_id, organization_id, step_data) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [foreignPackageId, ownerOrgId]
    )).id;

    // One question on each of two workflows in the OWNER's own organisation, so the
    // cross-tender check (send from workflowId with a question from foreignWorkflowId)
    // is exercised without also having to cross an organisation boundary at the same time.
    const thread = await db.one<{ id: string }>(
      `INSERT INTO comms.threads (organization_id, workflow_id, counterparty_kind, counterparty_email, counterparty_domain)
       VALUES ($1, $2, 'subcontractor', 'firm@example.test', 'example.test') RETURNING id`,
      [ownerOrgId, workflowId]
    );
    const message = await db.one<{ id: string }>(
      `INSERT INTO comms.messages
         (organization_id, workflow_id, thread_id, direction, channel, kind, author_email, occurred_at)
       VALUES ($1, $2, $3, 'inbound', 'portal', 'subcontractor_rfi', 'firm@example.test', NOW()) RETURNING id`,
      [ownerOrgId, workflowId, thread.id]
    );
    questionId = (await db.one<{ id: string }>(
      `INSERT INTO tps.rfi_questions (message_id, workflow_id, thread_id, seq, source_kind, question_text, raised_at, status, dedupe_hash)
       VALUES ($1, $2, $3, 1, 'body', 'Is the grid included?', NOW(), 'drafted', $4) RETURNING id`,
      [message.id, workflowId, thread.id, `dedupe-${randomUUID()}`]
    )).id;

    const foreignThread = await db.one<{ id: string }>(
      `INSERT INTO comms.threads (organization_id, workflow_id, counterparty_kind, counterparty_email, counterparty_domain)
       VALUES ($1, $2, 'subcontractor', 'other@example.test', 'example.test') RETURNING id`,
      [ownerOrgId, foreignWorkflowId]
    );
    const foreignMessage = await db.one<{ id: string }>(
      `INSERT INTO comms.messages
         (organization_id, workflow_id, thread_id, direction, channel, kind, author_email, occurred_at)
       VALUES ($1, $2, $3, 'inbound', 'portal', 'subcontractor_rfi', 'other@example.test', NOW()) RETURNING id`,
      [ownerOrgId, foreignWorkflowId, foreignThread.id]
    );
    foreignQuestionId = (await db.one<{ id: string }>(
      `INSERT INTO tps.rfi_questions (message_id, workflow_id, thread_id, seq, source_kind, question_text, raised_at, status, dedupe_hash)
       VALUES ($1, $2, $3, 1, 'body', 'Different tender entirely.', NOW(), 'approved', $4) RETURNING id`,
      [foreignMessage.id, foreignWorkflowId, foreignThread.id, `dedupe-${randomUUID()}`]
    )).id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tps.rfi_questions WHERE workflow_id = ANY($1::uuid[])`, [[workflowId, foreignWorkflowId]]);
    await db.query(`DELETE FROM comms.threads WHERE workflow_id = ANY($1::uuid[])`, [[workflowId, foreignWorkflowId]]);
    await db.query(`DELETE FROM workflows WHERE id = ANY($1::uuid[])`, [[workflowId, foreignWorkflowId]]);
    await db.query(
      `DELETE FROM public.bf_organization_memberships WHERE organization_id = ANY($1::uuid[])`, [[ownerOrgId, strangerOrgId]]
    );
    await db.query(`DELETE FROM public.bf_users WHERE oidc_issuer = 'buildflow-dev' AND oidc_subject IN ('test-estimator', 'test-stranger')`);
    await db.query(`DELETE FROM public.bf_organizations WHERE id = ANY($1::uuid[])`, [[ownerOrgId, strangerOrgId]]);
    await db.close();
    await app?.close();
  });

  it('reads the review queue for a workflow this organisation owns', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/tender-prep/${workflowId}/rfi`, headers: ownerHeaders });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.groups.some((g: { questions: Array<{ id: string }> }) => g.questions.some((q) => q.id === questionId))).toBe(true);
  });

  it('refuses another organisation the same read, as a 404', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/tender-prep/${workflowId}/rfi`, headers: strangerHeaders });
    expect(response.statusCode).toBe(404);
  });

  it('422s a malformed questionId rather than reaching the database with one', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/tender-prep/${workflowId}/rfi/questions/not-a-uuid/approve`,
      headers: ownerHeaders, payload: { answerText: 'x' }
    });
    expect(response.statusCode).toBe(422);
  });

  it('422s a client-forward with no clientEmail', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/tender-prep/${workflowId}/rfi/client-forward`,
      headers: ownerHeaders, payload: { questionIds: [questionId] }
    });
    expect(response.statusCode).toBe(422);
  });

  it('approves a question through the route, storing the edited answer text', async () => {
    const approve = await app.inject({
      method: 'POST', url: `/api/tender-prep/${workflowId}/rfi/questions/${questionId}/approve`,
      headers: ownerHeaders, payload: { answerText: 'Yes, per clause 2E.310.' }
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe('approved');
    expect(approve.json().estimator_answer_text).toBe('Yes, per clause 2E.310.');
  });

  it('409s approving a question that has already been dismissed', async () => {
    await db.query(`UPDATE tps.rfi_questions SET status = 'dismissed' WHERE id = $1`, [foreignQuestionId]);
    const response = await app.inject({
      method: 'POST', url: `/api/tender-prep/${foreignWorkflowId}/rfi/questions/${foreignQuestionId}/approve`,
      headers: ownerHeaders, payload: {}
    });
    expect(response.statusCode).toBe(409);
    await db.query(`UPDATE tps.rfi_questions SET status = 'approved' WHERE id = $1`, [foreignQuestionId]);
  });

  it('409s a send whose question ids span two tenders', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/tender-prep/${workflowId}/rfi/responses`,
      headers: ownerHeaders, payload: { questionIds: [questionId, foreignQuestionId] }
    });
    expect(response.statusCode).toBe(409);
  });

  it('re-files a message via /api/comms/messages/:id/attribute, checked against the actor, not the path', async () => {
    const thread = await db.one<{ id: string }>(
      `INSERT INTO comms.threads (organization_id, workflow_id, counterparty_kind, counterparty_email, counterparty_domain)
       VALUES ($1, NULL, 'subcontractor', 'blocked@example.test', 'example.test') RETURNING id`,
      [ownerOrgId]
    );
    const message = await db.one<{ id: string }>(
      `INSERT INTO comms.messages
         (organization_id, workflow_id, thread_id, direction, channel, kind, author_email, occurred_at)
       VALUES ($1, NULL, $2, 'inbound', 'email', 'subcontractor_rfi', 'blocked@example.test', NOW()) RETURNING id`,
      [ownerOrgId, thread.id]
    );

    const response = await app.inject({
      method: 'POST', url: `/api/comms/messages/${message.id}/attribute`,
      headers: ownerHeaders, payload: { workflowId }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().workflow_id).toBe(workflowId);

    await db.query(`DELETE FROM comms.messages WHERE id = $1`, [message.id]);
    await db.query(`DELETE FROM comms.threads WHERE id = $1`, [thread.id]);
  });

  it('exists without the BuildFlow env pair, while /internal/scheduled/rfi/* does not', async () => {
    const read = await app.inject({ method: 'GET', url: `/api/tender-prep/${workflowId}/rfi`, headers: ownerHeaders });
    expect(read.statusCode).toBe(200);

    const scheduled = await app.inject({
      method: 'POST', url: '/internal/scheduled/rfi/pending-extraction',
      headers: { authorization: 'Bearer whatever' }, payload: '{}'
    });
    expect(scheduled.statusCode).toBe(404);
  });
});
