/**
 * The "Send reminder" control on the tender dashboard, driven in a real browser (issue #36).
 *
 * The API is a small in-memory MODEL rather than canned replies: a click really posts to the
 * reminder route, and the next read of the dashboard reflects it. What is worth asserting
 * here, and nowhere else:
 *
 *  - the button NAMES the email that will go, and which it is follows the firm's state - so a
 *    click can never send the other one. (The server decides; the label is what it told us.)
 *  - a firm that declined, or has already returned a price, gets no button at all;
 *  - a mark the classifier read off the firm's own email says so, and confirming it is what
 *    makes it a person's decision;
 *  - a failed send is said out loud rather than swallowed.
 */
import { expect, test, type Page } from '@playwright/test';

const API_PATTERN = '**/api/**';
const PACKAGE_ID = '11111111-1111-4111-8111-111111111111';
const WORKFLOW_ID = '22222222-2222-4222-8222-222222222222';

type FirmState = {
  id: string; name: string; dispatch_id: string;
  response: 'will_tender' | 'decline' | null;
  response_source: 'manual' | 'email_llm' | null;
  tendered_sum: string | null;
  reminders_sent: number;
};

function model(page: Page, options: { failSends?: boolean } = {}) {
  const firms: FirmState[] = [
    { id: 'sc-1', name: 'Silent Glazing', dispatch_id: 'd-1', response: null, response_source: null, tendered_sum: null, reminders_sent: 0 },
    { id: 'sc-2', name: 'Accepted Facades', dispatch_id: 'd-2', response: 'will_tender', response_source: 'manual', tendered_sum: null, reminders_sent: 0 },
    { id: 'sc-3', name: 'Declined Cladding', dispatch_id: 'd-3', response: 'decline', response_source: 'manual', tendered_sum: null, reminders_sent: 0 },
    { id: 'sc-4', name: 'Submitted Screens', dispatch_id: 'd-4', response: 'will_tender', response_source: 'manual', tendered_sum: '100000.00', reminders_sent: 0 },
    { id: 'sc-5', name: 'Read From Email', dispatch_id: 'd-5', response: 'will_tender', response_source: 'email_llm', tendered_sum: null, reminders_sent: 0 }
  ];
  const posts: Array<{ path: string; body: unknown }> = [];

  // What the server would decide - mirrored from manualReminderKind so a wrong label in the
  // UI is caught against an independent statement of the rule.
  const kindFor = (f: FirmState) =>
    f.response === 'decline' || f.tendered_sum ? null : f.response === 'will_tender' ? 'submit_tender' : 'confirm_interest';

  const row = () => ({
    package_config_id: 'pc-1', seq: 1, sub_seq: null, display_ref: '1', is_heading: false, is_sub_package: false,
    package_name: 'Curtain Walling', configured_route: 'Supply and install', route_of_procurement: 'Supply and install',
    route_options: [], trade_terms: [], stranded_bill_lines: 0, notes: null, confirmed_at: '2026-09-10T10:00:00Z',
    board_override_notes: null, tender_return_period_value: 4, tender_return_period_unit: 'weeks',
    tender_return_deadline: '29/10/2026',
    subcontractors: firms.map((f) => ({
      subcontractor_id: f.id, name: f.name, status: 'active', selected: true, suggestion_reason: '', usp: '',
      contact_name: 'Sam', contact_email: `${f.id}@firm.test`, off_register: false,
      dispatched_at: '2026-10-01T10:00:00Z', response: f.response,
      accepted: f.response === 'will_tender', declined: f.response === 'decline',
      tendered_sum: f.tendered_sum, is_fabricated: false,
      query_count: 0, outstanding_queries: 0, comms_thread_id: null,
      dispatch_id: f.dispatch_id, response_source: f.response_source,
      reminder_kind: kindFor(f), reminders_sent: f.reminders_sent,
      last_reminder_at: f.reminders_sent ? '2026-10-08T00:30:00Z' : null,
      last_reminder_kind: f.reminders_sent ? kindFor(f) : null
    }))
  });

  return page.route(API_PATTERN, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown;
    try { body = request.postDataJSON(); } catch { body = undefined; }
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

    if (path === `/api/packages/${PACKAGE_ID}/tender-prep`) {
      return json({ id: WORKFLOW_ID, package_id: PACKAGE_ID, current_step: 2, step_data: {}, updated_at: '2026-09-11T09:00:00Z' });
    }
    if (path === `/api/tender-prep/${WORKFLOW_ID}/dashboard`) return json([row()]);

    const reminder = /^\/api\/tender-prep\/itt\/([^/]+)\/reminder$/.exec(path);
    if (reminder && request.method() === 'POST') {
      posts.push({ path, body });
      const target = firms.find((f) => f.dispatch_id === reminder[1]);
      if (!target || !kindFor(target)) return json({ error: 'CONFLICT', message: 'Nothing to remind them of.' }, 409);
      if (options.failSends) return json({ kind: kindFor(target), status: 'failed', error: 'provider unavailable' });
      target.reminders_sent += 1;
      return json({ kind: kindFor(target), status: 'sent' });
    }

    const mark = /^\/api\/tender-prep\/itt\/([^/]+)$/.exec(path);
    if (mark && request.method() === 'PATCH') {
      posts.push({ path, body });
      const target = firms.find((f) => f.dispatch_id === mark[1]);
      if (target) {
        target.response = (body as { response: FirmState['response'] }).response;
        target.response_source = 'manual';
      }
      return json({ id: mark[1] });
    }
    return json([]);
  }).then(async () => {
    await page.goto(`/tps/dashboard?packageId=${PACKAGE_ID}`);
    return { firms, posts };
  });
}

const firmRow = (page: Page, name: string) => page.locator('tr').filter({ hasText: name });

test('names the email that will go, by the firm\'s state', async ({ page }) => {
  await model(page);
  // Not yet answered: the email asks for a yes or a no.
  await expect(firmRow(page, 'Silent Glazing').getByRole('button', { name: 'Ask to confirm interest' })).toBeVisible();
  // Accepted but no price back: the email is about submitting.
  await expect(firmRow(page, 'Accepted Facades').getByRole('button', { name: 'Remind to submit' })).toBeVisible();
});

test('offers no button to a firm that declined or has already priced', async ({ page }) => {
  await model(page);
  await expect(firmRow(page, 'Declined Cladding').getByRole('button')).toHaveCount(0);
  await expect(firmRow(page, 'Submitted Screens').getByRole('button')).toHaveCount(0);
});

test('sends the reminder and shows it in the history', async ({ page }) => {
  const { posts } = await model(page);
  await firmRow(page, 'Silent Glazing').getByRole('button', { name: 'Ask to confirm interest' }).click();

  await expect(firmRow(page, 'Silent Glazing').getByText(/1 sent · last confirm interest/)).toBeVisible();
  // One POST, to that firm's own invitation. There is no body: the SERVER picks the email.
  expect(posts.filter((p) => p.path.endsWith('/reminder')).map((p) => p.path))
    .toEqual(['/api/tender-prep/itt/d-1/reminder']);
});

test('says out loud when the send failed, rather than swallowing it', async ({ page }) => {
  await model(page, { failSends: true });
  await firmRow(page, 'Silent Glazing').getByRole('button', { name: 'Ask to confirm interest' }).click();
  await expect(firmRow(page, 'Silent Glazing').getByText(/Not sent: provider unavailable/)).toBeVisible();
});

test('a mark read from the firm\'s email says so, and confirming makes it a person\'s decision', async ({ page }) => {
  const { firms, posts } = await model(page);
  const read = firmRow(page, 'Read From Email');
  await expect(read.getByText('Marked from their email')).toBeVisible();

  await read.getByRole('button', { name: 'Confirm' }).click();
  // Sent as the SAME response it already carried: confirming changes who decided, not what.
  await expect.poll(() => posts.find((p) => p.path === '/api/tender-prep/itt/d-5')?.body).toEqual({ response: 'will_tender' });
  await expect(read.getByText('Marked from their email')).toHaveCount(0);
  expect(firms.find((f) => f.id === 'sc-5')?.response_source).toBe('manual');
});

test('a mark a person set carries no "from their email" note', async ({ page }) => {
  await model(page);
  await expect(firmRow(page, 'Accepted Facades').getByText('Marked from their email')).toHaveCount(0);
});
