/**
 * The notification bell and the cross-tender timeline, in a real browser.
 *
 * Four things are worth asserting here and nowhere else:
 *
 *  - a notification NAVIGATES, and lands on the conversation it named. The whole feature
 *    is "tell me a firm has asked something, and take me to it"; a bell that lists events
 *    you then have to go and find by hand is a worse version of doing nothing;
 *  - it is marked read on the way OUT. A bell that clears itself on open loses exactly
 *    the item somebody opened it to find and then closed to go and deal with;
 *  - the timeline filters BY TENDER, and offers "not attributed" as an option of its own.
 *    A message nobody could place is the one most worth looking at and is unreachable
 *    anywhere else in the application;
 *  - an untriaged notification goes to the timeline rather than a tender page, because
 *    there is no tender page for it to go to.
 *
 * The API is served by the model below rather than the BFF, and it is a MODEL: marking
 * read really does change what the next read returns, so a page that sent the wrong ids
 * fails rather than passing on a canned reply.
 */
import { expect, test, type Page } from '@playwright/test';

const API_PATTERN = '**/api/**';
const PACKAGE_ID = '11111111-1111-4111-8111-111111111111';
const WORKFLOW_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_WORKFLOW_ID = '33333333-3333-4333-8333-333333333333';

type Notification = {
  id: string; kind: string; title: string; body: string | null; deep_link_path: string;
  created_at: string; thread_id: string | null; workflow_id: string | null;
  subcontractor_id: string | null; read_at: string | null;
};

function notification(over: Partial<Notification> & { id: string }): Notification {
  return {
    kind: 'subcontractor_rfi', title: 'Acme Drylining raised a query', body: 'Ceiling grid',
    deep_link_path: `/packages/${PACKAGE_ID}/tender-prep?thread=thread-acme`,
    created_at: '2026-09-18T09:00:00.000Z', thread_id: 'thread-acme', workflow_id: WORKFLOW_ID,
    subcontractor_id: 'sc-1', read_at: null, ...over
  };
}

function thread(over: Record<string, unknown> & { id: string }) {
  return {
    workflow_id: WORKFLOW_ID, counterparty_kind: 'subcontractor',
    counterparty_email: 'estimator@acme.test', counterparty_name: 'Acme Drylining',
    subject: null, status: 'open', last_message_at: '2026-09-18T09:00:00.000Z',
    message_count: '2', inbound_count: '1', attachment_count: '0',
    package_id: PACKAGE_ID, tender_name: 'Reading Riverside', ...over
  };
}

function model(page: Page, notifications: Notification[]) {
  const items = notifications.map((item) => ({ ...item }));
  const reads: string[][] = [];

  const threads = [
    thread({ id: 'thread-acme' }),
    thread({
      id: 'thread-brightwork', counterparty_email: 'bids@brightwork.test',
      counterparty_name: 'Brightwork Ceilings', workflow_id: OTHER_WORKFLOW_ID,
      tender_name: 'Bessborough Gardens', last_message_at: '2026-09-17T09:00:00.000Z'
    }),
    // An email nobody could place. It has no tender, so the filter has to offer it an
    // option of its own or it is invisible.
    thread({
      id: 'thread-stranger', counterparty_email: 'jo@stranger.test', counterparty_name: null,
      workflow_id: null, package_id: null, tender_name: null,
      last_message_at: '2026-09-16T09:00:00.000Z'
    })
  ];

  page.route(API_PATTERN, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body)
    });

    if (path.endsWith('/api/notifications')) {
      return json({ items, unread: items.filter((item) => item.read_at == null).length });
    }
    if (path.endsWith('/api/notifications/read')) {
      const input = route.request().postDataJSON() as { notificationIds: string[] };
      reads.push(input.notificationIds);
      const targets = input.notificationIds.length > 0
        ? new Set(input.notificationIds)
        : new Set(items.map((item) => item.id));
      let marked = 0;
      for (const item of items) {
        if (targets.has(item.id) && item.read_at == null) {
          item.read_at = '2026-09-18T10:00:00.000Z';
          marked += 1;
        }
      }
      return json({ marked, unread: items.filter((item) => item.read_at == null).length });
    }
    if (path.endsWith('/api/comms/timeline')) {
      return json({
        threads,
        tenders: [
          { workflow_id: WORKFLOW_ID, package_id: PACKAGE_ID, name: 'Reading Riverside' },
          { workflow_id: OTHER_WORKFLOW_ID, package_id: 'pkg-2', name: 'Bessborough Gardens' }
        ]
      });
    }
    if (path.includes('/api/comms/threads/')) {
      const id = path.split('/').at(-1)!;
      return json({
        thread: threads.find((row) => row.id === id) ?? threads[0],
        messages: [{
          id: `m-${id}`, direction: 'inbound', channel: 'portal', kind: 'subcontractor_rfi',
          author_name: 'Sam Colleague', author_email: 'sam@acme.test',
          subject: 'Ceiling grid', body_text: 'Is the grid in our package?',
          occurred_at: '2026-09-18T09:00:00.000Z', received_at: '2026-09-18T09:00:00.000Z',
          shortlist_entry_id: null, attachments: []
        }]
      });
    }
    if (path.endsWith(`/packages/${PACKAGE_ID}/tender-prep`)) {
      return json({
        id: WORKFLOW_ID, package_id: PACKAGE_ID, current_step: 2, status: 'in_progress',
        step_data: { takeoff: { packageName: 'Reading Riverside' } },
        updated_at: '2026-09-18T09:00:00.000Z'
      });
    }
    // Step 2 needs one confirmed package, which is also the only state in which a query
    // could exist at all.
    if (path.endsWith('/itts')) {
      return json([{
        package_name: 'Drylining', package_seq: 1, route_of_procurement: 'Supply and install',
        recipients: 2, candidates: 4, dispatched: 2, sent: 2, failed: 0, skipped_no_email: 0,
        responses_received: 0, portal_denials: 0, responded: 0,
        confirmed_at: '2026-09-01T09:00:00.000Z'
      }]);
    }
    if (path.endsWith('/threads')) return json([thread({ id: 'thread-acme' })]);
    if (path.endsWith('/itt-letter-details')) return json(null);
    if (path.endsWith('/workflows')) return json([]);
    return json([]);
  });

  return { reads, items };
}

test('the bell carries the unread count and lists what happened', async ({ page }) => {
  model(page, [
    notification({ id: 'n1' }),
    notification({
      id: 'n2', kind: 'client_reply', title: 'The client answered your queries',
      body: 'Both are included.'
    }),
    notification({ id: 'n3', title: 'Seen already', read_at: '2026-09-17T09:00:00.000Z' })
  ]);
  await page.goto('/tps/');

  const bell = page.getByRole('button', { name: 'Notifications (2 unread)' });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByText('2 unread of 3')).toBeVisible();
  await expect(page.getByText('Acme Drylining raised a query')).toBeVisible();
  await expect(page.getByText('Client answer', { exact: true })).toBeVisible();
});

test('clicking a query opens that firm’s history on ITT Dispatch, and marks it read', async ({ page }) => {
  const { reads } = model(page, [
    notification({ id: 'n1' }), notification({ id: 'n2', title: 'Second query' })
  ]);
  await page.goto('/tps/');
  await page.getByRole('button', { name: 'Notifications (2 unread)' }).click();
  await page.getByRole('button', { name: /Acme Drylining raised a query/ }).click();

  // The URL the notification named, carrying the thread — not merely "the tender page".
  await expect(page).toHaveURL(new RegExp(`/tps/packages/${PACKAGE_ID}/tender-prep\\?thread=thread-acme$`));
  // And the conversation is open, rather than the reader having to find it.
  await expect(page.getByRole('heading', { name: /Communications/ })).toBeVisible();
  await expect(page.getByText('Is the grid in our package?')).toBeVisible();

  // Exactly the one clicked. Its sibling stays unread, which is the difference between
  // this and "mark all".
  await expect.poll(() => reads).toEqual([['n1']]);
  await expect(page.getByRole('button', { name: 'Notifications (1 unread)' })).toBeVisible();
});

test('an unattributed email goes to the timeline, because it has no tender page', async ({ page }) => {
  model(page, [notification({
    id: 'n1', kind: 'unattributed_email', title: 'Unattributed email from jo@stranger.test',
    workflow_id: null, thread_id: 'thread-stranger',
    deep_link_path: '/communications?thread=thread-stranger'
  })]);
  await page.goto('/tps/');
  await page.getByRole('button', { name: /Notifications/ }).click();
  await page.getByRole('button', { name: /Unattributed email/ }).click();

  await expect(page).toHaveURL(/\/tps\/communications\?thread=thread-stranger$/);
  // Deep-linked straight into the conversation, not to a list to search.
  await expect(page.getByText('Is the grid in our package?')).toBeVisible();
});

test('"Mark all as read" sends an empty list and clears the badge', async ({ page }) => {
  const { reads } = model(page, [
    notification({ id: 'n1' }), notification({ id: 'n2', title: 'Second query' })
  ]);
  await page.goto('/tps/');
  await page.getByRole('button', { name: 'Notifications (2 unread)' }).click();
  await page.getByRole('button', { name: 'Mark all as read' }).click();

  // Empty rather than the ids on screen: the page holds a window of a longer list, and
  // enumerating what it happens to have would leave the rest unread.
  await expect.poll(() => reads).toEqual([[]]);
  await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
  // Read rows stay listed — the bell is a history as well as an inbox.
  await expect(page.getByText('Acme Drylining raised a query')).toBeVisible();
});

test('the timeline spans tenders and filters by one', async ({ page }) => {
  model(page, [notification({ id: 'n1' })]);
  await page.goto('/tps/');
  await page.getByRole('button', { name: /Notifications/ }).click();
  await page.getByRole('button', { name: 'All conversations' }).click();

  await expect(page.getByText('3 of 3')).toBeVisible();
  await expect(page.getByText('Acme Drylining')).toBeVisible();
  await expect(page.getByText('Brightwork Ceilings')).toBeVisible();

  await page.getByLabel('Tender').selectOption(OTHER_WORKFLOW_ID);
  await expect(page.getByText('1 of 3')).toBeVisible();
  await expect(page.getByText('Brightwork Ceilings')).toBeVisible();
  await expect(page.getByText('Acme Drylining')).toHaveCount(0);
});

test('"not attributed to a tender" is a filter option of its own', async ({ page }) => {
  // The case that has no tender to be filtered by, and is invisible without it.
  model(page, [notification({ id: 'n1' })]);
  await page.goto('/tps/');
  await page.getByRole('button', { name: /Notifications/ }).click();
  await page.getByRole('button', { name: 'All conversations' }).click();

  await page.getByLabel('Tender').selectOption('none');
  await expect(page.getByText('1 of 3')).toBeVisible();
  await expect(page.getByText('jo@stranger.test')).toBeVisible();
});

test('the timeline page is reachable directly, filter and all', async ({ page }) => {
  model(page, []);
  await page.goto('/tps/communications');
  await expect(page.getByRole('heading', { name: 'Communications' })).toBeVisible();
  await expect(page.getByText('3 of 3')).toBeVisible();
  await page.getByRole('row', { name: /Brightwork Ceilings/ }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByText('Is the grid in our package?')).toBeVisible();
});
