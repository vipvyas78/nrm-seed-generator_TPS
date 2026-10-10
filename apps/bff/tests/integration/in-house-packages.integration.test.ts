/**
 * Packages the estimating team prices in-house are never tendered — real PostgreSQL, no Redis.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/integration/in-house-packages.integration.test.ts
 *
 * BuildFlow issue #96. `work_package_config.is_in_house` (BuildFlow migration 100) names
 * WP-PRELIM-STAFF / -INSURANCES / -PLANT / -RUNNING. Two things are worth proving rather than
 * assuming: the derivation drops them while still taking the other `Manual` prelim packages
 * (`Manual` alone cannot tell them apart), and a shortlist left over from BEFORE the rule
 * still cannot reach an ITT, because the package is only ever identified by name there.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { takeoffTenderedMessage } from '../../src/takeoffCompletion.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import { testActor } from '../testActor.js';

const { DATABASE_URL } = process.env;

const IN_HOUSE = ['WP-PRELIM-STAFF', 'WP-PRELIM-INSURANCES', 'WP-PRELIM-PLANT', 'WP-PRELIM-RUNNING'];

describe('in-house work packages', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const connect = () => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    return { db, tpDb: new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db)) };
  };

  it('is flagged on exactly the four packages, and WP-PRELIM-SETUP is not one of them', async () => {
    const { db } = connect();
    try {
      const rows = await db.query<{ wp_code: string }>(
        `SELECT wp_code FROM public.work_package_config WHERE is_in_house ORDER BY wp_code`);
      expect(rows.map((r) => r.wp_code)).toEqual([...IN_HOUSE].sort());
    } finally {
      await db.close();
    }
  });

  it('derives the other Manual prelim packages but none of the in-house ones', async () => {
    const { db, tpDb } = connect();
    const msg = takeoffTenderedMessage.parse({
      takeoffId: `TOQ-${randomUUID()}`, pipelineSessionId: `session-${randomUUID()}`,
      analysisRunId: randomUUID(), takeoffRunId: null, packageId: randomUUID(),
      organizationId: randomUUID(), requestedBy: randomUUID(), packageName: 'Main Works',
      packageVersionId: randomUUID(), versionNumber: 1, revision: 1, tenderId: randomUUID(),
      tenderName: 'Reading', tenderReference: null, itemCount: 10, tenderScope: 'works',
      // Even a take-off that measured in-house work must not derive a package for it.
      workPackages: [{ wpCode: 'WP-PRELIM-STAFF', itemCount: 35 }],
      tenderedAt: new Date().toISOString()
    });
    try {
      await tpDb.buildPackagesFromTakeoff(
        testActor({ userId: msg.requestedBy, organizationId: msg.organizationId, subject: 'test' }), msg);
      const rows = await db.query<{ wp_code: string }>(
        `SELECT wp_code FROM package_config WHERE project_id = $1 AND is_active`, [msg.tenderId]);
      const codes = rows.map((r) => r.wp_code);
      for (const code of IN_HOUSE) expect(codes).not.toContain(code);
      // Still Manual and still tendered: the reason a flag was needed at all.
      expect(codes).toContain('WP-PRELIM-SETUP');
    } finally {
      await db.query(`DELETE FROM package_config WHERE project_id = $1`, [msg.tenderId]);
      await db.query(`DELETE FROM route_options WHERE organization_id = $1`, [msg.organizationId]);
      await db.close();
    }
  }, 30_000);

  describe('a shortlist left over from before the rule', () => {
    const fixture = async (db: Database) => {
      const organizationId = randomUUID();
      const tenderId = randomUUID();
      const userId = randomUUID();
      const [workflow] = await db.query<{ id: string }>(
        `INSERT INTO workflows (package_id, organization_id, created_by, step_data)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [randomUUID(), organizationId, userId, JSON.stringify({ takeoff: { tenderId } })]);
      const names = { inHouse: `In-house ${randomUUID().slice(0, 8)}`, tendered: `Tendered ${randomUUID().slice(0, 8)}` };
      await db.query(
        `INSERT INTO package_config (organization_id, project_id, seq, name, route_of_procurement, wp_code)
         VALUES ($1,$2,1,$3,'Supply and install','WP-PRELIM-STAFF'),
                ($1,$2,2,$4,'Supply and install','WP-PRELIM-SETUP')`,
        [organizationId, tenderId, names.inHouse, names.tendered]);
      return {
        workflowId: String(workflow.id), tenderId, organizationId, names,
        actor: testActor({ userId, organizationId, subject: 'test' })
      };
    };
    const cleanup = async (db: Database, f: { workflowId: string; tenderId: string; organizationId: string }) => {
      await db.query(`DELETE FROM workflows WHERE id = $1`, [f.workflowId]);
      await db.query(`DELETE FROM package_config WHERE project_id = $1`, [f.tenderId]);
      await db.query(`DELETE FROM route_options WHERE organization_id = $1`, [f.organizationId]);
      await db.close();
    };

    it('cannot be confirmed or confirmed-and-sent, while a tendered prelim package still can', async () => {
      const { db, tpDb } = connect();
      const f = await fixture(db);
      try {
        await expect(tpDb.savePackageSelection(f.actor, f.workflowId, {
          packageName: f.names.inHouse, packageSeq: 1, entries: []
        })).rejects.toThrow(/priced in-house/);
        await expect(tpDb.confirmAndSendItt(f.actor, f.workflowId, f.names.inHouse))
          .rejects.toThrow(/priced in-house/);

        const saved = await tpDb.savePackageSelection(f.actor, f.workflowId, {
          packageName: f.names.tendered, packageSeq: 2, entries: []
        });
        expect(saved.package_name).toBe(f.names.tendered);
      } finally {
        await cleanup(db, f);
      }
    });

    it('is not listed for dispatch and is not sent by send-all', async () => {
      const { db, tpDb } = connect();
      const f = await fixture(db);
      try {
        // A shortlist confirmed before the rule existed, written straight to the table.
        await db.query(
          `INSERT INTO shortlists (workflow_id, package_name, package_seq, route_of_procurement, confirmed_at)
           VALUES ($1,$2,1,'Supply and install',NOW())`, [f.workflowId, f.names.inHouse]);

        const listed = await tpDb.listItts(f.actor, f.workflowId);
        expect(listed.map((r) => r.package_name)).not.toContain(f.names.inHouse);
        await expect(tpDb.sendIttsForWorkflow(f.actor, f.workflowId))
          .rejects.toThrow(/No confirmed packages with selected subcontractors/);
      } finally {
        await cleanup(db, f);
      }
    });
  });
});
