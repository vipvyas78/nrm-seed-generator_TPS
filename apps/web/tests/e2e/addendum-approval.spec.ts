/**
 * The tender addendum approval screen, driven in a real browser (issue #83, follow-up
 * to #78).
 *
 * `addendum.tsx`/`addendumDelta.ts` already have component-level coverage
 * (`tests/unit/addendum.test.tsx`, `addendumDelta.test.ts`); nothing exercises them
 * end to end, the way `tender-dashboard.spec.ts` and `notifications.spec.ts` do for
 * their own screens. Four things are worth proving here rather than at the unit level:
 *
 *  - `available: false` (on the delta's own baseline_resolution, or its conflicts/
 *    documents sub-objects) NEVER reads as "nothing changed" — the one failure mode
 *    addendumDelta.ts is unit-tested to prevent, now proven against the rendered DOM;
 *  - the approve payload really does carry every package row over the network, with an
 *    un-ticked package's date forced to null, and a rejected payload's own error message
 *    reaches the screen rather than failing silently;
 *  - after a mutation the screen reflects the SERVER's state (refetched), not local
 *    optimism — proven by disabling controls and by the list view picking up a status
 *    change made in the detail view, without a reload;
 *  - the two entry points — a `?addendum=` deep link in the URL, and clicking the same
 *    kind of notification from the bell — both land on that addendum's detail view
 *    directly, not the list.
 *
 * The API is served by the small in-memory model below rather than the BFF, and it is a
 * MODEL, not a set of canned replies: approving or issuing really does flip the
 * addendum's state, and the next read shows it. Canned replies would pass while the
 * screen sent the wrong payload, dropped an untouched package, or never re-read after a
 * mutation — precisely the things worth testing here.
 */
import { expect, test, type Page } from '@playwright/test';

const API_PATTERN = '**/api/**';
const PACKAGE_ID = '11111111-1111-4111-8111-111111111111';
const WORKFLOW_ID = '22222222-2222-4222-8222-222222222222';

type AddendumStatus = 'draft' | 'awaiting_approval' | 'approved' | 'issued' | 'cancelled';

type ChangeKind =
  | { kind: 'unit'; before: string | null; after: string | null; before_quantity: number | null; after_quantity: number | null }
  | { kind: 'now_measured'; before_quantity: null; after_quantity: number }
  | { kind: 'no_longer_measured'; before_quantity: number; after_quantity: null }
  // delta is a FRACTION (0.173 = +17.3%), and null when the baseline was 0.
  | { kind: 'quantity'; before_quantity: number | null; after_quantity: number | null; delta: number | null };

type ItemSummary = {
  id: string; ge_code: string | null; element_code: string | null; clause_ref: string | null;
  description: string | null; unit: string | null; quantity: number | null;
  work_package: string | null; measurement_method: string | null;
};

type ChangedPair = {
  rung: 'clause_ref' | 'component_key' | 'classification' | 'wording';
  change: ChangeKind; item: ItemSummary; baseline: ItemSummary;
};

type DeltaPackage = { work_package: string | null; unattributed: boolean; added: number; removed: number; changed: number };
type ConflictRow = {
  conflict_digest: string; ge_code: string | null; conflict_type: string; severity: string | null;
  spec_ref: string | null; drawing_ref: string | null; detail: string | null; review_status: string | null;
};
type DocumentRow = { display_name: string; dropbox_file_id: string };

type Delta = {
  baseline_takeoff_id: string | null;
  baseline_resolution: 'tendered' | 'none' | 'unavailable';
  items_added: number; items_removed: number; items_changed: number; items_unchanged: number;
  packages: DeltaPackage[];
  delta: { added: ItemSummary[]; removed: ItemSummary[]; changed: ChangedPair[] };
  conflicts: { new: ConflictRow[]; recurring: ConflictRow[]; resolved: ConflictRow[]; available: boolean };
  documents: { added: DocumentRow[]; changed: DocumentRow[]; removed: DocumentRow[]; available: boolean };
  rung_mix: Record<string, number>;
};

type PackageRow = {
  addendum_id: string; package_name: string; wp_code: string | null;
  proposed: boolean; included: boolean;
  items_added: number; items_removed: number; items_changed: number;
  unattributed: boolean; revised_return_deadline: string | null;
};

type Addendum = {
  id: string; workflow_id: string; seq: number;
  takeoff_id: string; baseline_takeoff_id: string | null; package_version_id: string | null;
  status: AddendumStatus;
  delta: Delta;
  created_by: string | null; created_at: string;
  approved_by: string | null; approved_at: string | null;
  issued_at: string | null; cancelled_at: string | null;
  packages: PackageRow[];
};

function delta(over: Partial<Delta> = {}): Delta {
  return {
    baseline_takeoff_id: 'TOQ-baseline',
    baseline_resolution: 'tendered',
    items_added: 2, items_removed: 0, items_changed: 1, items_unchanged: 40,
    packages: [
      { work_package: 'WP-CONCRETE', unattributed: false, added: 2, removed: 0, changed: 0 },
      { work_package: null, unattributed: true, added: 0, removed: 0, changed: 1 },
    ],
    delta: { added: [], removed: [], changed: [] },
    conflicts: { new: [], recurring: [], resolved: [], available: true },
    documents: { added: [], changed: [], removed: [], available: true },
    rung_mix: { clause_ref: 3, component_key: 0, classification: 0, wording: 0 },
    ...over,
  };
}

function pkgRow(over: Partial<PackageRow> = {}): PackageRow {
  return {
    addendum_id: 'a1', package_name: 'WP-CONCRETE', wp_code: 'WP-CONCRETE',
    proposed: true, included: true,
    items_added: 2, items_removed: 0, items_changed: 0,
    unattributed: false, revised_return_deadline: null,
    ...over,
  };
}

// Matches proposedPackages() in buildflowAddendumDeltaClient.ts / tenderPrepDb.ts's
// createAddendum exactly: 'Unattributed' with a null wp_code, never blank.
function addendum(over: Partial<Addendum> = {}): Addendum {
  const id = over.id ?? 'a1';
  return {
    id, workflow_id: WORKFLOW_ID, seq: 1,
    takeoff_id: 'TOQ-current', baseline_takeoff_id: 'TOQ-baseline', package_version_id: 'pv-1',
    status: 'awaiting_approval',
    delta: delta(),
    created_by: null, created_at: '2026-09-10T09:00:00.000Z',
    approved_by: null, approved_at: null, issued_at: null, cancelled_at: null,
    packages: [
      pkgRow({ addendum_id: id }),
      pkgRow({ addendum_id: id, package_name: 'Unattributed', wp_code: null, unattributed: true, items_added: 0, items_changed: 1 }),
    ],
    ...over,
  };
}

function itemSummary(over: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: 'i1', ge_code: 'GE2', element_code: '2G.210', clause_ref: null,
    description: 'Internal wall lining', unit: 'm2', quantity: 100,
    work_package: 'WP-CONCRETE', measurement_method: 'floor_area', ...over,
  };
}

// approveAddendum / issueAddendum both return the addenda row WITHOUT `packages` —
// api.ts's ApproveAddendumResult / IssueAddendumResult are Omit<Addendum, 'packages'>.
function withoutPackages<T extends { packages: unknown }>(row: T): Omit<T, 'packages'> {
  const clone = { ...row } as Omit<T, 'packages'> & { packages?: unknown };
  delete clone.packages;
  return clone;
}

type Notification = {
  id: string; kind: string; title: string; body: string | null; deep_link_path: string;
  created_at: string; thread_id: string | null; workflow_id: string | null;
  subcontractor_id: string | null; read_at: string | null;
};

type ModelOptions = {
  addenda?: Addendum[];
  currentStep?: number;
  notifications?: Notification[];
  issueResult?: { sent: number; failed: number; skippedNoEmail: number };
  // Simulates tenderPrepDb.ts's own re-read-inside-the-transaction refusal — the UI can
  // never construct a payload naming a foreign package on its own (buildApprovePayload
  // always maps over addendum.packages), so this is the only way to exercise what the
  // screen does with that refusal.
  forceApproveConflict?: boolean;
};

function model(page: Page, options: ModelOptions = {}) {
  const addenda = (options.addenda ?? []).map((a) => ({ ...a, packages: a.packages.map((p) => ({ ...p })) }));
  const notifications = (options.notifications ?? []).map((n) => ({ ...n }));
  const approveCalls: Array<{ id: string; body: unknown }> = [];
  const issueCalls: string[] = [];
  const createCalls: Array<{ id: string }> = [];
  const reads: string[][] = [];

  page.route(API_PATTERN, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    let body: unknown;
    try { body = req.postDataJSON(); } catch { body = undefined; }
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

    if (path === `/api/packages/${PACKAGE_ID}/tender-prep`) {
      return json({
        id: WORKFLOW_ID, package_id: PACKAGE_ID, organization_id: 'org-1',
        current_step: options.currentStep ?? 2, step_data: {}, updated_at: '2026-09-10T09:00:00.000Z'
      });
    }
    if (path.endsWith('/itts')) return json([]);

    if (path.endsWith('/api/notifications')) {
      return json({ items: notifications, unread: notifications.filter((n) => n.read_at == null).length });
    }
    if (path.endsWith('/api/notifications/read')) {
      const input = body as { notificationIds: string[] };
      reads.push(input.notificationIds);
      const targets = input.notificationIds.length > 0
        ? new Set(input.notificationIds)
        : new Set(notifications.map((n) => n.id));
      for (const n of notifications) if (targets.has(n.id) && n.read_at == null) n.read_at = '2026-09-10T10:00:00.000Z';
      return json({ marked: 0, unread: notifications.filter((n) => n.read_at == null).length });
    }

    if (path === `/api/tender-prep/${WORKFLOW_ID}/addenda`) {
      if (req.method() === 'GET') return json(addenda);
      if (req.method() === 'POST') {
        const seq = addenda.reduce((max, a) => Math.max(max, a.seq), 0) + 1;
        const id = `a${addenda.length + 1}`;
        createCalls.push({ id });
        const newDelta = delta();
        const full = addendum({
          id, seq, delta: newDelta,
          packages: [
            pkgRow({ addendum_id: id }),
            pkgRow({ addendum_id: id, package_name: 'Unattributed', wp_code: null, unattributed: true, items_added: 0, items_changed: 1 }),
          ]
        });
        addenda.push(full);
        // createAddendum's OWN response shape: camelCase, distinct from listAddenda's
        // snake_case rows (api.ts's ProposedAddendumPackage) — never reuse the GET shape.
        const proposed = newDelta.packages.map((p) => ({
          packageName: p.work_package ?? 'Unattributed', wpCode: p.work_package, unattributed: p.unattributed,
          added: p.added, removed: p.removed, changed: p.changed
        }));
        return json({ ...withoutPackages(full), packages: proposed });
      }
    }

    const approveMatch = /^\/api\/tender-prep\/addenda\/([^/]+)\/approve$/.exec(path);
    if (approveMatch && req.method() === 'POST') {
      const id = approveMatch[1];
      const target = addenda.find((a) => a.id === id);
      if (!target) return json({ message: 'Not found' }, 404);
      const input = body as { packages: Array<{ packageName: string; included: boolean; revisedReturnDeadline: string | null }> };
      approveCalls.push({ id, body: input });

      const knownNames = new Set(target.packages.map((p) => p.package_name));
      const stale = options.forceApproveConflict || !input.packages.every((p) => knownNames.has(p.packageName));
      if (stale) {
        return json({ message: 'Those packages are not part of this addendum — reload and try again.' }, 409);
      }
      for (const edit of input.packages) {
        const row = target.packages.find((p) => p.package_name === edit.packageName);
        if (row) { row.included = edit.included; row.revised_return_deadline = edit.revisedReturnDeadline; }
      }
      target.status = 'approved';
      target.approved_by = 'user-1';
      target.approved_at = '2026-09-11T09:00:00.000Z';
      return json(withoutPackages(target));
    }

    const issueMatch = /^\/api\/tender-prep\/addenda\/([^/]+)\/issue$/.exec(path);
    if (issueMatch && req.method() === 'POST') {
      const id = issueMatch[1];
      const target = addenda.find((a) => a.id === id);
      if (!target) return json({ message: 'Not found' }, 404);
      issueCalls.push(id);
      if (target.status !== 'approved' && target.status !== 'issued') {
        return json({ message: 'This addendum cannot be issued yet.' }, 409);
      }
      target.status = 'issued';
      target.issued_at = target.issued_at ?? '2026-09-12T09:00:00.000Z';
      const result = options.issueResult ?? { sent: 3, failed: 0, skippedNoEmail: 0 };
      return json({ ...withoutPackages(target), ...result, detail: [] });
    }

    return json([]);
  });

  return { addenda, approveCalls, issueCalls, createCalls, reads };
}

// ── Entry points ─────────────────────────────────────────────────────────────

test('a ?addendum= deep link opens the modal directly on that addendum\'s detail view', async ({ page }) => {
  model(page, { addenda: [addendum({ id: 'a1', seq: 3 })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByRole('heading', { name: 'Addendum 3' })).toBeVisible();
  await expect(page.getByText('WP-CONCRETE').first()).toBeVisible();
  // The list table's own "Raised" column never renders — proves this opened straight to
  // the detail view rather than the list.
  await expect(page.getByRole('columnheader', { name: 'Raised' })).toHaveCount(0);
});

test('the Addenda badge counts awaiting-approval addenda', async ({ page }) => {
  model(page, {
    addenda: [
      addendum({ id: 'a1', seq: 1, status: 'awaiting_approval' }),
      addendum({ id: 'a2', seq: 2, status: 'approved' }),
      addendum({ id: 'a3', seq: 3, status: 'awaiting_approval' }),
    ]
  });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep`);
  const button = page.getByRole('button', { name: /^Addenda/ });
  await expect(button.locator('.badge')).toHaveText('2');
});

test('no badge when nothing is awaiting approval', async ({ page }) => {
  model(page, { addenda: [addendum({ id: 'a1', status: 'approved' })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep`);
  const button = page.getByRole('button', { name: /^Addenda/ });
  await expect(button.locator('.badge')).toHaveCount(0);
});

test('clicking the bell\'s addendum notification navigates to the deep link and opens that addendum', async ({ page }) => {
  const { reads } = model(page, {
    addenda: [addendum({ id: 'a1', seq: 5 })],
    notifications: [{
      id: 'n1', kind: 'addendum_approval_required', title: 'An addendum needs your approval', body: null,
      deep_link_path: `/packages/${PACKAGE_ID}/tender-prep?addendum=a1`,
      created_at: '2026-09-10T09:00:00.000Z', thread_id: null, workflow_id: WORKFLOW_ID,
      subcontractor_id: null, read_at: null,
    }],
  });
  await page.goto('/tps/');
  await page.getByRole('button', { name: 'Notifications (1 unread)' }).click();
  await page.getByRole('button', { name: /An addendum needs your approval/ }).click();

  await expect(page).toHaveURL(new RegExp(`/tps/packages/${PACKAGE_ID}/tender-prep\\?addendum=a1$`));
  await expect(page.getByRole('heading', { name: 'Addendum 5' })).toBeVisible();
  // Exactly the one clicked, same convention as notifications.spec.ts.
  await expect.poll(() => reads).toEqual([['n1']]);
});

// ── List view ────────────────────────────────────────────────────────────────

test('an empty addenda list shows the empty-state message and no table', async ({ page }) => {
  model(page, { addenda: [] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep`);
  await page.getByRole('button', { name: /^Addenda/ }).click();

  await expect(page.getByText('No addenda have been raised for this tender yet.')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('each addendum row shows its number, status, raised date and package count, and Open navigates into it', async ({ page }) => {
  model(page, {
    addenda: [
      addendum({ id: 'a1', seq: 1, status: 'awaiting_approval', created_at: '2026-09-10T09:00:00.000Z' }),
      addendum({ id: 'a2', seq: 2, status: 'issued', created_at: '2026-09-11T09:00:00.000Z' }),
    ]
  });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep`);
  await page.getByRole('button', { name: /^Addenda/ }).click();

  const awaitingRow = page.getByRole('row', { name: /awaiting approval/ });
  await expect(awaitingRow.getByRole('cell').nth(0)).toHaveText('1');
  await expect(awaitingRow.getByRole('cell').nth(3)).toHaveText('2');
  await expect(awaitingRow.locator('.badge')).toHaveClass(/badge-amber/);

  const issuedRow = page.getByRole('row', { name: /\bissued\b/ });
  await expect(issuedRow.locator('.badge')).toHaveClass(/badge-green/);

  await awaitingRow.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Addendum 1' })).toBeVisible();
});

test('"Check for a new addendum" creates one and opens its detail view directly', async ({ page }) => {
  const { createCalls } = model(page, { addenda: [] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep`);
  await page.getByRole('button', { name: /^Addenda/ }).click();
  await page.getByRole('button', { name: 'Check for a new addendum' }).click();

  await expect.poll(() => createCalls.length).toBe(1);
  await expect(page.getByRole('heading', { name: 'Addendum 1' })).toBeVisible();
  await expect(page.getByText('No addenda have been raised')).toHaveCount(0);
});

// ── Detail view — the delta ──────────────────────────────────────────────────

test('baseline_resolution "none" renders its own not-compared message, never "nothing changed"', async ({ page }) => {
  model(page, { addenda: [addendum({ delta: delta({
    baseline_resolution: 'none', items_added: 0, items_removed: 0, items_changed: 0, items_unchanged: 0
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText(/Nothing has ever been tendered for this package/)).toBeVisible();
  await expect(page.getByText('Nothing changed against the baseline take-off.')).toHaveCount(0);
});

test('baseline_resolution "unavailable" renders its own not-compared message, never "nothing changed"', async ({ page }) => {
  model(page, { addenda: [addendum({ delta: delta({
    baseline_resolution: 'unavailable', items_added: 0, items_removed: 0, items_changed: 0, items_unchanged: 0
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText('The comparison was not computed for this run.')).toBeVisible();
  await expect(page.getByText('Nothing changed against the baseline take-off.')).toHaveCount(0);
});

test('"nothing changed" renders only when a real comparison found no changes', async ({ page }) => {
  model(page, { addenda: [addendum({ delta: delta({
    items_added: 0, items_removed: 0, items_changed: 0, items_unchanged: 40
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText('Nothing changed against the baseline take-off.')).toBeVisible();
});

test('a rung mix dominated by wording shows the guessing warning', async ({ page }) => {
  model(page, { addenda: [addendum({ delta: delta({
    rung_mix: { clause_ref: 1, component_key: 0, classification: 0, wording: 3 }
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText(/paired on wording alone/)).toBeVisible();
});

test('a rung mix where wording is a minority hides the guessing warning', async ({ page }) => {
  model(page, { addenda: [addendum({ delta: delta({
    rung_mix: { clause_ref: 3, component_key: 0, classification: 0, wording: 1 }
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText(/paired on wording alone/)).toHaveCount(0);
});

test('the unattributed bucket is its own row with a badge, an Include checkbox and a date field', async ({ page }) => {
  model(page, { addenda: [addendum()] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText('unattributed')).toBeVisible();
  await expect(page.getByLabel('Include unattributed')).toBeVisible();
  await expect(page.getByLabel('Revised return date for unattributed')).toBeVisible();
  await expect(page.getByLabel('Include WP-CONCRETE')).toBeVisible();
});

test('conflicts: comparison not made renders its own message', async ({ page }) => {
  model(page, { addenda: [addendum({ delta: delta({
    conflicts: { new: [], recurring: [], resolved: [], available: false }
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText('Conflict comparison was not made for this addendum.')).toBeVisible();
});

test('conflicts: available with nothing to report renders no section at all', async ({ page }) => {
  model(page, { addenda: [addendum({ delta: delta({
    conflicts: { new: [], recurring: [], resolved: [], available: true }
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByRole('heading', { name: 'Conflicts' })).toHaveCount(0);
});

test('conflicts: entries render each count in its own badge', async ({ page }) => {
  const row: ConflictRow = {
    conflict_digest: 'd1', ge_code: 'GE2', conflict_type: 'count_mismatch', severity: 'medium',
    spec_ref: null, drawing_ref: null, detail: null, review_status: null
  };
  model(page, { addenda: [addendum({ delta: delta({
    conflicts: { new: [row], recurring: [row, row], resolved: [], available: true }
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText('1 new')).toBeVisible();
  await expect(page.getByText('2 recurring')).toBeVisible();
  await expect(page.getByText('0 resolved')).toHaveCount(0);
});

test('documents: comparison not made renders its own message', async ({ page }) => {
  model(page, { addenda: [addendum({ delta: delta({
    documents: { added: [], changed: [], removed: [], available: false }
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText('Document comparison was not made for this addendum.')).toBeVisible();
});

test('documents: available with nothing to report renders no section', async ({ page }) => {
  model(page, { addenda: [addendum({ delta: delta({
    documents: { added: [], changed: [], removed: [], available: true }
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByRole('heading', { name: 'Documents' })).toHaveCount(0);
});

test('documents: entries render each count in its own badge', async ({ page }) => {
  const doc: DocumentRow = { display_name: 'Revised M&E layout.pdf', dropbox_file_id: 'f1' };
  model(page, { addenda: [addendum({ delta: delta({
    documents: { added: [doc], changed: [doc, doc], removed: [doc], available: true }
  }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText('1 added')).toBeVisible();
  await expect(page.getByText('2 changed')).toBeVisible();
  await expect(page.getByText('1 removed')).toBeVisible();
});

test('changed lines cover all four change kinds and fall back to the baseline description', async ({ page }) => {
  const changed: ChangedPair[] = [
    {
      rung: 'clause_ref',
      change: { kind: 'unit', before: 'm2', after: 'm', before_quantity: 10, after_quantity: 10 },
      item: itemSummary({ id: 'c1' }), baseline: itemSummary({ id: 'c1' })
    },
    {
      rung: 'component_key',
      change: { kind: 'now_measured', before_quantity: null, after_quantity: 42 },
      item: itemSummary({ id: 'c2', description: null }), baseline: itemSummary({ id: 'c2', description: 'Baseline-only description' })
    },
    {
      rung: 'classification',
      change: { kind: 'no_longer_measured', before_quantity: 30, after_quantity: null },
      item: itemSummary({ id: 'c3' }), baseline: itemSummary({ id: 'c3' })
    },
    {
      rung: 'wording',
      change: { kind: 'quantity', before_quantity: 100, after_quantity: 117.3, delta: 0.173 },
      item: itemSummary({ id: 'c4' }), baseline: itemSummary({ id: 'c4' })
    },
    {
      rung: 'wording',
      change: { kind: 'quantity', before_quantity: 0, after_quantity: 50, delta: null },
      item: itemSummary({ id: 'c5' }), baseline: itemSummary({ id: 'c5' })
    },
  ];
  model(page, { addenda: [addendum({ delta: delta({ delta: { added: [], removed: [], changed } }) })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByText('unit changed: m2 → m')).toBeVisible();
  await expect(page.getByText('now measured — 42')).toBeVisible();
  await expect(page.getByText('Baseline-only description')).toBeVisible();
  await expect(page.getByText('no longer measured — was 30')).toBeVisible();
  await expect(page.getByText('100 → 117.3 (+17.3%)')).toBeVisible();
  await expect(page.getByText('0 → 50', { exact: true })).toBeVisible();

  // wording is the last rung — visually distinguished from the other three.
  await expect(page.getByText('wording', { exact: true }).first()).toHaveClass(/badge-amber/);
  await expect(page.getByText('clause_ref', { exact: true })).toHaveClass(/badge-grey/);
});

// ── Approving (status: awaiting_approval) ────────────────────────────────────

test('un-ticking a package and approving sends every package row, with the un-ticked one carrying no date', async ({ page }) => {
  const { approveCalls } = model(page, { addenda: [addendum()] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await page.getByLabel('Include WP-CONCRETE').uncheck();
  await page.getByRole('button', { name: 'Approve addendum' }).click();

  await expect.poll(() => approveCalls.length).toBe(1);
  expect(approveCalls[0].body).toEqual({
    packages: [
      { packageName: 'WP-CONCRETE', included: false, revisedReturnDeadline: null },
      { packageName: 'Unattributed', included: true, revisedReturnDeadline: null },
    ]
  });
});

test('setting a revised return date on an included package carries it through exactly', async ({ page }) => {
  const { approveCalls } = model(page, { addenda: [addendum()] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await page.getByLabel('Revised return date for WP-CONCRETE').fill('2026-10-15');
  await page.getByRole('button', { name: 'Approve addendum' }).click();

  await expect.poll(() => approveCalls.length).toBe(1);
  const sent = approveCalls[0].body as { packages: Array<{ packageName: string; revisedReturnDeadline: string | null }> };
  expect(sent.packages.find((p) => p.packageName === 'WP-CONCRETE')?.revisedReturnDeadline).toBe('2026-10-15');
});

test('after a successful approve, the screen shows the server\'s new state rather than trusting local edits', async ({ page }) => {
  model(page, { addenda: [addendum()] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await page.getByRole('button', { name: 'Approve addendum' }).click();

  await expect(page.getByText('approved', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Include WP-CONCRETE')).toBeDisabled();
  await expect(page.getByLabel('Revised return date for WP-CONCRETE')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Approve addendum' })).toHaveCount(0);
});

test('the server refusing a stale approve payload surfaces its own message rather than a silent failure', async ({ page }) => {
  const { approveCalls } = model(page, { addenda: [addendum()], forceApproveConflict: true });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await page.getByRole('button', { name: 'Approve addendum' }).click();

  await expect(page.getByText('Those packages are not part of this addendum — reload and try again.')).toBeVisible();
  await expect.poll(() => approveCalls.length).toBe(1);
  // Refused, not silently swallowed: still awaiting approval and still editable.
  await expect(page.getByText('awaiting approval', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve addendum' })).toBeVisible();
});

// ── Read-only once decided ────────────────────────────────────────────────────

test('an approved addendum shows its own recorded ticks and dates, not the original proposal', async ({ page }) => {
  model(page, { addenda: [addendum({
    status: 'approved', approved_at: '2026-09-11T09:00:00.000Z',
    packages: [
      pkgRow({ addendum_id: 'a1', package_name: 'WP-CONCRETE', included: false, revised_return_deadline: null }),
      pkgRow({ addendum_id: 'a1', package_name: 'Unattributed', wp_code: null, unattributed: true, included: true, revised_return_deadline: '2026-11-01' }),
    ],
  })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByLabel('Include WP-CONCRETE')).not.toBeChecked();
  await expect(page.getByLabel('Include WP-CONCRETE')).toBeDisabled();
  await expect(page.getByLabel('Include unattributed')).toBeChecked();
  await expect(page.getByLabel('Revised return date for unattributed')).toHaveValue('2026-11-01');
  await expect(page.getByLabel('Revised return date for unattributed')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Approve addendum' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /issue to subcontractors/i })).toBeVisible();
});

test('a draft addendum offers neither Approve nor Issue', async ({ page }) => {
  model(page, { addenda: [addendum({ status: 'draft' })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByRole('button', { name: 'Approve addendum' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /issue to subcontractors/i })).toHaveCount(0);
});

test('a cancelled addendum offers neither Approve nor Issue', async ({ page }) => {
  model(page, { addenda: [addendum({ status: 'cancelled' })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await expect(page.getByRole('button', { name: 'Approve addendum' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /issue to subcontractors/i })).toHaveCount(0);
});

// ── Issuing ──────────────────────────────────────────────────────────────────

test('issuing renders the sent/failed/skipped summary', async ({ page }) => {
  const { issueCalls } = model(page, {
    addenda: [addendum({ status: 'approved' })],
    issueResult: { sent: 3, failed: 0, skippedNoEmail: 1 }
  });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);
  await page.getByRole('button', { name: 'Issue to subcontractors' }).click();

  await expect.poll(() => issueCalls.length).toBe(1);
  await expect(page.getByText('Sent 3, failed 0, skipped — no email on file 1.')).toBeVisible();
});

test('a partial failure is visible in the issue summary, not swallowed', async ({ page }) => {
  model(page, {
    addenda: [addendum({ status: 'approved' })],
    issueResult: { sent: 2, failed: 1, skippedNoEmail: 0 }
  });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);
  await page.getByRole('button', { name: 'Issue to subcontractors' }).click();

  await expect(page.getByText('Sent 2, failed 1, skipped — no email on file 0.')).toBeVisible();
});

test('an already-issued addendum offers a retry, and clicking it issues again', async ({ page }) => {
  const { issueCalls } = model(page, { addenda: [addendum({ status: 'issued', issued_at: '2026-09-12T09:00:00.000Z' })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  const retryButton = page.getByRole('button', { name: 'Issue again (retries failed sends only)' });
  await expect(retryButton).toBeVisible();
  await retryButton.click();

  await expect.poll(() => issueCalls.length).toBe(1);
});

// ── Modal mechanics ──────────────────────────────────────────────────────────

test('Escape and a backdrop click both close the modal; a click inside it does not', async ({ page }) => {
  model(page, { addenda: [addendum()] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);
  await expect(page.getByRole('heading', { name: 'Addendum 1' })).toBeVisible();

  await page.getByRole('heading', { name: 'Addendum 1' }).click();
  await expect(page.getByRole('heading', { name: 'Addendum 1' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Addendum 1' })).toHaveCount(0);

  await page.getByRole('button', { name: /^Addenda/ }).click();
  await expect(page.getByRole('heading', { name: 'Addendum 1' })).toBeVisible();
  await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole('heading', { name: 'Addendum 1' })).toHaveCount(0);
});

test('"← All addenda" returns to the list, which reflects a change made in the detail view', async ({ page }) => {
  model(page, { addenda: [addendum({ id: 'a1', seq: 1, status: 'awaiting_approval' })] });
  await page.goto(`/tps/packages/${PACKAGE_ID}/tender-prep?addendum=a1`);

  await page.getByRole('button', { name: 'Approve addendum' }).click();
  await expect(page.getByText('approved', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /All addenda/ }).click();
  await expect(page.getByRole('heading', { name: 'Addenda' })).toBeVisible();
  await expect(page.getByRole('row', { name: /approved/ })).toBeVisible();
});
