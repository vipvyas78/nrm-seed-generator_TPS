/**
 * Step 2 ITT Dispatch's package list — real PostgreSQL, no Redis.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/integration/itt-dispatch.integration.test.ts
 *
 * `listItts` used to end `HAVING count(*) FILTER (WHERE se.selected) > 0`, which dropped a
 * confirmed package with nobody to invite — no row, no warning, nothing anywhere to explain the
 * gap. Reading had eight confirmed packages and Step 2 showed six. The failure is silent by
 * construction, so it needs a test that asserts the row is PRESENT, which no amount of checking
 * the rows that do appear would have caught.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import type { Actor } from '../../src/types.js';

const { DATABASE_URL } = process.env;
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

describe('the Step 2 package list', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const connect = () => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    return { db, tpDb: new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db)) };
  };

  it('lists every confirmed package, and says which have nobody to invite', async () => {
    const { db, tpDb } = connect();
    const organizationId = randomUUID();
    const packageId = randomUUID();
    const actor: Actor = { userId: randomUUID(), organizationId, subject: 'buyer' };
    const suffix = packageId.slice(0, 8);
    const invited = `Invited ${suffix}`;
    const notPicked = `NotPicked ${suffix}`;
    const noFirms = `NoFirms ${suffix}`;

    try {
      const workflow = await db.one<{ id: string }>(
        `INSERT INTO workflows (package_id, organization_id) VALUES ($1, $2) RETURNING id`,
        [packageId, organizationId]
      );
      const shortlist = async (name: string, seq: number) => (await db.one<{ id: string }>(
        `INSERT INTO shortlists (workflow_id, package_name, package_seq, confirmed_at)
         VALUES ($1, $2, $3, NOW()) RETURNING id`, [workflow.id, name, seq]
      )).id;

      // Three packages, all confirmed, differing only in who is on them.
      const a = await shortlist(invited, 1);
      await db.query(
        `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, selected)
         VALUES ($1, $2, 1, TRUE)`, [a, randomUUID()]);

      const b = await shortlist(notPicked, 2);
      await db.query(
        `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, selected)
         VALUES ($1, $2, 1, FALSE), ($1, $3, 2, FALSE)`, [b, randomUUID(), randomUUID()]);

      const c = await shortlist(noFirms, 3);
      await db.query(
        `INSERT INTO shortlist_entries (shortlist_id, subcontractor_id, rank, selected)
         VALUES ($1, $2::uuid, 1, FALSE)`, [c, PLACEHOLDER]);

      const rows = await tpDb.listItts(actor, workflow.id);
      const by = (name: string) => rows.find((row) => row.package_name === name);

      // All three, where the old HAVING returned one.
      expect(rows).toHaveLength(3);

      expect(Number(by(invited)!.recipients)).toBe(1);
      expect(Number(by(invited)!.candidates)).toBe(1);

      // Firms were offered and none was picked — reopen the package and choose.
      expect(Number(by(notPicked)!.recipients)).toBe(0);
      expect(Number(by(notPicked)!.candidates)).toBe(2);

      // Nothing was ever offered: the placeholder is the register saying "nobody here", so it
      // must not be counted as a firm somebody declined to pick. The two states need different
      // answers, and `candidates` is the only thing that tells them apart.
      expect(Number(by(noFirms)!.recipients)).toBe(0);
      expect(Number(by(noFirms)!.candidates)).toBe(0);
    } finally {
      await db.query(`DELETE FROM workflows WHERE package_id = $1`, [packageId]);
      await db.close();
    }
  }, 30_000);
});
