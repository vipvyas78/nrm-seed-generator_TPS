/**
 * The per-package tender return period, and the date it resolves to — real PostgreSQL.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/integration/tender-return-deadline.integration.test.ts
 *
 * The rule worth testing is not "the column stores a number". It is that a date, ONCE
 * ISSUED, never moves: a resend, a re-confirmation of the shortlist at the Tender Launch
 * Pack step, or a later edit of the period must all leave it alone, because a tenderer is
 * already working to the date in the letter they hold. That invariant lives in two places —
 * the WHERE clause of stampTenderReturnDeadlines, and the deliberate ABSENCE of the column
 * from savePackageSelection's upsert — and the second is invisible, so it is tested.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import { testActor } from '../testActor.js';

const { DATABASE_URL } = process.env;

describe('the tender return period', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const connect = () => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    return { db, tpDb: new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db)) };
  };

  /** A workflow and one configured package for it, which is all a shortlist needs. */
  const fixture = async (db: Database) => {
    const organizationId = randomUUID();
    const tenderId = randomUUID();
    const packageId = randomUUID();
    const userId = randomUUID();
    const packageName = `Return period test ${randomUUID().slice(0, 8)}`;

    const [workflow] = await db.query<{ id: string }>(
      `INSERT INTO workflows (package_id, organization_id, created_by, step_data)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [packageId, organizationId, userId, JSON.stringify({ takeoff: { tenderId } })]
    );
    await db.query(
      `INSERT INTO package_config (organization_id, project_id, seq, name, route_of_procurement)
       VALUES ($1,$2,1,$3,'Supply and install')`,
      [organizationId, tenderId, packageName]
    );
    return {
      workflowId: String(workflow.id), packageName, tenderId, organizationId,
      actor: testActor({ userId, organizationId, subject: 'test' })
    };
  };

  const cleanup = async (db: Database, f: { workflowId: string; tenderId: string; organizationId: string }) => {
    await db.query(`DELETE FROM workflows WHERE id = $1`, [f.workflowId]); // cascades to shortlists
    await db.query(`DELETE FROM package_config WHERE project_id = $1`, [f.tenderId]);
    await db.query(`DELETE FROM route_options WHERE organization_id = $1`, [f.organizationId]);
    await db.close();
  };

  const deadlineOf = async (db: Database, workflowId: string) => {
    const [row] = await db.query<{ d: string | null }>(
      `SELECT to_char(tender_return_deadline, 'YYYY-MM-DD') AS d FROM shortlists WHERE workflow_id = $1`,
      [workflowId]
    );
    return row?.d ?? null;
  };

  it('saves the period with the shortlist, and issues no date by doing so', async () => {
    const { db, tpDb } = connect();
    const f = await fixture(db);
    try {
      await tpDb.savePackageSelection(f.actor, f.workflowId, {
        packageName: f.packageName, packageSeq: 1, tenderReturnPeriod: { value: 3, unit: 'weeks' }, entries: []
      });

      const [row] = await db.query<{ v: number; u: string }>(
        `SELECT tender_return_period_value AS v, tender_return_period_unit AS u
           FROM shortlists WHERE workflow_id = $1`, [f.workflowId]
      );
      expect(row.v).toBe(3);
      expect(row.u).toBe('weeks');
      // Confirming a shortlist is not issuing an ITT. The date is stamped at dispatch.
      expect(await deadlineOf(db, f.workflowId)).toBeNull();
    } finally {
      await cleanup(db, f);
    }
  });

  it('never moves a date once it has been issued', async () => {
    const { db, tpDb } = connect();
    const f = await fixture(db);
    try {
      await tpDb.savePackageSelection(f.actor, f.workflowId, {
        packageName: f.packageName, packageSeq: 1, tenderReturnPeriod: { value: 3, unit: 'weeks' }, entries: []
      });

      await tpDb.stampTenderReturnDeadlines(f.workflowId, [{ packageName: f.packageName, date: '2026-01-10' }]);
      expect(await deadlineOf(db, f.workflowId)).toBe('2026-01-10');

      // A resend, a month later. The letters already out say 10 January.
      await tpDb.stampTenderReturnDeadlines(f.workflowId, [{ packageName: f.packageName, date: '2026-02-10' }]);
      expect(await deadlineOf(db, f.workflowId)).toBe('2026-01-10');

      // And re-confirming the package at Step 1, with a different period. This is the one
      // that catches someone later adding tender_return_deadline to the upsert's DO UPDATE.
      await tpDb.savePackageSelection(f.actor, f.workflowId, {
        packageName: f.packageName, packageSeq: 1, tenderReturnPeriod: { value: 5, unit: 'days' }, entries: []
      });
      expect(await deadlineOf(db, f.workflowId)).toBe('2026-01-10');
      const [row] = await db.query<{ v: number; u: string }>(
        `SELECT tender_return_period_value AS v, tender_return_period_unit AS u
           FROM shortlists WHERE workflow_id = $1`, [f.workflowId]
      );
      // The DECISION is editable; only the issued date is not.
      expect([row.v, row.u]).toEqual([5, 'days']);
    } finally {
      await cleanup(db, f);
    }
  });

  it('clears the period when it is set to null, still without touching the issued date', async () => {
    const { db, tpDb } = connect();
    const f = await fixture(db);
    try {
      await tpDb.savePackageSelection(f.actor, f.workflowId, {
        packageName: f.packageName, packageSeq: 1, tenderReturnPeriod: { value: 2, unit: 'weeks' }, entries: []
      });
      await tpDb.stampTenderReturnDeadlines(f.workflowId, [{ packageName: f.packageName, date: '2026-03-02' }]);

      await tpDb.savePackageSelection(f.actor, f.workflowId, {
        packageName: f.packageName, packageSeq: 1, tenderReturnPeriod: null, entries: []
      });
      const [row] = await db.query<{ v: number | null; u: string | null }>(
        `SELECT tender_return_period_value AS v, tender_return_period_unit AS u
           FROM shortlists WHERE workflow_id = $1`, [f.workflowId]
      );
      expect(row.v).toBeNull();
      expect(row.u).toBeNull();
      expect(await deadlineOf(db, f.workflowId)).toBe('2026-03-02');
    } finally {
      await cleanup(db, f);
    }
  });

  it('reports the period and the issued date on the launch table, and nulls where nothing was decided', async () => {
    const { db, tpDb } = connect();
    const f = await fixture(db);
    try {
      const before = await tpDb.getTenderLaunchTable(f.actor, f.workflowId, 5);
      const unconfirmed = before.find((r) => r.package_name === f.packageName);
      expect(unconfirmed?.tender_return_period_value).toBeNull();
      expect(unconfirmed?.tender_return_period_unit).toBeNull();
      expect(unconfirmed?.tender_return_deadline).toBeNull();

      await tpDb.savePackageSelection(f.actor, f.workflowId, {
        packageName: f.packageName, packageSeq: 1, tenderReturnPeriod: { value: 4, unit: 'weeks' }, entries: []
      });
      await tpDb.stampTenderReturnDeadlines(f.workflowId, [{ packageName: f.packageName, date: '2026-04-16' }]);

      const after = await tpDb.getTenderLaunchTable(f.actor, f.workflowId, 5);
      const row = after.find((r) => r.package_name === f.packageName);
      expect(row?.tender_return_period_value).toBe(4);
      expect(row?.tender_return_period_unit).toBe('weeks');
      // Formatted in SQL, never a raw DATE: the BFF installs no pg type parser, and a raw
      // DATE serialises to the PREVIOUS day under a positive UTC offset.
      expect(row?.tender_return_deadline).toBe('16/04/2026');
    } finally {
      await cleanup(db, f);
    }
    // This one reads the whole launch table, which runs an SCMS candidate search per
    // package — seconds of real work against a real register, where its siblings write a
    // row or two. On the default 5s budget it passed only while it had the database to
    // itself; 30s is what every other integration suite here allows.
  }, 30_000);

  it('refuses an out-of-range or half-stated period at the database, not only in the API', async () => {
    const { db, tpDb } = connect();
    const f = await fixture(db);
    try {
      await tpDb.savePackageSelection(f.actor, f.workflowId, {
        packageName: f.packageName, packageSeq: 1, tenderReturnPeriod: { value: 1, unit: 'days' }, entries: []
      });
      const set = (value: number | null, unit: string | null) => db.query(
        `UPDATE shortlists SET tender_return_period_value = $2, tender_return_period_unit = $3
          WHERE workflow_id = $1`, [f.workflowId, value, unit]
      );

      await expect(set(6, 'days')).rejects.toThrow();    // 5 is the most days allowed
      await expect(set(9, 'weeks')).rejects.toThrow();   // 8 is the most weeks allowed
      await expect(set(0, 'weeks')).rejects.toThrow();
      await expect(set(3, null)).rejects.toThrow();      // a number with no unit
      await expect(set(null, 'weeks')).rejects.toThrow(); // a unit with no number
      await expect(set(4, 'fortnights')).rejects.toThrow();

      // Both null together is how "not decided" is expressed, and must still be accepted.
      await expect(set(null, null)).resolves.toBeDefined();
    } finally {
      await cleanup(db, f);
    }
  });
});
