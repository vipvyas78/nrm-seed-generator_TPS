/**
 * Self-priced work packages (BuildFlow issue #143) — real PostgreSQL, no Redis.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/integration/self-priced.integration.test.ts
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import type { Actor } from '../../src/types.js';
import { testActor } from '../testActor.js';

const { DATABASE_URL } = process.env;

describe('self-priced packages', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  it('invites nobody, refuses every ITT path, and promotes the pricing into a return', async () => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    const tpDb = new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db));
    const organizationId = randomUUID();
    const packageId = randomUUID();
    const actor: Actor = testActor({ userId: randomUUID(), organizationId, subject: 'estimator' });
    const name = `Self ${packageId.slice(0, 8)}`;

    try {
      const workflow = await db.one<{ id: string }>(
        `INSERT INTO workflows (package_id, organization_id) VALUES ($1, $2) RETURNING id`,
        [packageId, organizationId]
      );
      await db.query(
        `INSERT INTO route_options (organization_id, label, sort_order, is_self_priced)
         VALUES ($1, 'Supply and install', 10, FALSE), ($1, 'Self priced', 90, TRUE)`, [organizationId]
      );

      // Firms sent with a self-priced route are dropped, not stored.
      const shortlist = await tpDb.savePackageSelection(actor, workflow.id, {
        packageName: name, routeOfProcurement: 'Self priced',
        entries: [{ subcontractorId: randomUUID(), rank: 1, selected: true }]
      });
      expect(shortlist.is_self_priced).toBe(true);
      const entries = await db.query(`SELECT 1 FROM shortlist_entries WHERE shortlist_id = $1`, [shortlist.id]);
      expect(entries).toHaveLength(0);

      // No ITT path will issue it.
      await expect(tpDb.confirmAndSendItt(actor, workflow.id, name)).rejects.toThrow(/self priced/i);
      await expect(tpDb.draftIttEmail(actor, workflow.id, name)).rejects.toThrow(/self priced/i);

      // Another route on a different package leaves the form unavailable.
      const other = `Other ${packageId.slice(0, 8)}`;
      await tpDb.savePackageSelection(actor, workflow.id, { packageName: other, routeOfProcurement: 'Supply and install', entries: [] });
      await expect(tpDb.getSelfPricing(actor, workflow.id, other)).rejects.toThrow(/not self priced/i);

      // Open the BoQ from a hand-built draft (the ITT assembly needs a take-off).
      await db.query(
        `INSERT INTO self_pricing_drafts (workflow_id, package_name, lines)
         VALUES ($1, $2, $3::jsonb)`,
        [workflow.id, name, JSON.stringify([
          { seq: 1, geCode: 'GE2', elementCode: '2.1', description: 'Frame', quantity: 10, unit: 'm2',
            isPriceable: true, rate: null, status: 'priced', note: null, added: false }
        ])]
      );
      const opened = await tpDb.getSelfPricing(actor, workflow.id, name);
      expect(opened.lines[0].measuredQuantity).toBe(10); // back-filled from the snapshot
      expect(opened.addressed_count).toBe(0);

      // Completing with an unpriced line is refused.
      await expect(tpDb.completeSelfPricing(actor, workflow.id, name)).rejects.toThrow(/no rate/i);

      // Autosave: change the quantity, add an own item.
      const saved = await tpDb.saveSelfPricing(actor, workflow.id, name, {
        version: Number(opened.version), programmeWeeks: 4, qualifications: null, exclusions: null,
        lines: [
          { seq: 1, quantity: 12, unit: 'x', description: 'ignored', rate: 25, status: 'priced', note: null, remarks: null },
          { seq: null, description: 'Extra scaffold', quantity: 1, unit: 'item', rate: 100, status: 'priced', note: null }
        ]
      });
      expect(saved.lines).toHaveLength(2);
      expect(saved.lines[0].description).toBe('Frame');   // a bill line's wording is fixed
      expect(saved.lines[0].unit).toBe('m2');
      expect(saved.lines[1].added).toBe(true);

      // A second tab holding the old version is refused.
      await expect(tpDb.saveSelfPricing(actor, workflow.id, name, {
        version: Number(opened.version), programmeWeeks: null, qualifications: null, exclusions: null, lines: []
      })).rejects.toThrow(/changed elsewhere/i);

      // Changed quantity needs a remark.
      await expect(tpDb.completeSelfPricing(actor, workflow.id, name)).rejects.toThrow(/remark/i);
      const remarked = await tpDb.saveSelfPricing(actor, workflow.id, name, {
        version: Number(saved.version), programmeWeeks: 4, qualifications: null, exclusions: null,
        lines: [
          { seq: 1, quantity: 12, rate: 25, status: 'priced', note: null, remarks: 'Drawing shows 12 m2' },
          { seq: 2, quantity: 1, rate: 100, status: 'priced', note: null }
        ]
      });

      const done = await tpDb.completeSelfPricing(actor, workflow.id, name);
      expect(Number(done.tendered_sum)).toBe(400);
      expect(done.status).toBe('complete');
      expect(done.changed_since_transfer).toBe(false);
      const [ret] = await db.query<{ source: string; subcontractor_id: string | null; tendered_sum: string }>(
        `SELECT source, subcontractor_id, tendered_sum FROM tender_returns WHERE workflow_id = $1 AND package_name = $2`,
        [workflow.id, name]
      );
      expect(ret.source).toBe('self_priced');
      expect(ret.subcontractor_id).toBeNull();

      // Still editable after "save as draft"; the edit shows as changed since transfer.
      const edited = await tpDb.saveSelfPricing(actor, workflow.id, name, {
        version: Number(done.version), programmeWeeks: 4, qualifications: null, exclusions: null,
        lines: [
          { seq: 1, quantity: 12, rate: 30, status: 'priced', note: null, remarks: 'Drawing shows 12 m2' },
          { seq: 2, quantity: 1, rate: 100, status: 'priced', note: null }
        ]
      });
      expect(edited.changed_since_transfer).toBe(true);
      const index = await tpDb.listSelfPricing(actor, workflow.id);
      expect(index.find((p) => p.package_name === name)!.state).toBe('changed_since_transfer');
      void remarked;
    } finally {
      await db.query(`DELETE FROM route_options WHERE organization_id = $1`, [organizationId]);
      await db.query(`DELETE FROM workflows WHERE organization_id = $1`, [organizationId]);
      await db.close();
    }
  });
});
