/**
 * The tender dashboard, driven in a real browser.
 *
 * The API is served by the small in-memory model below rather than the BFF, and it is a
 * MODEL, not a set of canned replies: confirming a package actually flips it, and the next
 * read shows it. Canned replies would pass while the modal saved the wrong package, dropped
 * the firms nobody ticked, or never re-read the dashboard at all — which are exactly the
 * three things worth testing here.
 *
 * The fixture keeps the shape of a real launch table rather than its size: a heading with a
 * breakdown beneath it (not tendered itself, so never approvable), a pending package, and a
 * confirmed one whose firms have answered — one accepting with a price, one declining.
 */
import { expect, test, type Page } from '@playwright/test';

// Matched by suffix, not against an absolute base: vite loads the repo's root .env here
// (envDir '../..'), so VITE_API_URL is whatever that file happens to say.
const API_PATTERN = '**/api/**';
const PACKAGE_ID = '11111111-1111-4111-8111-111111111111';
const WORKFLOW_ID = '22222222-2222-4222-8222-222222222222';

type Firm = {
  subcontractor_id: string; name: string; status: string; profile_completeness_pct: number;
  performance_score: string | null; ratings_count: number; matched_trades: string[];
  selected: boolean; suggestion_reason: string; usp: string;
  contact_name: string | null; contact_email: string | null; compliance_flags: Record<string, unknown>;
  off_register: boolean;
};

function firm(id: string, name: string, selected: boolean): Firm {
  return {
    subcontractor_id: id, name, status: 'active', profile_completeness_pct: 90,
    performance_score: '82.00', ratings_count: 4, matched_trades: ['Drylining'],
    selected, suggestion_reason: `${name} carries this trade`, usp: `${name} covers the South East`,
    contact_name: `${name} estimator`, contact_email: `bids@${name.toLowerCase().replace(/\W/g, '')}.test`,
    compliance_flags: {}, off_register: false
  };
}

type Pkg = {
  package_config_id: string; seq: number; sub_seq: number | null; display_ref: string;
  is_heading: boolean; is_sub_package: boolean; package_name: string;
  configured_route: string; route_of_procurement: string; route_options: string[];
  trade_terms: string[]; stranded_bill_lines: number; notes: string | null;
  confirmed_at: string | null; board_override_notes: string | null;
  tender_return_period_value: number | null; tender_return_period_unit: string | null;
  tender_return_deadline: string | null; subcontractors: Firm[];
};

function fixture(): Pkg[] {
  const shell = (over: Partial<Pkg>): Pkg => ({
    package_config_id: 'pc-0', seq: 1, sub_seq: null, display_ref: '1',
    is_heading: false, is_sub_package: false, package_name: 'Package',
    configured_route: 'Supply and install', route_of_procurement: 'Supply and install',
    route_options: ['Supply and install', 'Install only'], trade_terms: [], stranded_bill_lines: 0,
    notes: null, confirmed_at: null, board_override_notes: null,
    tender_return_period_value: null, tender_return_period_unit: null,
    tender_return_deadline: null, subcontractors: [], ...over
  });
  return [
    // Broken down, so it is not tendered itself and must never offer an approval control.
    shell({ package_config_id: 'pc-1', seq: 1, display_ref: '1', is_heading: true, package_name: 'MEP', subcontractors: [] }),
    shell({
      package_config_id: 'pc-2', seq: 1, sub_seq: 1, display_ref: '1.1', is_sub_package: true,
      package_name: 'Mechanical',
      subcontractors: [firm('sc-1', 'Alpha Mechanical', false), firm('sc-2', 'Beta Mechanical', false)]
    }),
    shell({
      package_config_id: 'pc-3', seq: 2, display_ref: '2', package_name: 'Drylining',
      confirmed_at: '2026-09-10T10:00:00Z', tender_return_period_value: 3,
      tender_return_period_unit: 'weeks', tender_return_deadline: '01/10/2026',
      subcontractors: [firm('sc-3', 'Gamma Drylining', true), firm('sc-4', 'Delta Drylining', true)]
    }),
    // Signed off with nobody to invite — the state that made a package vanish from Step 2.
    shell({
      package_config_id: 'pc-4', seq: 3, display_ref: '3', package_name: 'Roofing',
      confirmed_at: '2026-09-18T20:33:00Z', subcontractors: []
    })
  ];
}

async function dashboard(page: Page, options: {
  rfiCounts?: { blocked: number; drafted: number; approved: number; for_client: number };
} = {}) {
  const packages = fixture();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];

  // What the dashboard endpoint adds on top of the launch table: only the firms actually
  // picked, each carrying what it answered and what it priced.
  const dashboardRows = () => packages.map((pkg) => ({
    ...pkg,
    subcontractors: pkg.subcontractors.filter((f) => f.selected).map((f) => ({
      ...f,
      dispatched_at: pkg.confirmed_at ? '2026-09-11T09:00:00Z' : null,
      response: f.subcontractor_id === 'sc-3' ? 'will_tender' : f.subcontractor_id === 'sc-4' ? 'decline' : null,
      accepted: f.subcontractor_id === 'sc-3',
      declined: f.subcontractor_id === 'sc-4',
      tendered_sum: f.subcontractor_id === 'sc-3' ? '184250.00' : null,
      is_fabricated: false,
      // Per FIRM and per tender, not per package (issue #34): one conversation with one
      // firm. Gamma has asked twice with one still to go to the client; Delta has asked
      // once and it has been put to them; nobody else has asked at all.
      ...(f.subcontractor_id === 'sc-3'
        ? { query_count: 2, outstanding_queries: 1, comms_thread_id: 'thread-gamma' }
        : f.subcontractor_id === 'sc-4'
          ? { query_count: 1, outstanding_queries: 0, comms_thread_id: 'thread-delta' }
          : { query_count: 0, outstanding_queries: 0, comms_thread_id: null })
    }))
  }));

  await page.route(API_PATTERN, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown;
    try { body = request.postDataJSON(); } catch { body = undefined; }
    calls.push({ method: request.method(), path, body });
    const json = (value: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });

    if (path === `/api/packages/${PACKAGE_ID}/tender-prep`) {
      return json({ id: WORKFLOW_ID, package_id: PACKAGE_ID, current_step: 1, step_data: {}, updated_at: '2026-09-11T09:00:00Z' });
    }
    if (path === `/api/tender-prep/${WORKFLOW_ID}/dashboard`) return json(dashboardRows());
    if (path === `/api/tender-prep/${WORKFLOW_ID}/launch-table`) return json(packages);
    // The RFI review counts badge (issue #48) — undefined here reproduces every OTHER
    // test in this file, which never stub it and must still render exactly as before.
    if (path === `/api/tender-prep/${WORKFLOW_ID}/rfi` && options.rfiCounts) {
      return json({ counts: options.rfiCounts });
    }
    if (path === `/api/tender-prep/${WORKFLOW_ID}/packages/selection`) {
      const input = body as { packageName: string; entries: Array<{ subcontractorId: string; selected: boolean }> };
      const target = packages.find((pkg) => pkg.package_name === input.packageName);
      if (target) {
        target.confirmed_at = '2026-09-18T12:00:00Z';
        for (const firmRow of target.subcontractors) {
          firmRow.selected = input.entries.some((e) => e.subcontractorId === firmRow.subcontractor_id && e.selected);
        }
      }
      return json({ ok: true });
    }
    return json([]);
  });

  await page.goto(`/tps/dashboard?packageId=${PACKAGE_ID}`);
  return { calls };
}

test('reports each package with the firms it went to and what came back', async ({ page }) => {
  await dashboard(page);
  await expect(page.getByRole('heading', { name: 'Tender Dashboard' })).toBeVisible();
  await expect(page.getByText('2 of 3 packages confirmed')).toBeVisible();

  const accepted = page.locator('tr', { hasText: 'Gamma Drylining' });
  await expect(accepted).toContainText('184,250');
  await expect(accepted).toContainText('01/10/2026');

  // A decline is its own column: "not accepted" also covers a firm that never answered.
  const declined = page.locator('tr', { hasText: 'Delta Drylining' });
  await expect(declined).not.toContainText('184,250');

  await expect(page.locator('tr', { hasText: 'Mechanical' }).first()).toContainText('No firms selected yet');
});

test('a package confirmed with nobody invited does not read as plain Confirmed', async ({ page }) => {
  // Confirming and having recipients are different facts. Showing them as one green badge is
  // what let a package be signed off and silently absent from ITT Dispatch at the same time.
  await dashboard(page);
  const roofing = page.locator('tr', { hasText: 'Roofing' });
  await expect(roofing).toContainText('Confirmed · nobody invited');
  await expect(roofing).toContainText('No firms selected yet');
  // It is confirmed, so it is not offered for approval again.
  await expect(page.getByRole('button', { name: 'Approve Roofing' })).toHaveCount(0);
});

test('offers approval on a pending package only, and never on a heading', async ({ page }) => {
  await dashboard(page);
  await expect(page.getByRole('button', { name: 'Approve Mechanical' })).toBeVisible();
  // Confirmed already — there is nothing to approve.
  await expect(page.getByRole('button', { name: 'Approve Drylining' })).toHaveCount(0);
  // A heading is not tendered; its breakdown is.
  await expect(page.getByRole('button', { name: 'Approve MEP' })).toHaveCount(0);
});

test('approving opens Step 1 for that package alone, and confirming updates the dashboard', async ({ page }) => {
  const { calls } = await dashboard(page);
  await page.getByRole('button', { name: 'Approve Mechanical' }).click();

  const modal = page.locator('.modal');
  await expect(modal).toContainText('Approve Mechanical');
  // The whole point of the modal: one package, not the entire launch table.
  await expect(modal).not.toContainText('Drylining');
  // And it offers every candidate, not only the ones already picked — which is what the
  // dashboard's own row carries, and why the modal reads the launch table instead.
  await expect(modal.locator('.sub-name')).toHaveText(['Alpha Mechanical', 'Beta Mechanical']);

  await modal.getByRole('checkbox').first().check();
  await modal.getByRole('button', { name: 'Confirm' }).click();

  const save = () => calls.find((call) => call.method === 'POST' && call.path.endsWith('/packages/selection'));
  await expect.poll(save).toBeTruthy();
  const input = save()!.body as { packageName: string; entries: Array<{ subcontractorId: string; selected: boolean }> };
  expect(input.packageName).toBe('Mechanical');
  // Every firm the meeting saw is recorded, not only the tick — the record has to answer
  // "who was considered", not merely "who was chosen".
  expect(input.entries).toHaveLength(2);
  expect(input.entries.filter((entry) => entry.selected)).toHaveLength(1);

  // The dashboard is keyed under the launch table, so confirming refreshes it with no
  // further wiring: the count moves and the approval control goes.
  await expect(page.getByText('3 of 3 packages confirmed')).toBeVisible();
});

test('marks the contractors that have asked for clarification, and only those', async ({ page }) => {
  // The icon the issue asks for: leftmost against the contractor, on the dashboard, so a
  // buyer scanning the page sees who is waiting on them without opening anything.
  await dashboard(page);

  const asked = page.getByRole('link', { name: "Open Gamma Drylining's queries" });
  await expect(asked).toBeVisible();
  await expect(asked.locator('.query-count')).toHaveText('2');
  // Straight to that firm's conversation, not to the tender page to hunt for it.
  await expect(asked).toHaveAttribute('href', /tender-prep\?thread=thread-gamma$/);

  // A firm whose questions have all been put to the client is marked differently from
  // one still holding an unanswered question: the second is somebody's to chase.
  await expect(asked).toHaveClass(/is-outstanding/);
  const settled = page.getByRole('link', { name: "Open Delta Drylining's queries" });
  await expect(settled).not.toHaveClass(/is-outstanding/);

  // And a firm that has asked nothing leaves the column blank, so the eye runs down it.
  await expect(page.getByRole('link', { name: /Open Alpha Mechanical/ })).toHaveCount(0);
});

test('shows the drafts-waiting badge and opens the review tab from it (issue #48)', async ({ page }) => {
  await dashboard(page, { rfiCounts: { blocked: 2, drafted: 3, approved: 0, for_client: 0 } });
  const badge = page.getByRole('link', { name: /to file/ });
  await expect(badge).toContainText('2 to file');
  await expect(badge).toContainText('3 drafted answers to review');
  await expect(badge).toHaveAttribute('href', new RegExp(`tender-prep\\?rfi=1$`));
});

test('shows no badge at all when nothing is blocked or drafted', async ({ page }) => {
  await dashboard(page, { rfiCounts: { blocked: 0, drafted: 0, approved: 0, for_client: 0 } });
  await expect(page.getByText(/to file|drafted answer/)).toHaveCount(0);
});
