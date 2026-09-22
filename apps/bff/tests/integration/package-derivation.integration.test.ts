/**
 * Deriving the package list from a released take-off — real PostgreSQL, no Redis.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/integration/package-derivation.integration.test.ts
 *
 * The rule under test is four-valued and the interesting cases are the exclusions: a `TOQ`
 * package the take-off did not measure must not appear, and a `D&B` one must appear only on
 * a design-and-build appointment. The parent's real nrm_sub_element_work_package and
 * work_package_config rows are used rather than fixtures — they are seeded reference data,
 * and a rule tested against invented codes would not tell us the rule works.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../../src/config.js';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { Database } from '../../src/db.js';
import { handleTakeoffTendered } from '../../src/queues.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { takeoffTenderedMessage, type TakeoffTendered } from '../../src/takeoffCompletion.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';

const { DATABASE_URL } = process.env;

function message(overrides: Partial<TakeoffTendered> = {}): TakeoffTendered {
  return takeoffTenderedMessage.parse({
    takeoffId: `TOQ-${randomUUID()}`,
    pipelineSessionId: `session-${randomUUID()}`,
    analysisRunId: randomUUID(),
    takeoffRunId: null,
    packageId: randomUUID(),
    organizationId: randomUUID(),
    requestedBy: randomUUID(),
    projectId: randomUUID(),
    projectName: 'Reading',
    packageName: 'Main Works',
    packageVersionId: randomUUID(),
    versionNumber: 1,
    revision: 1,
    tenderId: null,
    tenderName: null,
    tenderReference: null,
    itemCount: 525,
    projectScope: 'works',
    workPackages: [{ wpCode: 'WP-DRYLINE', itemCount: 14 }],
    tenderedAt: new Date().toISOString(),
    ...overrides
  });
}

describe('the tendered message', () => {
  it('defaults workPackages to empty rather than rejecting', () => {
    // A take-off where nothing resolved a package is a real outcome, and must still be
    // able to build the All/Manual half of the list.
    const parsed = takeoffTenderedMessage.parse({
      ...message(), workPackages: undefined
    });
    expect(parsed.workPackages).toEqual([]);
  });

  it('accepts a null project scope', () => {
    expect(takeoffTenderedMessage.parse({ ...message(), projectScope: null }).projectScope).toBeNull();
  });

  it('still ignores fields BuildFlow adds later', () => {
    expect(takeoffTenderedMessage.parse({ ...message(), somethingNew: 1 }).takeoffId).toBeTruthy();
  });
});

describe('deriving a project package list', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const connect = () => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    return { db, tpDb: new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db)) };
  };

  const cleanup = async (db: Database, msg: TakeoffTendered) => {
    await db.query(`DELETE FROM package_config WHERE project_id = $1`, [msg.projectId]);
    await db.query(`DELETE FROM route_options WHERE organization_id = $1`, [msg.organizationId]);
    await db.close();
  };

  it('selects All, Manual and the measured TOQ packages, and no unmeasured TOQ package', async () => {
    const { db, tpDb } = connect();
    const msg = message({ workPackages: [{ wpCode: 'WP-DRYLINE', itemCount: 14 }] });
    try {
      const result = await tpDb.buildPackagesFromTakeoff(
        { userId: msg.requestedBy, organizationId: msg.organizationId, subject: 'test' }, msg);

      expect(result.selected).toBeGreaterThan(0);
      expect(result.byCondition.All).toBeGreaterThan(0);
      expect(result.byCondition.Manual).toBeGreaterThan(0);
      // projectScope is 'works', so no D&B package may be selected.
      expect(result.byCondition['D&B']).toBeUndefined();

      const rows = await db.query<{ wp_code: string; wp_scope_condition: string; name: string; trade_terms: string[] }>(
        `SELECT wp_code, wp_scope_condition, name, trade_terms FROM package_config
          WHERE project_id = $1 AND is_active`, [msg.projectId]);
      const byCode = new Map(rows.map((row) => [row.wp_code, row]));

      // Measured, and its condition is TOQ — in, and named from the vocabulary.
      expect(byCode.get('WP-DRYLINE')?.name).toBe('Dry lining & partitions');
      // The label is the trade term, which is what keeps the SCMS shortlist working
      // without a second vocabulary to maintain.
      expect(byCode.get('WP-DRYLINE')?.trade_terms).toEqual(['Dry lining & partitions']);

      // Every TOQ row present must be one the take-off measured. This is the exclusion the
      // whole rule exists for, and asserting it over the set catches a rule that quietly
      // widened rather than only the one code we happened to name.
      for (const row of rows) {
        if (row.wp_scope_condition === 'TOQ') expect(row.wp_code).toBe('WP-DRYLINE');
      }
    } finally {
      await cleanup(db, msg);
    }
  }, 30_000);

  it('admits the D&B package only on a design-and-build appointment', async () => {
    const { db, tpDb } = connect();
    const works = message({ projectScope: 'works' });
    const dnb = message({ projectScope: 'design_and_build', projectId: works.projectId, organizationId: works.organizationId });
    const actor = { userId: works.requestedBy, organizationId: works.organizationId, subject: 'test' };
    try {
      const first = await tpDb.buildPackagesFromTakeoff(actor, works);
      expect(first.byCondition['D&B']).toBeUndefined();

      const second = await tpDb.buildPackagesFromTakeoff(actor, dnb);
      expect(second.byCondition['D&B']).toBe(1);
      expect(second.selected).toBe(first.selected + 1);

      const [row] = await db.query<{ route_of_procurement: string }>(
        `SELECT route_of_procurement FROM package_config
          WHERE project_id = $1 AND wp_scope_condition = 'D&B'`, [dnb.projectId]);
      expect(row.route_of_procurement).toBe('Design, Supply and install');
    } finally {
      await cleanup(db, works);
    }
  }, 30_000);

  it('deactivates a package that falls out of scope instead of deleting it', async () => {
    // package_bill_lines and attendance_items cascade off package_config.id. A delete here
    // is how 890 lines of authored survey schedule were lost once already.
    const { db, tpDb } = connect();
    const dnb = message({ projectScope: 'design_and_build' });
    const works = message({ projectScope: 'works', projectId: dnb.projectId, organizationId: dnb.organizationId });
    const actor = { userId: dnb.requestedBy, organizationId: dnb.organizationId, subject: 'test' };
    try {
      await tpDb.buildPackagesFromTakeoff(actor, dnb);
      const [dnbRow] = await db.query<{ id: string }>(
        `SELECT id FROM package_config WHERE project_id = $1 AND wp_scope_condition = 'D&B'`, [dnb.projectId]);
      expect(dnbRow).toBeTruthy();

      const result = await tpDb.buildPackagesFromTakeoff(actor, works);
      expect(result.deactivated).toBe(1);

      const [after] = await db.query<{ is_active: boolean }>(
        `SELECT is_active FROM package_config WHERE id = $1`, [dnbRow.id]);
      expect(after).toBeTruthy();          // the row survives
      expect(after.is_active).toBe(false); // it is merely out of scope
    } finally {
      await cleanup(db, works);
    }
  }, 30_000);

  it('a rebuild keeps the route a reviewer chose', async () => {
    const { db, tpDb } = connect();
    const msg = message();
    const actor = { userId: msg.requestedBy, organizationId: msg.organizationId, subject: 'test' };
    try {
      await tpDb.buildPackagesFromTakeoff(actor, msg);
      await db.query(
        `UPDATE package_config SET route_of_procurement = 'Full scope to completion'
          WHERE project_id = $1 AND wp_code = 'WP-DRYLINE'`, [msg.projectId]);

      await tpDb.buildPackagesFromTakeoff(actor, message({
        projectId: msg.projectId, organizationId: msg.organizationId
      }));

      const [row] = await db.query<{ route_of_procurement: string }>(
        `SELECT route_of_procurement FROM package_config WHERE project_id = $1 AND wp_code = 'WP-DRYLINE'`,
        [msg.projectId]);
      // route_of_procurement is deliberately absent from the DO UPDATE set: the derivation
      // proposes a route, it does not overrule the person who tendered the package.
      expect(row.route_of_procurement).toBe('Full scope to completion');
    } finally {
      await cleanup(db, msg);
    }
  }, 30_000);

  it('is idempotent — redelivery rebuilds the same list, one row per code', async () => {
    const { db, tpDb } = connect();
    const msg = message();
    try {
      await handleTakeoffTendered({ data: msg }, tpDb);
      const first = await db.query(`SELECT wp_code FROM package_config WHERE project_id = $1`, [msg.projectId]);
      await handleTakeoffTendered({ data: msg }, tpDb);
      const second = await db.query(`SELECT wp_code FROM package_config WHERE project_id = $1`, [msg.projectId]);
      expect(second).toHaveLength(first.length);
    } finally {
      await cleanup(db, msg);
    }
  }, 30_000);

  it('leaves the organisation-wide hand-loaded list alone', async () => {
    // listPackageConfig prefers project rows and falls back to the org default. A project
    // that has never been tendered must keep behaving exactly as it does today.
    const { db, tpDb } = connect();
    const msg = message();
    const before = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM package_config WHERE project_id IS NULL`);
    try {
      await tpDb.buildPackagesFromTakeoff(
        { userId: msg.requestedBy, organizationId: msg.organizationId, subject: 'test' }, msg);
      const after = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM package_config WHERE project_id IS NULL`);
      expect(after[0].n).toBe(before[0].n);
    } finally {
      await cleanup(db, msg);
    }
  }, 30_000);
});
