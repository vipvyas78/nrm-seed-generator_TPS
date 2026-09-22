/**
 * The estimator's RFI review / approve / send loop (issue #48) — real PostgreSQL, the
 * real `comms` schema, a fake mail provider.
 *
 *   DATABASE_URL=postgresql://buildflow:buildflow@localhost:5433/buildflow \
 *     pnpm --filter @tps/bff exec vitest run tests/integration/rfi-review.integration.test.ts
 *
 * `rfi-drafting.integration.test.ts` proves issue #41's pipeline up to a stored,
 * reviewable draft. This file starts from there: the read model an estimator actually
 * sees, the three dispositions, the send (one email per firm thread, claim-before-send,
 * the answer's `source` correctly credited), the client forward at question grain, and
 * re-attribution WITHOUT the hand-written `DELETE FROM tps.rfi_message_reviews` that
 * `rfi-drafting.integration.test.ts` needed — `reattributeCommsMessage` does that itself
 * now, and that removal is the point of this file's re-attribution test.
 *
 * THE ACCEPTANCE TEST for this issue is the cross-tender send: a question whose own
 * `workflow_id` still says tender A, sent from tender A, but whose THREAD has since been
 * re-attributed to tender B — refused, because the thread is where the recipient
 * actually comes from and a question row is only ever a snapshot.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { CommsDatabase } from '../../src/commsDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import type { EmailService } from '../../src/emailService.js';
import { RfiDatabase } from '../../src/rfiDb.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import type { Actor } from '../../src/types.js';

const { DATABASE_URL } = process.env;

type Sent = { to: string | string[]; subject: string; text: string; html: string };

describe('the estimator RFI review loop', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
  const db = new Database(config);
  const commsDb = new CommsDatabase(db);
  // No BuildFlow clients: none of this file's methods need one (see rfiDb.ts's own
  // header on why the estimator half takes them as optional).
  const rfiDb = new RfiDatabase(db, commsDb);
  const scms = new ScmsReadDatabase(db, config.SCMS_SCHEMA);
  const boq = new BoqReadDatabase(db);

  const sent: Sent[] = [];
  const sendingEmail = {
    send: async (message: Sent) => { sent.push(message); return { id: `msg-${sent.length}` }; }
  } as unknown as EmailService;

  // Sends: emailService configured, so a claimed response actually reaches 'sent'.
  const tpDbSending = new TenderPrepDatabase(
    db, scms, boq, undefined, undefined, undefined, undefined,
    sendingEmail, null, undefined, undefined, 'https://portal.test/tps', 90,
    undefined, commsDb, undefined, 30, rfiDb
  );
  // No email provider at all — sendCommsEmail reports { ok: false }, and the failure
  // path (rfi_responses.email_status = 'failed', a rfi_review_required notification,
  // the questions left 'approved') is what this instance exercises.
  const tpDbFailing = new TenderPrepDatabase(
    db, scms, boq, undefined, undefined, undefined, undefined,
    undefined, null, undefined, undefined, 'https://portal.test/tps', 90,
    undefined, commsDb, undefined, 30, rfiDb
  );

  const cleanupIds: { organizationId: string[]; workflowId: string[]; messageId: string[] } = {
    organizationId: [], workflowId: [], messageId: []
  };

  afterAll(async () => {
    if (cleanupIds.workflowId.length) {
      await db.query(
        `DELETE FROM tps.rfi_response_items WHERE response_id IN (SELECT id FROM tps.rfi_responses WHERE workflow_id = ANY($1::uuid[]))`,
        [cleanupIds.workflowId]
      );
      await db.query(`DELETE FROM tps.rfi_responses WHERE workflow_id = ANY($1::uuid[])`, [cleanupIds.workflowId]);
      await db.query(
        `DELETE FROM tps.rfi_client_forward_items WHERE question_id IN (SELECT id FROM tps.rfi_questions WHERE workflow_id = ANY($1::uuid[]))`,
        [cleanupIds.workflowId]
      );
      await db.query(`DELETE FROM tps.rfi_drafts WHERE question_id IN (SELECT id FROM tps.rfi_questions WHERE workflow_id = ANY($1::uuid[]))`, [cleanupIds.workflowId]);
      await db.query(`DELETE FROM tps.rfi_questions WHERE workflow_id = ANY($1::uuid[])`, [cleanupIds.workflowId]);
    }
    if (cleanupIds.messageId.length) {
      await db.query(`DELETE FROM comms.notifications WHERE message_id = ANY($1::uuid[])`, [cleanupIds.messageId]);
      await db.query(`DELETE FROM tps.rfi_message_reviews WHERE message_id = ANY($1::uuid[])`, [cleanupIds.messageId]);
    }
    if (cleanupIds.workflowId.length) {
      await db.query(`DELETE FROM comms.threads WHERE workflow_id = ANY($1::uuid[])`, [cleanupIds.workflowId]);
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
      `INSERT INTO public.itt_comms_config (organization_id, tender_id, org_slug, itt_from_address, itt_comms_address, client_reply_address)
       VALUES ($1, NULL, $2, 'tenders@novamerx.ai', $3, 'itt-reply@novamerx.co.uk')`,
      [id, `org-${id.slice(0, 8)}`, `org-${id.slice(0, 8)}-ittcomms@novamerx.ai`]
    );
    cleanupIds.organizationId.push(id);
    return id;
  }

  async function seedWorkflow(organizationId: string, tenderName: string): Promise<string> {
    const packageId = randomUUID();
    const workflow = await db.one<{ id: string }>(
      `INSERT INTO workflows (package_id, organization_id, step_data)
       VALUES ($1, $2, jsonb_build_object('takeoff', jsonb_build_object('tenderName', $3::text)))
       RETURNING id`,
      [packageId, organizationId, tenderName]
    );
    cleanupIds.workflowId.push(workflow.id);
    return workflow.id;
  }

  function actorFor(organizationId: string): Actor {
    return { userId: randomUUID(), organizationId, subject: 'estimator', email: 'estimator@example.test' };
  }

  /** Files an inbound RFI message directly through commsDb — the shape a real portal
   *  RFI or attributed email produces, without going through the eligibility gate. */
  async function seedMessage(input: { organizationId: string; workflowId: string; senderEmail: string }): Promise<{ messageId: string; threadId: string }> {
    const thread = await commsDb.findOrCreateThread({
      organizationId: input.organizationId, workflowId: input.workflowId, counterpartyKind: 'subcontractor',
      counterpartyEmail: input.senderEmail, counterpartyName: 'Test Firm', subcontractorId: null, subject: 'RFI'
    });
    const message = await commsDb.recordMessage({
      threadId: String(thread.id), organizationId: input.organizationId, workflowId: input.workflowId,
      shortlistEntryId: null, direction: 'inbound', channel: 'portal',
      kind: 'subcontractor_rfi', authorName: 'Test Firm', authorEmail: input.senderEmail,
      subject: 'RFI', bodyText: 'body', occurredAt: new Date(),
      idempotencyKey: `test-${randomUUID()}`, createdBy: null
    });
    if (!message) throw new Error('recordMessage returned null (idempotency conflict) — test bug');
    cleanupIds.messageId.push(String(message.id));
    return { messageId: String(message.id), threadId: String(thread.id) };
  }

  let seq = 0;
  async function seedQuestion(input: {
    workflowId: string; messageId: string; threadId: string; questionText: string;
    status?: string; askedByName?: string | null; askedByEmail?: string | null;
  }): Promise<string> {
    seq += 1;
    const row = await db.one<{ id: string }>(
      `INSERT INTO tps.rfi_questions
         (message_id, workflow_id, thread_id, seq, source_kind, question_text,
          asked_by_name, asked_by_email, raised_at, status, dedupe_hash)
       VALUES ($1,$2,$3,$4,'body',$5,$6,$7,NOW(),$8,$9)
       RETURNING id`,
      [input.messageId, input.workflowId, input.threadId, seq, input.questionText,
       input.askedByName ?? 'Sam Colleague', input.askedByEmail ?? 'sam@acme.test',
       input.status ?? 'new', `dedupe-${randomUUID()}`]
    );
    return row.id;
  }

  async function seedDraft(questionId: string, input: {
    status?: string; answerText?: string | null; citations?: unknown[]; supersededAt?: Date;
  } = {}): Promise<string> {
    const row = await db.one<{ id: string }>(
      `INSERT INTO tps.rfi_drafts (question_id, status, answer_text, citations, superseded_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id`,
      [questionId, input.status ?? 'proposed', input.answerText ?? null,
       JSON.stringify(input.citations ?? []), input.supersededAt ?? null]
    );
    return row.id;
  }

  // ── the read model ───────────────────────────────────────────────────────

  it('returns a drafted question with its live draft and citations, grouped by thread', async () => {
    const organizationId = await seedOrg('Review Read Org');
    const workflowId = await seedWorkflow(organizationId, 'Reading Gateway');
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId, senderEmail: `firm-${randomUUID()}@example.test` });
    const questionId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'Is the ceiling grid included?', status: 'drafted' });
    await seedDraft(questionId, {
      answerText: 'Yes, per clause 2E.310.',
      citations: [{ passageId: 'p1', documentId: 'd1', filename: 'Spec.pdf', headingPath: '2E', pageHint: 12, quotedText: 'quote', shareUrl: null }]
    });

    const result = await rfiDb.reviewQueue(actorFor(organizationId), workflowId);
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0]!;
    expect(group.thread_id).toBe(threadId);
    expect(group.questions).toHaveLength(1);
    const question = group.questions[0]!;
    expect(question.id).toBe(questionId);
    expect(question.draft?.status).toBe('proposed');
    expect(question.draft?.answer_text).toBe('Yes, per clause 2E.310.');
    expect(question.draft?.citations).toHaveLength(1);
    expect(question.draft?.citations[0]).toMatchObject({ filename: 'Spec.pdf', headingPath: '2E', pageHint: 12 });
    expect(result.counts.drafted).toBe(1);
  });

  it('shows only the LIVE draft — a superseded one is absent', async () => {
    const organizationId = await seedOrg('Superseded Draft Org');
    const workflowId = await seedWorkflow(organizationId, 'Reading Gateway 2');
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId, senderEmail: `firm-${randomUUID()}@example.test` });
    const questionId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'What is the skirting height?', status: 'drafted' });
    await seedDraft(questionId, { answerText: 'An old, wrong answer.', supersededAt: new Date() });
    await seedDraft(questionId, { answerText: 'The live, correct answer.' });

    const result = await rfiDb.reviewQueue(actorFor(organizationId), workflowId);
    const question = result.groups[0]!.questions[0]!;
    expect(question.draft?.answer_text).toBe('The live, correct answer.');
  });

  it('gives a null answer for a draft that could not answer, so the tab can say so', async () => {
    const organizationId = await seedOrg('Insufficient Evidence Org');
    const workflowId = await seedWorkflow(organizationId, 'Reading Gateway 3');
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId, senderEmail: `firm-${randomUUID()}@example.test` });
    const questionId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'What colour is the render?', status: 'drafted' });
    await seedDraft(questionId, { status: 'insufficient_evidence', answerText: null });

    const result = await rfiDb.reviewQueue(actorFor(organizationId), workflowId);
    const question = result.groups[0]!.questions[0]!;
    expect(question.draft?.status).toBe('insufficient_evidence');
    expect(question.draft?.answer_text).toBeNull();
  });

  // ── the three dispositions ───────────────────────────────────────────────

  it('approve, ask-client and dismiss each write their own status', async () => {
    const organizationId = await seedOrg('Dispositions Org');
    const workflowId = await seedWorkflow(organizationId, 'Reading Gateway 4');
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId, senderEmail: `firm-${randomUUID()}@example.test` });
    const actor = actorFor(organizationId);

    const approveId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'Q1', status: 'drafted' });
    const approved = await rfiDb.approveQuestion(actor, approveId, 'My own answer.');
    expect(approved.status).toBe('approved');
    expect(approved.estimator_answer_text).toBe('My own answer.');
    expect(approved.reviewed_by).toBe(actor.userId);

    const askClientId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'Q2', status: 'drafted' });
    const askedClient = await rfiDb.askClientQuestion(actor, askClientId);
    expect(askedClient.status).toBe('for_client');

    const dismissId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'Q3', status: 'new' });
    const dismissed = await rfiDb.dismissQuestion(actor, dismissId);
    expect(dismissed.status).toBe('dismissed');
  });

  it('refuses to approve a question that has already been sent', async () => {
    const organizationId = await seedOrg('Already Sent Org');
    const workflowId = await seedWorkflow(organizationId, 'Reading Gateway 5');
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId, senderEmail: `firm-${randomUUID()}@example.test` });
    const actor = actorFor(organizationId);
    const questionId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'Q', status: 'sent' });

    await expect(rfiDb.approveQuestion(actor, questionId, 'text')).rejects.toMatchObject({ statusCode: 409 });
  });

  // ── the send ──────────────────────────────────────────────────────────────

  it('sends two approved questions on one thread as ONE email and ONE rfi_responses row', async () => {
    const organizationId = await seedOrg('Send Org');
    const workflowId = await seedWorkflow(organizationId, 'Reading Gateway 6');
    const senderEmail = `firm-${randomUUID()}@example.test`;
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId, senderEmail });
    const actor = actorFor(organizationId);

    const draftedId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'Is the grid included?', status: 'drafted' });
    await seedDraft(draftedId, { answerText: 'Yes, per 2E.310.' });
    await rfiDb.approveQuestion(actor, draftedId, null); // send as-is: no edit

    const editedId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'What is the height?', status: 'drafted' });
    await seedDraft(editedId, { answerText: 'It is 3m.' });
    await rfiDb.approveQuestion(actor, editedId, 'It is actually 3.2m.');

    const before = sent.length;
    const result = await tpDbSending.sendRfiResponses(actor, workflowId, [draftedId, editedId]);
    expect((result as { sent: number }).sent).toBe(1);
    expect(sent.length).toBe(before + 1); // one email, not two

    const responses = await db.query<{ id: string; email_status: string }>(`SELECT id, email_status FROM tps.rfi_responses WHERE workflow_id = $1`, [workflowId]);
    expect(responses).toHaveLength(1);
    expect(responses[0]!.email_status).toBe('sent');

    const items = await db.query<{ question_id: string; source: string; draft_id: string | null }>(
      `SELECT question_id, source, draft_id FROM tps.rfi_response_items WHERE response_id = $1 ORDER BY seq`, [responses[0]!.id]
    );
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.question_id === draftedId)).toMatchObject({ source: 'app_draft' });
    expect(items.find((i) => i.question_id === draftedId)?.draft_id).not.toBeNull();
    expect(items.find((i) => i.question_id === editedId)).toMatchObject({ source: 'app_draft_edited' });

    const questionRows = await db.query<{ id: string; status: string }>(`SELECT id, status FROM tps.rfi_questions WHERE id = ANY($1::uuid[])`, [[draftedId, editedId]]);
    expect(questionRows.every((row) => row.status === 'sent')).toBe(true);

    const messages = await db.query<{ kind: string }>(`SELECT kind FROM comms.messages WHERE thread_id = $1 AND kind = 'rfi_response'`, [threadId]);
    expect(messages).toHaveLength(1);
  });

  it('credits the estimator alone when there was no usable draft to edit', async () => {
    const organizationId = await seedOrg('Estimator Only Org');
    const workflowId = await seedWorkflow(organizationId, 'Reading Gateway 7');
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId, senderEmail: `firm-${randomUUID()}@example.test` });
    const actor = actorFor(organizationId);

    const questionId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'Any door schedule?', status: 'new' });
    await rfiDb.approveQuestion(actor, questionId, 'Yes, see the attached schedule.');

    await tpDbSending.sendRfiResponses(actor, workflowId, [questionId]);
    const [item] = await db.query<{ source: string; draft_id: string | null }>(
      `SELECT source, draft_id FROM tps.rfi_response_items WHERE question_id = $1`, [questionId]
    );
    expect(item).toMatchObject({ source: 'estimator', draft_id: null });
  });

  it('THE ACCEPTANCE TEST: refuses a question whose THREAD has moved to another tender, even though the question row still says this one', async () => {
    const organizationId = await seedOrg('Cross Tender Send Org');
    const workflowA = await seedWorkflow(organizationId, 'Tender A');
    const workflowB = await seedWorkflow(organizationId, 'Tender B');
    const senderEmail = `firm-${randomUUID()}@example.test`;
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId: workflowA, senderEmail });
    const actor = actorFor(organizationId);

    const questionId = await seedQuestion({ workflowId: workflowA, messageId, threadId, questionText: 'Q', status: 'drafted' });
    await seedDraft(questionId, { answerText: 'An answer.' });
    await rfiDb.approveQuestion(actor, questionId, null);

    // The thread moves to tender B (as reattributeCommsMessage's own comms half would
    // do); the question row itself is untouched and still says workflow A.
    await db.query(`UPDATE comms.threads SET workflow_id = $1 WHERE id = $2`, [workflowB, threadId]);

    await expect(tpDbSending.sendRfiResponses(actor, workflowA, [questionId])).rejects.toMatchObject({ statusCode: 409 });
    const [response] = await db.query(`SELECT 1 FROM tps.rfi_responses WHERE workflow_id = $1`, [workflowA]);
    expect(response).toBeUndefined();
  });

  it('refuses a question belonging to a different tender outright (the ordinary case, no re-attribution involved)', async () => {
    const organizationId = await seedOrg('Foreign Question Org');
    const workflowA = await seedWorkflow(organizationId, 'Tender C');
    const workflowB = await seedWorkflow(organizationId, 'Tender D');
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId: workflowB, senderEmail: `firm-${randomUUID()}@example.test` });
    const actor = actorFor(organizationId);
    const questionId = await seedQuestion({ workflowId: workflowB, messageId, threadId, questionText: 'Q', status: 'approved' });

    await expect(tpDbSending.sendRfiResponses(actor, workflowA, [questionId])).rejects.toMatchObject({ statusCode: 409 });
  });

  it('a failed send leaves the response failed, the questions still approved, and a notification behind', async () => {
    const organizationId = await seedOrg('Failed Send Org');
    const workflowId = await seedWorkflow(organizationId, 'Reading Gateway 8');
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId, senderEmail: `firm-${randomUUID()}@example.test` });
    const actor = actorFor(organizationId);
    const questionId = await seedQuestion({ workflowId, messageId, threadId, questionText: 'Q', status: 'drafted' });
    await seedDraft(questionId, { answerText: 'An answer.' });
    await rfiDb.approveQuestion(actor, questionId, null);

    const result = await tpDbFailing.sendRfiResponses(actor, workflowId, [questionId]);
    expect((result as { sent: number }).sent).toBe(0);

    const [response] = await db.query<{ email_status: string; email_error: string | null }>(
      `SELECT email_status, email_error FROM tps.rfi_responses WHERE workflow_id = $1`, [workflowId]
    );
    expect(response?.email_status).toBe('failed');
    expect(response?.email_error).toBeTruthy();

    const [question] = await db.query<{ status: string }>(`SELECT status FROM tps.rfi_questions WHERE id = $1`, [questionId]);
    expect(question?.status).toBe('approved'); // never 'sent'

    const [notification] = await db.query<{ kind: string }>(`SELECT kind FROM comms.notifications WHERE kind = 'rfi_review_required'`);
    expect(notification).toBeDefined();
  });

  // ── the client forward ────────────────────────────────────────────────────

  it('puts questions to the Client as one email, recording BOTH ledgers before the send', async () => {
    const organizationId = await seedOrg('Client Forward Org');
    const workflowId = await seedWorkflow(organizationId, 'Reading Gateway 9');
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId, senderEmail: `firm-${randomUUID()}@example.test` });
    const actor = actorFor(organizationId);

    const q1 = await seedQuestion({ workflowId, messageId, threadId, questionText: 'Is the site accessible from the north?', status: 'new' });
    const q2 = await seedQuestion({ workflowId, messageId, threadId, questionText: 'What is the working week?', status: 'new' });
    await rfiDb.askClientQuestion(actor, q1);
    await rfiDb.askClientQuestion(actor, q2);

    const before = sent.length;
    const result = await tpDbSending.forwardRfiQuestionsToClient(actor, workflowId, {
      questionIds: [q1, q2], clientEmail: 'client@employer.test', clientName: 'The Client', note: null
    });
    expect((result as { sent: boolean }).sent).toBe(true);
    expect(sent.length).toBe(before + 1);
    expect((result as { questions_forwarded: number }).questions_forwarded).toBe(2);

    const forwardItems = await db.query<{ question_id: string }>(
      `SELECT question_id FROM tps.rfi_client_forward_items WHERE forward_message_id = $1`, [(result as { forward_message_id: string }).forward_message_id]
    );
    expect(forwardItems.map((row) => row.question_id).sort()).toEqual([q1, q2].sort());

    const questionRows = await db.query<{ status: string }>(`SELECT status FROM tps.rfi_questions WHERE id = ANY($1::uuid[])`, [[q1, q2]]);
    expect(questionRows.every((row) => row.status === 'sent_to_client')).toBe(true);

    // The email itself carries one numbered entry per QUESTION, not per message — two
    // entries, and each question's own text appears in its body (in raised_at order,
    // now that questionsForClientForward is ordered), never merged into one.
    const email = sent[sent.length - 1]!;
    expect(email.text).toContain('1. Test Firm');
    expect(email.text).toContain('2. Test Firm');
    expect(email.text).toContain('Is the site accessible from the north?');
    expect(email.text).toContain('What is the working week?');
    expect(email.text.indexOf('Is the site accessible from the north?'))
      .toBeLessThan(email.text.indexOf('What is the working week?'));
  });

  // ── re-attribution ────────────────────────────────────────────────────────

  it('re-attributes a blocked message and makes it eligible next tick, WITHOUT a hand-written DELETE', async () => {
    const organizationId = await seedOrg('Reattribute Route Org');
    const workflowA = await seedWorkflow(organizationId, 'Tender E');
    const workflowB = await seedWorkflow(organizationId, 'Tender F');
    const senderEmail = `firm-${randomUUID()}@example.test`;
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId: workflowA, senderEmail });
    const actor = actorFor(organizationId);

    // A review row and a question extracted under the WRONG tender — what the
    // eligibility gate's blocked_ambiguous_tender path would have left behind, and what
    // a real extraction under workflow A would have written.
    await db.query(
      `INSERT INTO tps.rfi_message_reviews (message_id, workflow_id, state) VALUES ($1, $2, 'extracted')`,
      [messageId, workflowA]
    );
    const questionId = await seedQuestion({ workflowId: workflowA, messageId, threadId, questionText: 'Q', status: 'new' });

    const result = await tpDbSending.reattributeCommsMessage(actor, messageId, workflowB);
    expect((result as { questions_discarded: number }).questions_discarded).toBe(1);

    const [question] = await db.query(`SELECT 1 FROM tps.rfi_questions WHERE id = $1`, [questionId]);
    expect(question).toBeUndefined(); // discarded, not re-pointed

    const [review] = await db.query(`SELECT 1 FROM tps.rfi_message_reviews WHERE message_id = $1`, [messageId]);
    expect(review).toBeUndefined(); // the point: no DELETE needed by the caller

    const [message] = await db.query<{ workflow_id: string; attribution_method: string }>(
      `SELECT workflow_id, attribution_method FROM comms.messages WHERE id = $1`, [messageId]
    );
    expect(String(message?.workflow_id)).toBe(workflowB);
    expect(message?.attribution_method).toBe('manual');

    // The message is eligible for pendingExtraction's own exclusion query again — its
    // whole point, and the assertion rfi-drafting.integration.test.ts's equivalent case
    // could only make by deleting the review row itself first.
    const [reconsiderable] = await db.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM comms.messages m
        WHERE m.id = $1 AND m.kind = 'subcontractor_rfi'
          AND NOT EXISTS (SELECT 1 FROM tps.rfi_message_reviews r WHERE r.message_id = m.id)`,
      [messageId]
    );
    expect(Number(reconsiderable?.n ?? 0)).toBe(1);
  });

  it('refuses re-attribution once an answer has already been sent, and leaves the questions untouched', async () => {
    const organizationId = await seedOrg('Committed Reattribute Org');
    const workflowA = await seedWorkflow(organizationId, 'Tender G');
    const workflowB = await seedWorkflow(organizationId, 'Tender H');
    const { messageId, threadId } = await seedMessage({ organizationId, workflowId: workflowA, senderEmail: `firm-${randomUUID()}@example.test` });
    const actor = actorFor(organizationId);
    const questionId = await seedQuestion({ workflowId: workflowA, messageId, threadId, questionText: 'Q', status: 'drafted' });
    await seedDraft(questionId, { answerText: 'An answer.' });
    await rfiDb.approveQuestion(actor, questionId, null);
    await tpDbSending.sendRfiResponses(actor, workflowA, [questionId]);

    await expect(tpDbSending.reattributeCommsMessage(actor, messageId, workflowB)).rejects.toMatchObject({ statusCode: 409 });
    const [question] = await db.query<{ status: string }>(`SELECT status FROM tps.rfi_questions WHERE id = $1`, [questionId]);
    expect(question?.status).toBe('sent'); // untouched
  });

  it('refuses to re-attribute a message belonging to another organisation', async () => {
    const organizationId = await seedOrg('Reattribute Org Owner');
    const otherOrgId = await seedOrg('Reattribute Org Stranger');
    const workflowA = await seedWorkflow(organizationId, 'Tender I');
    const targetWorkflow = await seedWorkflow(otherOrgId, 'Tender J');
    const { messageId } = await seedMessage({ organizationId, workflowId: workflowA, senderEmail: `firm-${randomUUID()}@example.test` });
    const strangerActor = actorFor(otherOrgId);

    await expect(tpDbSending.reattributeCommsMessage(strangerActor, messageId, targetWorkflow)).rejects.toMatchObject({ statusCode: 404 });
  });
});
