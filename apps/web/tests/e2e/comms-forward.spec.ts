/**
 * Putting subcontractor queries to the Client, and the Client answering — in a real
 * browser.
 *
 * The API is served by the small in-memory model below rather than the BFF, and it is a
 * MODEL: a forward actually marks its queries as sent, and an answer actually knows how
 * many queries it covers. Canned replies would pass while the page forwarded the wrong
 * ids, sent one query per message instead of one message, or offered to relay an answer
 * that reaches nobody.
 *
 * Three things are worth asserting here and nowhere else:
 *
 *  - selecting several queries composes ONE message. Six separate emails get one reply
 *    between them and nobody can tell afterwards which question it answered;
 *  - the Client's page never names the firm that asked. Which subcontractor raised a query
 *    is commercially ours, and putting the shortlist in front of the employer leaks it;
 *  - "pass back" is offered only once an answer is actually linked to queries, because the
 *    recipients are derived from that link rather than chosen.
 */
import { expect, test, type Page } from '@playwright/test';

const API_PATTERN = '**/api/**';
const CLIENT_TOKEN = 'tok';
// Pinned to the token rather than `**/client/**`, which also matches Vite's own
// `vite/dist/client/env.mjs` — served JSON, that breaks the module graph and the page
// renders nothing at all, which looks like a broken component.
const CLIENT_API_PATTERN = `**/client/${CLIENT_TOKEN}`;
const PACKAGE_ID = '11111111-1111-4111-8111-111111111111';
const WORKFLOW_ID = '22222222-2222-4222-8222-222222222222';
const TENDER_PREP_PATH = `/tps/packages/${PACKAGE_ID}/tender-prep`;

type Query = {
  id: string; thread_id: string; subject: string | null; body_text: string;
  occurred_at: string; author_name: string | null; author_email: string | null;
  counterparty_name: string | null; counterparty_email: string;
  attachment_count: string; forwarded_at: string | null;
};

function query(id: string, firm: string, subject: string): Query {
  return {
    id, thread_id: `thread-${firm}`, subject, body_text: `Body of ${subject}`,
    occurred_at: '2026-09-10T09:00:00.000Z', author_name: 'Sam Colleague',
    author_email: `sam@${firm}.test`, counterparty_name: firm,
    counterparty_email: `estimator@${firm}.test`, attachment_count: '0', forwarded_at: null
  };
}

function tenderPrep(page: Page) {
  const queries: Query[] = [
    query('q-1', 'acme', 'Ceiling grid'),
    query('q-2', 'acme', 'Skirting'),
    query('q-3', 'brightwork', 'Soffit')
  ];
  const answers: Array<Record<string, unknown>> = [];
  const forwards: Array<Record<string, unknown>> = [];
  const relays: string[] = [];

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
    // control lives in its header — so the fixture needs one confirmed package, which is
    // also the only state in which a query could exist at all.
    if (path.endsWith('/itts')) {
      return json([{
        package_name: 'Drylining', package_seq: 1, route_of_procurement: 'Supply and install',
        recipients: 2, candidates: 4, dispatched: 2, sent: 2, failed: 0, skipped_no_email: 0,
        responses_received: 0, portal_denials: 0, responded: 0,
        confirmed_at: '2026-09-01T09:00:00.000Z'
      }]);
    }
    if (path.endsWith('/queries')) return json(queries);
    if (path.endsWith('/client-answers')) return json(answers);
    if (path.endsWith('/comms-defaults')) {
      // Pre-filled from the organisation's configured Client contact.
      return json({
        client_contact_name: 'Jo Client', client_contact_email: 'jo@employer.test',
        itt_comms_address: 'acme-ittcomms@novamerx.ai'
      });
    }
    if (path.endsWith('/threads/forward') && method === 'POST') {
      const payload = route.request().postDataJSON() as { messageIds: string[] };
      forwards.push(route.request().postDataJSON());
      const forwardId = `fwd-${forwards.length}`;
      for (const id of payload.messageIds) {
        const found = queries.find((q) => q.id === id);
        if (found) found.forwarded_at = '2026-09-12T09:00:00.000Z';
      }
      answers.unshift({
        id: `ans-${forwards.length}`, body_text: 'Yes, both are included.',
        occurred_at: '2026-09-15T11:00:00.000Z', in_reply_to_message_id: forwardId,
        counterparty_name: 'Jo Client', counterparty_email: 'jo@employer.test',
        covers: String(payload.messageIds.length), relayed: false
      });
      return json({
        forward_message_id: forwardId, thread_id: 'client-thread',
        forwarded: payload.messageIds.length, sent: true,
        link_blocked_reason: null, reply_url: 'http://tps.test/tps/client/tok'
      });
    }
    if (path.includes('/comms/messages/') && path.endsWith('/relay') && method === 'POST') {
      const id = path.split('/').at(-2)!;
      relays.push(id);
      const answer = answers.find((a) => a.id === id)!;
      answer.relayed = true;
      return json({
        relayed: Number(answer.covers),
        recipients: [{ thread_id: 'thread-acme', to: 'estimator@acme.test', status: 'sent' }]
      });
    }
    if (path.endsWith('/threads')) return json([]);
    return json([]);
  });

  return { forwards, relays, queries, answers };
}

// By id, not by label. Step 2 also carries "Estimator name" and "Estimator email", and a
// substring label match for "To" hits "Estima-TO-r" — a trap worth one line to avoid.
const clientField = (page: Page, id: string) => page.locator(`#${id}`);

async function openCollate(page: Page) {
  await page.goto(TENDER_PREP_PATH);
  await page.getByRole('button', { name: 'Communications' }).click();
  await page.getByRole('button', { name: 'Put queries to the client' }).click();
}

test('pre-fills the client contact the organisation configured', async ({ page }) => {
  tenderPrep(page);
  await openCollate(page);
  // A default, not a rule: each tender can have a different employer, so it stays editable.
  await expect(clientField(page, 'client-email')).toHaveValue('jo@employer.test');
  await expect(clientField(page, 'client-name')).toHaveValue('Jo Client');
  await expect(clientField(page, 'client-email')).toBeEditable();
});

test('sends several queries from different firms as ONE message', async ({ page }) => {
  const model = tenderPrep(page);
  await openCollate(page);

  await page.getByLabel('Select query from acme').first().check();
  await page.getByLabel('Select query from brightwork').check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Send to client' }).click();

  await expect(page.getByText('Sent 2 queries to the client.')).toBeVisible();
  // ONE call carrying both ids, not one call per query.
  expect(model.forwards).toHaveLength(1);
  expect(model.forwards[0].messageIds).toEqual(['q-1', 'q-3']);
  expect(model.forwards[0].clientEmail).toBe('jo@employer.test');
});

test('will not send with nothing selected, or with no client address', async ({ page }) => {
  tenderPrep(page);
  await openCollate(page);
  await expect(page.getByRole('button', { name: 'Send to client' })).toBeDisabled();

  await page.getByLabel('Select query from acme').first().check();
  await expect(page.getByRole('button', { name: 'Send to client' })).toBeEnabled();
  await clientField(page, 'client-email').fill('');
  await expect(page.getByRole('button', { name: 'Send to client' })).toBeDisabled();
});

test('marks a query as already sent, so the client is not asked twice', async ({ page }) => {
  tenderPrep(page);
  await openCollate(page);
  await expect(page.getByText('not sent')).toHaveCount(3);

  await page.getByLabel('Select query from acme').first().check();
  await page.getByRole('button', { name: 'Send to client' }).click();

  await expect(page.getByText('not sent')).toHaveCount(2);
  // The tick is cleared too — re-sending the same query needs a deliberate act.
  await expect(page.getByLabel('Select query from acme').first()).not.toBeChecked();
});

test('offers to pass an answer back, and says how many queries it covers', async ({ page }) => {
  const model = tenderPrep(page);
  await openCollate(page);
  await page.getByLabel('Select query from acme').first().check();
  await page.getByLabel('Select query from brightwork').check();
  await page.getByRole('button', { name: 'Send to client' }).click();
  await expect(page.getByText('Sent 2 queries to the client.')).toBeVisible();

  await page.getByRole('button', { name: 'Client responses' }).click();
  await expect(page.getByText('Yes, both are included.')).toBeVisible();
  // The recipients are derived server-side from what the forward carried, so this count
  // is the only advance notice of who it reaches.
  await expect(page.getByText('Covers 2 queries')).toBeVisible();

  await page.getByRole('button', { name: 'Pass back to the firms that asked' }).click();
  await expect(page.getByText('Passed back to 2 firms.')).toBeVisible();
  expect(model.relays).toEqual(['ans-1']);
});

test('says the client has not answered yet, rather than showing an empty list', async ({ page }) => {
  tenderPrep(page);
  await page.goto(TENDER_PREP_PATH);
  await page.getByRole('button', { name: 'Communications' }).click();
  await page.getByRole('button', { name: 'Client responses' }).click();
  await expect(page.getByText(/client has not responded yet/)).toBeVisible();
});

// ── the Client's own page ────────────────────────────────────────────────────

function clientPage(page: Page, over: Record<string, unknown> = {}) {
  const replies: string[] = [];
  page.route(CLIENT_API_PATTERN, async (route) => {
    // The page itself lives at /tps/client/:token and its API at /tps-api/client/:token,
    // so this pattern matches the NAVIGATION as well as the fetch. Serving JSON to the
    // document request leaves the SPA never loading, and the failure looks like a broken
    // component rather than a broken fixture.
    if (route.request().resourceType() === 'document') return route.continue();
    if (route.request().method() === 'POST') {
      replies.push((route.request().postDataJSON() as { body: string }).body);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recorded: true }) });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        tender_name: 'Reading Riverside',
        recipient_email: 'jo@employer.test',
        queries: [
          { id: 'q-1', subject: 'Ceiling grid', body_text: 'Is the grid included?', raised_at: '2026-09-10T09:00:00.000Z' },
          { id: 'q-3', subject: 'Soffit', body_text: 'Is the soffit ours?', raised_at: '2026-09-10T09:00:00.000Z' }
        ],
        messages: [],
        ...over
      })
    });
  });
  return { replies };
}

test('shows the client their queries without naming any subcontractor', async ({ page }) => {
  // The load-bearing assertion on this page. The server does not send the firm names, so
  // this cannot be undone by a careless edit to the component.
  clientPage(page);
  await page.goto(`/tps/client/${CLIENT_TOKEN}`);
  await expect(page.getByRole('heading', { name: /Tender queries/ })).toBeVisible();
  await expect(page.getByText('Is the grid included?')).toBeVisible();
  await expect(page.getByText('2 queries have been raised')).toBeVisible();
  for (const firm of ['acme', 'Acme', 'brightwork', 'Brightwork']) {
    await expect(page.getByText(firm)).toHaveCount(0);
  }
});

test('records the client answer and offers the email route as well', async ({ page }) => {
  const model = clientPage(page);
  await page.goto(`/tps/client/${CLIENT_TOKEN}`);
  await expect(page.getByRole('button', { name: 'Send response' })).toBeDisabled();
  await page.getByLabel('Response').fill('1. Yes. 2. No, the soffit is ours.');
  await page.getByRole('button', { name: 'Send response' }).click();

  await expect(page.getByText(/your response has been recorded/i)).toBeVisible();
  expect(model.replies).toEqual(['1. Yes. 2. No, the soffit is ours.']);
  // Two routes home, because plus-addressing does not survive every mail system.
  await expect(page.getByText(/reply to the email this link came from/)).toBeVisible();
});
