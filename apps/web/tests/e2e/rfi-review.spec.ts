/**
 * The estimator's RFI review tab (issue #48) — in a real browser, against a small
 * in-memory model rather than the BFF. Worth asserting here and nowhere else:
 *
 *  - a blocked message renders ABOVE the drafted groups, always — filing it is the one
 *    action that unblocks everything else about that firm, and DOM order is the one
 *    thing a unit test on a single component cannot prove;
 *  - two approvals from one firm's thread issue ONE POST to /rfi/responses, carrying both
 *    question ids and no address at all — the recipient and the answer both come from
 *    the server, never the page;
 *  - an unanswerable draft offers a textarea rather than an "Approve" of empty text;
 *  - a citation with no live link renders "(link unavailable)", not a dead anchor;
 *  - filing a blocked message removes it from the list and it does not come back.
 */
import { expect, test, type Page } from '@playwright/test';

const API_PATTERN = '**/api/**';
const PACKAGE_ID = '33333333-3333-4333-8333-333333333333';
const WORKFLOW_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_WORKFLOW_ID = '55555555-5555-4555-8555-555555555555';
const TENDER_PREP_PATH = `/tps/packages/${PACKAGE_ID}/tender-prep`;

type Citation = {
  passageId: string; documentId: string; filename: string;
  headingPath: string | null; pageHint: number | null; quotedText: string; shareUrl: string | null;
};
type Draft = {
  id: string; status: string; answer_text: string | null; confidence: number | null;
  needs_client: boolean; citations: Citation[]; reject_reason: string | null; drafted_at: string;
};
type Question = {
  id: string; message_id: string; thread_id: string; seq: number;
  source_kind: string; source_ref: string | null; question_text: string;
  asked_by_name: string | null; asked_by_email: string | null; raised_at: string;
  status: string; canonical_question_id: string | null; estimator_answer_text: string | null;
  package_name: string | null; draft: Draft | null;
  sent: { sent_at: string; email_status: string; source: string } | null;
  forwarded_to_client: boolean;
};

function question(over: Partial<Question> & { id: string; thread_id: string }): Question {
  return {
    message_id: `msg-${over.id}`, seq: 1, source_kind: 'body', source_ref: null,
    question_text: 'Is the ceiling grid included?',
    asked_by_name: 'Sam Colleague', asked_by_email: 'sam@acme.test',
    raised_at: '2026-09-10T09:00:00.000Z', status: 'drafted',
    canonical_question_id: null, estimator_answer_text: null, package_name: null,
    draft: null, sent: null, forwarded_to_client: false,
    ...over
  };
}

function rfiReview(page: Page) {
  const questions: Question[] = [
    question({
      id: 'q-1', thread_id: 'thread-acme', question_text: 'Is the ceiling grid included?',
      draft: {
        id: 'd-1', status: 'proposed', answer_text: 'Yes, per clause 2E.310.', confidence: 0.9,
        needs_client: false, drafted_at: '2026-09-11T09:00:00.000Z', reject_reason: null,
        citations: [{
          passageId: 'p-1', documentId: 'doc-1', filename: 'Specification.pdf',
          headingPath: '2E Internal Finishes', pageHint: 41,
          quotedText: 'The suspended grid and tiles are included in this package.',
          shareUrl: null
        }]
      }
    }),
    question({
      id: 'q-2', thread_id: 'thread-acme', question_text: 'What is the skirting height?',
      draft: {
        id: 'd-2', status: 'insufficient_evidence', answer_text: null, confidence: null,
        needs_client: false, drafted_at: '2026-09-11T09:00:00.000Z', reject_reason: 'No clause names a skirting height.',
        citations: []
      }
    })
  ];
  const blocked = [{
    message_id: 'blocked-1', thread_id: 'thread-blocked', workflow_id: WORKFLOW_ID,
    state: 'blocked_cross_tender_suspected', state_reason: 'message names a different live tender',
    last_attempt_at: '2026-09-10T09:00:00.000Z',
    firm_name: 'Uncertain Firm', firm_email: 'sam@uncertain.test',
    subject: 'RFI', body_text: 'Following up on our other tender query.',
    occurred_at: '2026-09-09T09:00:00.000Z', attachment_count: 0, unattributed: false
  }];
  const responses: Array<Record<string, unknown>> = [];
  const forwards: Array<Record<string, unknown>> = [];
  const attributions: Array<Record<string, unknown>> = [];

  function counts() {
    return {
      blocked: blocked.length,
      drafted: questions.filter((q) => q.status === 'drafted').length,
      approved: questions.filter((q) => q.status === 'approved').length,
      for_client: questions.filter((q) => q.status === 'for_client').length
    };
  }

  function groups() {
    const byThread = new Map<string, Question[]>();
    for (const q of questions) {
      if (q.status === 'dismissed') continue;
      const list = byThread.get(q.thread_id) ?? [];
      list.push(q);
      byThread.set(q.thread_id, list);
    }
    return [...byThread.entries()].map(([threadId, qs]) => ({
      thread_id: threadId, firm_name: 'Acme Drylining', firm_email: 'estimator@acme.test',
      package_name: 'Drylining & Partitions', questions: qs
    }));
  }

  page.route(API_PATTERN, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const json = (b: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(b)
    });

    if (path.endsWith(`/packages/${PACKAGE_ID}/tender-prep`)) {
      return json({
        id: WORKFLOW_ID, package_id: PACKAGE_ID, current_step: 2,
        status: 'in_progress', step_data: { takeoff: { packageName: 'Reading Riverside' } },
        updated_at: '2026-09-10T09:00:00.000Z'
      });
    }
    // Step 2 early-returns "No ITTs yet" with an empty list, and the Communications
    // control lives in its header — so the fixture needs one confirmed package (the
    // same requirement comms-forward.spec.ts's own fixture states).
    if (path.endsWith('/itts')) {
      return json([{
        package_name: 'Drylining', package_seq: 1, route_of_procurement: 'Supply and install',
        recipients: 1, candidates: 1, dispatched: 1, sent: 1, failed: 0, skipped_no_email: 0,
        responses_received: 0, portal_denials: 0, responded: 0,
        confirmed_at: '2026-09-01T09:00:00.000Z'
      }]);
    }
    if (path.endsWith('/threads')) return json([]);
    if (path.endsWith('/queries')) return json([]);
    if (path.endsWith('/client-answers')) return json([]);
    if (path.endsWith('/comms-defaults')) {
      return json({ client_contact_name: 'Jo Client', client_contact_email: 'jo@employer.test', itt_comms_address: null });
    }
    if (path.endsWith('/tender-prep/workflows')) {
      return json([
        { id: WORKFLOW_ID, package_id: PACKAGE_ID, organization_id: 'org-1', current_step: 2, step_data: { takeoff: { projectName: 'Reading Riverside', packageName: 'Drylining' } }, created_at: '', updated_at: '' },
        { id: OTHER_WORKFLOW_ID, package_id: 'pkg-2', organization_id: 'org-1', current_step: 2, step_data: { takeoff: { projectName: 'Croydon Depot', packageName: 'Curtain Walling' } }, created_at: '', updated_at: '' }
      ]);
    }

    if (path.endsWith('/rfi') && method === 'GET') {
      if (url.searchParams.get('view') === 'counts') return json({ counts: counts() });
      return json({ counts: counts(), blocked, groups: groups() });
    }

    const approveMatch = path.match(/\/rfi\/questions\/([^/]+)\/approve$/);
    if (approveMatch && method === 'POST') {
      const q = questions.find((row) => row.id === approveMatch[1])!;
      const body = route.request().postDataJSON() as { answerText: string | null };
      q.status = 'approved';
      q.estimator_answer_text = body.answerText;
      return json(q);
    }
    const askClientMatch = path.match(/\/rfi\/questions\/([^/]+)\/ask-client$/);
    if (askClientMatch && method === 'POST') {
      const q = questions.find((row) => row.id === askClientMatch[1])!;
      q.status = 'for_client';
      return json(q);
    }
    const dismissMatch = path.match(/\/rfi\/questions\/([^/]+)\/dismiss$/);
    if (dismissMatch && method === 'POST') {
      const q = questions.find((row) => row.id === dismissMatch[1])!;
      q.status = 'dismissed';
      return json(q);
    }

    if (path.endsWith('/rfi/responses') && method === 'POST') {
      const payload = route.request().postDataJSON() as { questionIds: string[] };
      responses.push(payload);
      const sent: Array<{ thread_id: string; to: string; status: string }> = [];
      for (const id of payload.questionIds) {
        const q = questions.find((row) => row.id === id)!;
        q.status = 'sent';
        if (!sent.some((s) => s.thread_id === q.thread_id)) {
          sent.push({ thread_id: q.thread_id, to: 'estimator@acme.test', status: 'sent' });
        }
      }
      return json({ sent: sent.length, responses: sent });
    }

    if (path.endsWith('/rfi/client-forward') && method === 'POST') {
      const payload = route.request().postDataJSON() as { questionIds: string[]; clientEmail: string };
      forwards.push(payload);
      for (const id of payload.questionIds) {
        const q = questions.find((row) => row.id === id)!;
        q.status = 'sent_to_client';
      }
      return json({
        forward_message_id: `fwd-${forwards.length}`, thread_id: 'client-thread',
        forwarded: payload.questionIds.length, sent: true,
        link_blocked_reason: 'access_unconfigured', reply_url: null,
        questions_forwarded: payload.questionIds.length
      });
    }

    if (path.includes('/comms/messages/') && path.endsWith('/attribute') && method === 'POST') {
      const payload = route.request().postDataJSON() as { workflowId: string };
      attributions.push(payload);
      blocked.length = 0; // filed — the message leaves this tender's blocked list
      return json({ message_id: 'blocked-1', workflow_id: payload.workflowId, thread_id: 'thread-blocked', questions_discarded: 0 });
    }

    return json([]);
  });

  return { questions, blocked, responses, forwards, attributions };
}

async function openRfiTab(page: Page) {
  await page.goto(TENDER_PREP_PATH);
  await page.getByRole('button', { name: 'Communications' }).click();
  await page.getByRole('button', { name: 'Drafted answers' }).click();
}

test('renders the blocked message ABOVE the drafted groups', async ({ page }) => {
  rfiReview(page);
  await openRfiTab(page);
  await expect(page.getByText('Needs filing under a tender')).toBeVisible();

  const heading = page.getByText('Needs filing under a tender');
  const groupHeading = page.getByText('Acme Drylining · Drylining & Partitions');
  await expect(groupHeading).toBeVisible();
  const headingBox = await heading.boundingBox();
  const groupBox = await groupHeading.boundingBox();
  expect(headingBox!.y).toBeLessThan(groupBox!.y);
});

test('an unanswerable draft offers a textarea, not an Approve of empty text', async ({ page }) => {
  rfiReview(page);
  await openRfiTab(page);
  await expect(page.getByText('The app could not answer this')).toBeVisible();
  await expect(page.getByText('No clause names a skirting height.')).toBeVisible();
  const textarea = page.getByPlaceholder('Write the answer to send.');
  await expect(textarea).toBeVisible();

  const approveButtons = page.getByRole('button', { name: 'Approve' });
  // The first question (a usable draft) can be approved; the second (no answer at all)
  // cannot, until something is typed into its textarea.
  await expect(approveButtons.nth(1)).toBeDisabled();
  await textarea.fill('It is 100mm.');
  await expect(approveButtons.nth(1)).toBeEnabled();
});

test('a citation with no live link renders "(link unavailable)", not a dead anchor', async ({ page }) => {
  rfiReview(page);
  await openRfiTab(page);
  await expect(page.getByText(/Specification\.pdf/)).toBeVisible();
  await expect(page.getByText(/link unavailable/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Specification\.pdf/ })).toHaveCount(0);
});

test('two approvals from one thread issue ONE POST carrying both ids, and the page sends no address', async ({ page }) => {
  const model = rfiReview(page);
  await openRfiTab(page);

  // Approve the first question as-is.
  await page.getByRole('button', { name: 'Approve' }).first().click();
  await expect(page.getByText('Include in send').first()).toBeVisible();

  // Approve the second by writing an answer first.
  await page.getByPlaceholder('Write the answer to send.').fill('It is 100mm.');
  await page.getByRole('button', { name: 'Approve' }).nth(1).click();
  await expect(page.getByText('Include in send')).toHaveCount(2);

  const checkboxes = page.locator('input[type="checkbox"]');
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();

  await page.getByRole('button', { name: /Send \d+ answer/ }).click();

  expect(model.responses).toHaveLength(1);
  const sentPayload = model.responses[0] as { questionIds: string[] };
  expect(sentPayload.questionIds.sort()).toEqual(['q-1', 'q-2']);
  expect(sentPayload).not.toHaveProperty('to');
  expect(sentPayload).not.toHaveProperty('clientEmail');
});

test('filing a blocked message removes it, and it does not come back', async ({ page }) => {
  const model = rfiReview(page);
  await openRfiTab(page);
  await expect(page.getByText('Needs filing under a tender')).toBeVisible();

  await page.getByLabel('File Uncertain Firm under tender').selectOption({ label: 'Croydon Depot — Curtain Walling' });
  await page.getByRole('button', { name: 'File under this tender' }).click();

  expect(model.attributions).toEqual([{ workflowId: OTHER_WORKFLOW_ID }]);
  await expect(page.getByText('Needs filing under a tender')).toHaveCount(0);
});

test('puts questions to the client, sending question ids and rendering link_blocked_reason', async ({ page }) => {
  const model = rfiReview(page);
  await openRfiTab(page);

  await page.getByRole('button', { name: 'Ask the client' }).first().click();
  await expect(page.getByText('Include in client email')).toBeVisible();
  await page.locator('input[type="checkbox"]').first().check();

  await page.locator('#rfi-client-email').fill('jo@employer.test');
  await page.getByRole('button', { name: 'Send to client' }).click();

  expect(model.forwards).toHaveLength(1);
  const payload = model.forwards[0] as { questionIds: string[]; clientEmail: string };
  expect(payload.questionIds).toEqual(['q-1']);
  expect(payload.clientEmail).toBe('jo@employer.test');
  await expect(page.getByText(/No in-app reply link was issued/)).toBeVisible();
});
