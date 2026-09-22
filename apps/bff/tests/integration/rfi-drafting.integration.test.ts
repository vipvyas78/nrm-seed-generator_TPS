/**
 * RFI collation and drafting end to end (issue #41) — real PostgreSQL, the real
 * `comms` schema, stubbed BuildFlow clients (no network, no live BuildFlow needed).
 *
 * THE ACCEPTANCE TEST FOR THIS ISSUE is the mixed-tender one below: a subcontractor
 * live on two workflows for one organisation, an email attributed by sender_email —
 * asserting ZERO questions, ZERO drafts, and no email, until a human re-attributes
 * it. Everything else (deterministic attribution sails through; the cross-tender
 * name check; the full extract -> question -> draft pipeline) is exercised the same
 * way, against the real eligibility gate and the real schema's constraints.
 *
 *   DATABASE_URL=postgresql://buildflow:buildflow@localhost:5433/buildflow \
 *     pnpm --filter @tps/bff exec vitest run tests/integration/rfi-drafting.integration.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { AttachmentTextResult, BuildflowAttachmentTextClient } from '../../src/buildflowAttachmentTextClient.js';
import type { BuildflowTenderPassagesClient, TenderPassagesResult } from '../../src/buildflowTenderPassagesClient.js';
import { CommsDatabase } from '../../src/commsDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import { RfiDatabase } from '../../src/rfiDb.js';

const { DATABASE_URL } = process.env;

describe('RFI collation and drafting', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
  const db = new Database(config);
  const commsDb = new CommsDatabase(db);

  // Never actually reached in the mixed-tender / cross-tender tests, and stubbed
  // rather than a real HTTP client for the happy-path test — this file proves the
  // GATE and the SCHEMA, not BuildFlow's own endpoints (covered by that repo's own
  // integration tests).
  const noAttachments = { extract: async (): Promise<AttachmentTextResult> => ({ status: 'empty', extractor: null, text: null, charCount: 0, truncated: false, error: null }) } as unknown as BuildflowAttachmentTextClient;
  const noPassages: BuildflowTenderPassagesClient = {
    async search(): Promise<TenderPassagesResult> { return { ready: true, corpus: { documentCount: 1, passageCount: 1, builtAt: new Date().toISOString() }, results: {} }; }
  } as unknown as BuildflowTenderPassagesClient;
  const rfiDb = new RfiDatabase(db, commsDb, noAttachments, noPassages);

  const cleanupIds: { organizationId: string[]; workflowId: string[]; messageId: string[] } = { organizationId: [], workflowId: [], messageId: [] };

  afterAll(async () => {
    if (cleanupIds.workflowId.length) {
      await db.query(`DELETE FROM tps.rfi_drafts WHERE question_id IN (SELECT id FROM tps.rfi_questions WHERE workflow_id = ANY($1::uuid[]))`, [cleanupIds.workflowId]);
      await db.query(`DELETE FROM tps.rfi_questions WHERE workflow_id = ANY($1::uuid[])`, [cleanupIds.workflowId]);
    }
    if (cleanupIds.messageId.length) {
      await db.query(`DELETE FROM tps.rfi_message_reviews WHERE message_id = ANY($1::uuid[])`, [cleanupIds.messageId]);
    }
    if (cleanupIds.workflowId.length) {
      await db.query(`DELETE FROM pricing_portal_links WHERE workflow_id = ANY($1::uuid[])`, [cleanupIds.workflowId]);
      await db.query(`DELETE FROM shortlists WHERE workflow_id = ANY($1::uuid[])`, [cleanupIds.workflowId]);
      await db.query(`DELETE FROM workflows WHERE id = ANY($1::uuid[])`, [cleanupIds.workflowId]);
    }
    if (cleanupIds.organizationId.length) {
      await db.query(`DELETE FROM public.itt_comms_config WHERE organization_id = ANY($1::uuid[])`, [cleanupIds.organizationId]);
      await db.query(`DELETE FROM public.bf_organizations WHERE id = ANY($1::uuid[])`, [cleanupIds.organizationId]);
    }
    await db.close();
  });

  async function seedOrg(name: string): Promise<string> {
    const id = randomUUID();
    await db.query(`INSERT INTO public.bf_organizations (id, oidc_issuer, external_id, name) VALUES ($1, 'test', $2, $3)`, [id, `ext-${id}`, name]);
    await db.query(
      `INSERT INTO public.itt_comms_config (organization_id, project_id, org_slug, itt_from_address, itt_comms_address, client_reply_address)
       VALUES ($1, NULL, $2, 'tenders@novamerx.ai', $3, 'itt-reply@novamerx.co.uk')`,
      [id, `org-${id.slice(0, 8)}`, `org-${id.slice(0, 8)}-ittcomms@novamerx.ai`]
    );
    cleanupIds.organizationId.push(id);
    return id;
  }

  async function seedWorkflow(organizationId: string, projectName: string, tenderReference: string): Promise<string> {
    const packageId = randomUUID();
    const workflow = await db.one<{ id: string }>(
      `INSERT INTO workflows (package_id, organization_id, step_data)
       VALUES ($1, $2, jsonb_build_object('takeoff', jsonb_build_object('projectName', $3::text, 'tenderReference', $4::text, 'tenderName', $3::text, 'packageName', 'Curtain Walling')))
       RETURNING id`,
      [packageId, organizationId, projectName, tenderReference]
    );
    cleanupIds.workflowId.push(workflow.id);
    return workflow.id;
  }

  const shortlistIdByWorkflow = new Map<string, string>();

  /** One shortlist per workflow, reused across firms — shortlists is unique on
   *  (workflow_id, package_name), the same "one package, several rank-ordered
   *  firms" shape a real tender launch produces. */
  async function ensureShortlist(workflowId: string): Promise<string> {
    const cached = shortlistIdByWorkflow.get(workflowId);
    if (cached) return cached;
    const shortlist = await db.one<{ id: string }>(
      `INSERT INTO shortlists (workflow_id, package_name, package_seq, confirmed_at) VALUES ($1, 'Curtain Walling', 1, NOW()) RETURNING id`,
      [workflowId]
    );
    shortlistIdByWorkflow.set(workflowId, shortlist.id);
    return shortlist.id;
  }

  async function seedPortalLink(workflowId: string, recipientEmail: string): Promise<void> {
    const shortlistId = await ensureShortlist(workflowId);
    const rankRow = await db.one<{ n: string }>(`SELECT COUNT(*)::int + 1 AS n FROM shortlist_entries WHERE shortlist_id = $1`, [shortlistId]);
    const entry = await db.one<{ id: string }>(
      `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, selected) VALUES ($1, $2, $3, TRUE) RETURNING id`,
      [shortlistId, randomUUID(), Number(rankRow.n)]
    );
    await db.query(
      `INSERT INTO pricing_portal_links (workflow_id, shortlist_entry_id, package_name, tenderer_name, token, recipient_email, recipient_domain, expires_at)
       VALUES ($1, $2, 'Curtain Walling', 'Test Firm', $3, $4, $5, NOW() + INTERVAL '30 days')`,
      [workflowId, entry.id, randomUUID(), recipientEmail, recipientEmail.split('@')[1]]
    );
  }

  /** Files an inbound RFI message directly through commsDb, the same shape
   *  resolveInbound's sender_email/sender_domain route produces — this test is about
   *  what happens AFTER attribution, so the message is filed pre-attributed. */
  async function seedInboundRfi(input: {
    organizationId: string; workflowId: string; senderEmail: string; bodyText: string;
    attributionMethod: 'sender_email' | 'sender_domain' | 'portal';
  }): Promise<string> {
    const thread = await commsDb.findOrCreateThread({
      organizationId: input.organizationId, workflowId: input.workflowId, counterpartyKind: 'subcontractor',
      counterpartyEmail: input.senderEmail, counterpartyName: 'Test Firm', subcontractorId: null, subject: 'RFI'
    });
    const message = await commsDb.recordMessage({
      threadId: String(thread.id), organizationId: input.organizationId, workflowId: input.workflowId,
      shortlistEntryId: null, direction: 'inbound', channel: input.attributionMethod === 'portal' ? 'portal' : 'email',
      kind: 'subcontractor_rfi', authorName: 'Test Firm', authorEmail: input.senderEmail,
      subject: 'RFI', bodyText: input.bodyText, occurredAt: new Date(),
      attributionMethod: input.attributionMethod === 'portal' ? null : input.attributionMethod,
      dkimResult: 'pass', spfResult: 'pass', dmarcResult: 'pass',
      idempotencyKey: `test-${randomUUID()}`, createdBy: null
    });
    if (!message) throw new Error('recordMessage returned null (idempotency conflict) — test bug');
    cleanupIds.messageId.push(String(message.id));
    return String(message.id);
  }

  it('THE ACCEPTANCE TEST: a sender live on two workflows produces zero questions and zero drafts until re-attributed', async () => {
    const organizationId = await seedOrg('Mixed Tender Org');
    const workflowA = await seedWorkflow(organizationId, 'Reading Gateway', 'RG-2026');
    const workflowB = await seedWorkflow(organizationId, 'Croydon Depot', 'CD-2026');
    const sender = `firm-${randomUUID()}@example.test`;
    await seedPortalLink(workflowA, sender);
    await seedPortalLink(workflowB, sender); // same sender, TWO live workflows — genuinely ambiguous

    const messageId = await seedInboundRfi({
      organizationId, workflowId: workflowA, senderEmail: sender,
      bodyText: 'Will you supply the ironmongery for the ground floor?', attributionMethod: 'sender_email'
    });

    const { messages } = await rfiDb.pendingExtraction(25);
    expect(messages.some((m) => m.messageId === messageId)).toBe(false);

    const [review] = await db.query<{ state: string }>(`SELECT state FROM tps.rfi_message_reviews WHERE message_id = $1`, [messageId]);
    expect(review?.state).toBe('blocked_ambiguous_tender');

    const questionCount = await db.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM tps.rfi_questions WHERE message_id = $1`, [messageId]);
    expect(Number(questionCount[0]!.n)).toBe(0);
  });

  it('re-attributing the message by hand makes it eligible next tick', async () => {
    const organizationId = await seedOrg('Reattribution Org');
    const workflowA = await seedWorkflow(organizationId, 'Reading Gateway 2', 'RG2-2026');
    const workflowB = await seedWorkflow(organizationId, 'Croydon Depot 2', 'CD2-2026');
    const sender = `firm-${randomUUID()}@example.test`;
    await seedPortalLink(workflowA, sender);
    await seedPortalLink(workflowB, sender);

    const messageId = await seedInboundRfi({
      organizationId, workflowId: workflowA, senderEmail: sender,
      bodyText: 'Will you supply the sanitaryware?', attributionMethod: 'sender_email'
    });
    await rfiDb.pendingExtraction(25); // first tick: blocked

    await commsDb.reattributeMessage(messageId, workflowB);
    const [review] = await db.query<{ workflow_id: string; attribution_method: string }>(
      `SELECT m.workflow_id, m.attribution_method FROM comms.messages m WHERE m.id = $1`, [messageId]
    );
    expect(review?.attribution_method).toBe('manual');
    expect(String(review?.workflow_id)).toBe(workflowB);
    // The review row must be deleted (or reset) for a re-attributed message to be
    // reconsidered — pendingExtraction excludes anything already in rfi_message_reviews.
    await db.query(`DELETE FROM tps.rfi_message_reviews WHERE message_id = $1`, [messageId]);

    const { messages } = await rfiDb.pendingExtraction(25);
    const found = messages.find((m) => m.messageId === messageId);
    expect(found).toBeDefined();
    expect(found!.workflowId).toBe(workflowB);
  });

  it('flags a message naming a different live tender than the one it was heuristically attributed to', async () => {
    const organizationId = await seedOrg('Cross Tender Org');
    const workflowA = await seedWorkflow(organizationId, 'Alpha Gateway', 'AG-2026');
    const workflowB = await seedWorkflow(organizationId, 'Beta Depot', 'BD-2026');
    const sender = `firm-${randomUUID()}@example.test`;
    await seedPortalLink(workflowA, sender); // only ONE workflow matches this sender — not ambiguous by count

    const messageId = await seedInboundRfi({
      organizationId, workflowId: workflowA, senderEmail: sender,
      bodyText: 'Following up on our Beta Depot query about the roof access.', attributionMethod: 'sender_email'
    });

    const { messages } = await rfiDb.pendingExtraction(25);
    expect(messages.some((m) => m.messageId === messageId)).toBe(false);
    const [review] = await db.query<{ state: string }>(`SELECT state FROM tps.rfi_message_reviews WHERE message_id = $1`, [messageId]);
    expect(review?.state).toBe('blocked_cross_tender_suspected');
  });

  it('a portal RFI is eligible unconditionally, and the full extract -> question -> draft pipeline runs', async () => {
    const organizationId = await seedOrg('Happy Path Org');
    const workflowId = await seedWorkflow(organizationId, 'Solo Gateway', 'SG-2026');
    const sender = `firm-${randomUUID()}@example.test`;
    await seedPortalLink(workflowId, sender);

    const messageId = await seedInboundRfi({
      organizationId, workflowId, senderEmail: sender,
      bodyText: 'Will you supply the ironmongery for the ground floor?', attributionMethod: 'portal'
    });

    const { messages } = await rfiDb.pendingExtraction(25);
    const pending = messages.find((m) => m.messageId === messageId);
    expect(pending).toBeDefined();
    expect(pending!.bodyText).toContain('ironmongery');

    const { outcomes } = await rfiDb.recordQuestions([{
      messageId, model: 'test-model', droppedCount: 0,
      questions: [{ questionText: 'Will you supply the ironmongery for the ground floor?', sourceKind: 'body', searchTerms: ['ironmongery'] }]
    }]);
    expect(outcomes[0]).toMatchObject({ messageId, accepted: 1, reason: 'applied' });

    const questionRows = await db.query<{ id: string; status: string }>(`SELECT id, status FROM tps.rfi_questions WHERE message_id = $1`, [messageId]);
    expect(questionRows).toHaveLength(1);
    expect(questionRows[0]!.status).toBe('new');
    const questionId = questionRows[0]!.id;

    const { questions } = await rfiDb.pendingDrafts(25);
    expect(questions.some((q) => q.questionId === questionId)).toBe(true);

    const { outcomes: draftOutcomes } = await rfiDb.recordDrafts([{
      questionId, status: 'proposed', answerText: 'Yes, ironmongery is included per clause 2G.310.', confidence: 0.9,
      needsClient: false, citations: [], corpusSessionRef: 'sess-test', passagesOffered: 1, model: 'test-model', promptVersion: 'v1'
    }]);
    expect(draftOutcomes[0]).toMatchObject({ questionId, applied: true, reason: 'proposed' });

    const [finalQuestion] = await db.query<{ status: string }>(`SELECT status FROM tps.rfi_questions WHERE id = $1`, [questionId]);
    expect(finalQuestion?.status).toBe('drafted');
    const draftRows = await db.query<{ status: string; superseded_at: string | null }>(`SELECT status, superseded_at FROM tps.rfi_drafts WHERE question_id = $1`, [questionId]);
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]!.status).toBe('proposed');
    expect(draftRows[0]!.superseded_at).toBeNull();
  });

  it('two firms asking the same question link to a canonical question, without merging their rows', async () => {
    const organizationId = await seedOrg('Dedupe Org');
    const workflowId = await seedWorkflow(organizationId, 'Dedupe Gateway', 'DG-2026');
    const senderA = `firm-a-${randomUUID()}@example.test`;
    const senderB = `firm-b-${randomUUID()}@example.test`;
    await seedPortalLink(workflowId, senderA);
    await seedPortalLink(workflowId, senderB);

    const messageA = await seedInboundRfi({ organizationId, workflowId, senderEmail: senderA, bodyText: 'Will you supply the ironmongery?', attributionMethod: 'portal' });
    const messageB = await seedInboundRfi({ organizationId, workflowId, senderEmail: senderB, bodyText: 'will you supply the ironmongery', attributionMethod: 'portal' });

    await rfiDb.pendingExtraction(25);
    await rfiDb.recordQuestions([
      { messageId: messageA, model: null, droppedCount: 0, questions: [{ questionText: 'Will you supply the ironmongery?', sourceKind: 'body' }] },
      { messageId: messageB, model: null, droppedCount: 0, questions: [{ questionText: 'will you supply the ironmongery', sourceKind: 'body' }] }
    ]);

    const rows = await db.query<{ id: string; message_id: string; canonical_question_id: string | null }>(
      `SELECT id, message_id, canonical_question_id FROM tps.rfi_questions WHERE message_id = ANY($1::uuid[]) ORDER BY created_at`,
      [[messageA, messageB]]
    );
    expect(rows).toHaveLength(2); // both kept as their own rows — a link, never a merge
    const [first, second] = rows;
    expect(first!.canonical_question_id).toBeNull();
    expect(second!.canonical_question_id).toBe(first!.id);
  });
});
