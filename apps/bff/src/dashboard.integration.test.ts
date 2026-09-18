/**
 * The tender dashboard's read — real PostgreSQL, no Redis.
 *
 *   pnpm --filter @tps/bff exec vitest run src/dashboard.integration.test.ts
 *
 * What is worth exercising against a live database is the zip: a firm's answer and its
 * price come from two different tables, keyed by (package, subcontractor), and the failure
 * that matters is silent — a fan-out that reports one firm's price against another's name,
 * or duplicates a row so a package appears to have been sent to four firms when it went to
 * two. Neither shows up as an error anywhere.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoqReadDatabase } from './boqReadDb.js';
import { loadWorkerConfig } from './config.js';
import { Database } from './db.js';
import { ScmsReadDatabase } from './scmsReadDb.js';
import { TenderPrepDatabase } from './tenderPrepDb.js';
import type { Actor } from './types.js';

const { DATABASE_URL } = process.env;

describe('the tender dashboard', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const connect = () => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    return { db, tpDb: new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db)) };
  };

  it('pairs each firm with its own answer and its own price, once', async () => {
    const { db, tpDb } = connect();
    const organizationId = randomUUID();
    const projectId = randomUUID();
    const packageId = randomUUID();
    const actor: Actor = { userId: randomUUID(), organizationId, subject: 'buyer', email: 'buyer@example.test' };
    const accepted = randomUUID();
    const declined = randomUUID();
    const packageName = `Drylining ${packageId.slice(0, 8)}`;

    try {
      const workflow = await db.one<{ id: string }>(
        `INSERT INTO workflows (package_id, organization_id, step_data)
         VALUES ($1, $2, jsonb_build_object('takeoff', jsonb_build_object('projectId', $3::text)))
         RETURNING id`,
        [packageId, organizationId, projectId]
      );
      await db.query(
        `INSERT INTO package_config (organization_id, project_id, seq, name, route_of_procurement)
         VALUES ($1, $2, 1, $3, 'supply_and_install')`,
        [organizationId, projectId, packageName]
      );
      const shortlist = await db.one<{ id: string }>(
        `INSERT INTO shortlists (workflow_id, package_name, package_seq, confirmed_at)
         VALUES ($1, $2, 1, NOW()) RETURNING id`,
        [workflow.id, packageName]
      );
      for (const [rank, subcontractorId] of [accepted, declined].entries()) {
        const entry = await db.one<{ id: string }>(
          `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, selected, suggestion_reason)
           VALUES ($1, $2, $3, TRUE, $4) RETURNING id`,
          [shortlist.id, subcontractorId, rank + 1, `shown to the meeting as rank ${rank + 1}`]
        );
        await db.query(
          `INSERT INTO itt_dispatch (shortlist_entry_id, dispatched_at, response, responded_at)
           VALUES ($1, NOW(), $2, NOW())`,
          [entry.id, subcontractorId === accepted ? 'will_tender' : 'decline']
        );
      }
      await db.query(
        `INSERT INTO tender_returns (workflow_id, package_name, subcontractor_id, tenderer_name, tendered_sum)
         VALUES ($1, $2, $3, 'Accepting firm', 184250.00)`,
        [workflow.id, packageName, accepted]
      );

      const rows = await tpDb.dashboardRows(actor, workflow.id);
      const row = rows.find((candidate) => candidate.package_name === packageName);
      expect(row).toBeTruthy();

      const firms = row!.subcontractors as Array<Record<string, unknown>>;
      // Two entries, two dispatches, one return — and still exactly two rows. A join
      // across all three would have produced more.
      expect(firms).toHaveLength(2);

      const acceptedFirm = firms.find((firm) => firm.subcontractor_id === accepted)!;
      const declinedFirm = firms.find((firm) => firm.subcontractor_id === declined)!;
      expect(acceptedFirm.accepted).toBe(true);
      expect(acceptedFirm.declined).toBe(false);
      expect(Number(acceptedFirm.tendered_sum)).toBe(184250);
      expect(declinedFirm.declined).toBe(true);
      // The price belongs to the firm that quoted it, not to the package.
      expect(declinedFirm.tendered_sum).toBeNull();

      // The reasoning is the wording the meeting was SHOWN, read back off the entry — not
      // recomputed now by searching the register, which is what made this page take 17s.
      expect(acceptedFirm.suggestion_reason).toBe('shown to the meeting as rank 1');
      // These firms are not in the SCMS register, so nothing could describe them — and the
      // row still comes back, carrying the meeting's own record.
      expect(acceptedFirm.off_register).toBe(true);
      expect(acceptedFirm.name).toBe('(no longer in the register)');
    } finally {
      // Reverse FK order; shortlists/entries/dispatches cascade from the workflow.
      await db.query(`DELETE FROM tender_returns WHERE package_name = $1`, [packageName]);
      await db.query(`DELETE FROM workflows WHERE package_id = $1`, [packageId]);
      await db.query(`DELETE FROM package_config WHERE organization_id = $1`, [organizationId]);
      await db.close();
    }
  }, 30_000);

  it('reports a package nobody has been chosen for, rather than dropping it', async () => {
    // A package with no firms is exactly the one the dashboard exists to chase; leaving it
    // out would hide the outstanding work behind an apparently complete table.
    const { db, tpDb } = connect();
    const organizationId = randomUUID();
    const projectId = randomUUID();
    const packageId = randomUUID();
    const actor: Actor = { userId: randomUUID(), organizationId, subject: 'buyer', email: 'buyer@example.test' };
    const packageName = `Roofing ${packageId.slice(0, 8)}`;

    try {
      const workflow = await db.one<{ id: string }>(
        `INSERT INTO workflows (package_id, organization_id, step_data)
         VALUES ($1, $2, jsonb_build_object('takeoff', jsonb_build_object('projectId', $3::text)))
         RETURNING id`,
        [packageId, organizationId, projectId]
      );
      await db.query(
        `INSERT INTO package_config (organization_id, project_id, seq, name, route_of_procurement)
         VALUES ($1, $2, 1, $3, 'supply_and_install')`,
        [organizationId, projectId, packageName]
      );

      const rows = await tpDb.dashboardRows(actor, workflow.id);
      const row = rows.find((candidate) => candidate.package_name === packageName);
      expect(row).toBeTruthy();
      expect(row!.confirmed_at).toBeNull();
      expect(row!.subcontractors).toHaveLength(0);

      // Confirmed, but the only entry is the placeholder — "no firm in the register carries
      // this trade". It is not a firm anybody picked, so it must not be reported as one.
      const shortlist = await db.one<{ id: string }>(
        `INSERT INTO shortlists (workflow_id, package_name, package_seq, confirmed_at)
         VALUES ($1, $2, 1, NOW()) RETURNING id`, [workflow.id, packageName]);
      await db.query(
        `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, selected)
         VALUES ($1, '00000000-0000-0000-0000-000000000000'::uuid, 1, FALSE)`, [shortlist.id]);

      const afterConfirm = (await tpDb.dashboardRows(actor, workflow.id))
        .find((candidate) => candidate.package_name === packageName)!;
      expect(afterConfirm.confirmed_at).toBeTruthy();
      expect(afterConfirm.subcontractors).toHaveLength(0);
    } finally {
      await db.query(`DELETE FROM workflows WHERE package_id = $1`, [packageId]);
      await db.query(`DELETE FROM package_config WHERE organization_id = $1`, [organizationId]);
      await db.close();
    }
  }, 30_000);
});
