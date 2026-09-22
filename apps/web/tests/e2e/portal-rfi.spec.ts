/**
 * Raising a subcontractor query from the pricing portal, driven in a real browser.
 *
 * The API is served by the small in-memory model below rather than the BFF, and it is a
 * MODEL, not a set of canned replies: the POST actually appends to the thread and the next
 * read shows it. Canned replies would pass while the form sent the wrong author, dropped
 * the attachment, or never re-read at all — which are exactly the three things worth
 * testing here.
 *
 * The load-bearing assertion is the AUTHOR. The portal link already identifies the firm,
 * so it would be easy to file a query under the link's recipient and never notice. The
 * whole reason the form asks for a name and email is that the person raising a query is
 * routinely a colleague of the estimator the ITT was addressed to.
 */
import { expect, test, type Page } from '@playwright/test';

// Matched by suffix, not against an absolute base. The app is served under the `/tps/`
// base, so `portalBaseUrl()` resolves to the relative `/tps-api` and these calls go to the
// dev server's own origin rather than VITE_API_URL.
const API_PATTERN = '**/portal/**';
// The `/tps/` prefix is the Vite base, the same one tender-dashboard.spec.ts navigates
// with. Without it the dev server answers 404 with a note suggesting the right path, and
// the page never mounts at all.
const TOKEN = 'tok-abc';
const PORTAL_PATH = `/tps/respond/${TOKEN}`;
const RECIPIENT = 'estimator@acme.test';

type Attachment = {
  id: string; filename: string; content_type: string | null; byte_size: number | null;
  share_url: string | null; share_token: string | null; share_expires_at: string | null;
};
type Message = {
  id: string; direction: 'inbound' | 'outbound'; channel: 'portal' | 'email' | 'app';
  kind: 'subcontractor_rfi' | 'client_forward' | 'client_reply' | 'relay_to_subcontractor' | 'note';
  author_name: string | null; author_email: string | null;
  subject: string | null; body_text: string | null;
  occurred_at: string; received_at: string; shortlist_entry_id: string | null;
  attachments: Attachment[];
};

function portal(page: Page) {
  const messages: Message[] = [];
  const raised: Array<Record<string, unknown>> = [];
  let nextId = 1;

  const thread = () => ({
    thread: {
      id: 'thread-1', workflow_id: 'wf-1', counterparty_kind: 'subcontractor',
      counterparty_email: RECIPIENT, counterparty_name: 'Acme Drylining',
      subject: null, status: 'open', last_message_at: new Date().toISOString()
    },
    messages
  });

  page.route(API_PATTERN, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body)
    });

    if (url.pathname.endsWith('/rfi') && method === 'POST') {
      const payload = route.request().postDataJSON() as {
        authorName: string; authorEmail: string; subject: string | null; body: string;
        attachments: Array<{ filename: string; contentBase64: string }>;
      };
      raised.push(payload);
      messages.push({
        id: `m-${nextId++}`, direction: 'inbound', channel: 'portal', kind: 'subcontractor_rfi',
        author_name: payload.authorName, author_email: payload.authorEmail,
        subject: payload.subject, body_text: payload.body,
        occurred_at: new Date().toISOString(), received_at: new Date().toISOString(),
        shortlist_entry_id: 'se-1',
        attachments: payload.attachments.map((attachment, index) => ({
          id: `a-${index}`, filename: attachment.filename, content_type: 'application/pdf',
          // Decoded length, which is what the server records — so the size shown in the
          // UI is the file's size and not the base64 envelope's.
          byte_size: Math.floor(attachment.contentBase64.length * 3 / 4),
          share_url: 'http://buildflow.test/links/tok-file',
          share_token: 'tok-file', share_expires_at: null
        }))
      });
      return json(thread());
    }

    if (url.pathname.endsWith('/thread')) return json(messages.length ? thread() : null);

    // The pricing page itself.
    return json({
      id: 'link-1', package_name: 'Drylining & Partitions', tenderer_name: 'Acme Drylining',
      recipient_email: RECIPIENT, submitted_at: null, programme_weeks: null,
      qualifications: null, exclusions: null, tender_return_deadline: null,
      lines: [{
        id: 'l-1', seq: 1, ge_code: null, element_code: null, description: 'Metal stud partition',
        quantity: '120', unit: 'm2', is_priceable: true, rate: null, total: null,
        status: 'not_addressed', note: null, added_by_tenderer: false
      }]
    });
  });

  return { raised, messages };
}

async function openForm(page: Page) {
  await page.goto(PORTAL_PATH);
  await expect(page.getByRole('heading', { name: 'Questions about this package' })).toBeVisible();
  await page.getByRole('button', { name: 'Request information' }).click();
}

test('pre-fills the email from the link but lets it be changed', async ({ page }) => {
  portal(page);
  await openForm(page);
  // Right most of the time, which is why it is pre-filled; not right every time, which is
  // why it is an input and not a label.
  await expect(page.getByLabel('Your email')).toHaveValue(RECIPIENT);
  await expect(page.getByLabel('Your email')).toBeEditable();
});

test('records who actually asked, not the firm the link was issued to', async ({ page }) => {
  const model = portal(page);
  await openForm(page);

  await page.getByLabel('Your name').fill('Sam Colleague');
  await page.getByLabel('Your email').fill('sam@acme.test');
  await page.getByLabel('Subject').fill('Ceiling grid');
  await page.getByLabel('Question').fill('Is the suspended ceiling grid included in this package?');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('button', { name: 'Request information' })).toBeVisible();
  expect(model.raised).toHaveLength(1);
  expect(model.raised[0]).toMatchObject({
    authorName: 'Sam Colleague',
    authorEmail: 'sam@acme.test',
    subject: 'Ceiling grid',
    body: 'Is the suspended ceiling grid included in this package?'
  });
  // The typed address, not the link's recipient — the assertion this whole form exists for.
  expect(model.raised[0].authorEmail).not.toBe(RECIPIENT);
});

test('shows the query back on the page, with who asked it', async ({ page }) => {
  portal(page);
  await openForm(page);
  await page.getByLabel('Your name').fill('Sam Colleague');
  await page.getByLabel('Your email').fill('sam@acme.test');
  await page.getByLabel('Question').fill('Is the grid included?');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('Is the grid included?')).toBeVisible();
  await expect(page.getByText('Sam Colleague')).toBeVisible();
  await expect(page.getByText('sam@acme.test')).toBeVisible();
});

test('sends an attachment and renders it as a preview link', async ({ page }) => {
  const model = portal(page);
  await openForm(page);
  await page.getByLabel('Your name').fill('Sam Colleague');
  await page.getByLabel('Question').fill('See the marked-up sketch.');
  await page.getByLabel('Files').setInputFiles({
    name: 'sketch.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 pretend sketch')
  });
  await page.getByRole('button', { name: 'Send' }).click();
  // Reading the file and base64-encoding it is genuinely async — without this wait the
  // assertions below run while the request is still in flight (the button still reads
  // "Sending…") and `model.raised[0]` is undefined. The other tests in this file get this
  // for free because they assert on the panel closing first; this one has to ask for it
  // explicitly since it goes straight to the model.
  await expect(page.getByRole('button', { name: 'Request information' })).toBeVisible();

  const attachments = model.raised[0].attachments as Array<{ filename: string; contentBase64: string }>;
  expect(attachments).toHaveLength(1);
  expect(attachments[0].filename).toBe('sketch.pdf');
  // Base64 of the real bytes, with the `data:` prefix FileReader adds already stripped —
  // leaving it on would store a file whose first bytes are the MIME header.
  expect(Buffer.from(attachments[0].contentBase64, 'base64').toString()).toBe('%PDF-1.4 pretend sketch');

  const link = page.getByRole('link', { name: /sketch\.pdf/ });
  await expect(link).toBeVisible();
  // Asks for a preview. BuildFlow honours it only for types that cannot execute script and
  // silently downloads anything else, so asking is always safe.
  await expect(link).toHaveAttribute('href', 'http://buildflow.test/links/tok-file?disposition=inline');
});

test('will not send a query with no question in it', async ({ page }) => {
  portal(page);
  await openForm(page);
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await page.getByLabel('Your name').fill('Sam Colleague');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await page.getByLabel('Question').fill('Anything at all');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('shows nothing but the invitation before anything has been raised', async ({ page }) => {
  portal(page);
  await page.goto(PORTAL_PATH);
  await expect(page.getByRole('button', { name: 'Request information' })).toBeVisible();
  // "Nothing yet" is a state of the pricing page, not an empty timeline pushed at a
  // tenderer who has not asked anything.
  await expect(page.getByText('Nothing has been raised yet.')).toHaveCount(0);
});
