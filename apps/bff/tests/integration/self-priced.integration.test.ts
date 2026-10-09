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

      // Promote a hand-built draft into a return.
      await db.query(
        `INSERT INTO self_pricing_drafts (workflow_id, package_name, lines)
         VALUES ($1, $2, $3::jsonb)`,
        [workflow.id, name, JSON.stringify([
          { seq: 1, geCode: 'GE2', elementCode: '2.1', description: 'Frame', quantity: 10, unit: 'm2',
            isPriceable: true, rate: null, status: 'priced', note: null, added: false }
        ])]
      );
      // An unpriced priceable line blocks submission.
      await expect(tpDb.submitSelfPricing(actor, workflow.id, name)).rejects.toThrow(/no rate/i);
      await tpDb.saveSelfPricing(actor, workflow.id, name, {
        programmeWeeks: 4, qualifications: null, exclusions: null,
        lines: [{ seq: 1, quantity: 10, rate: 25, status: 'priced', note: null }]
      });
      const done = await tpDb.submitSelfPricing(actor, workflow.id, name);
      expect(Number(done.tendered_sum)).toBe(250);
      const [ret] = await db.query<{ source: string; subcontractor_id: string | null; tendered_sum: string }>(
        `SELECT source, subcontractor_id, tendered_sum FROM tender_returns WHERE workflow_id = $1 AND package_name = $2`,
        [workflow.id, name]
      );
      expect(ret.source).toBe('self_priced');
      expect(ret.subcontractor_id).toBeNull();
      expect(Number(ret.tendered_sum)).toBe(250);
    } finally {
      await db.query(`DELETE FROM route_options WHERE organization_id = $1`, [organizationId]);
      await db.query(`DELETE FROM workflows WHERE organization_id = $1`, [organizationId]);
      await db.close();
    }
  });
});
