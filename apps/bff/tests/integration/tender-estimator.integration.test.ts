/**
 * The default ITT signatory, read from BuildFlow's renamed estimators table (issue #13).
 *
 *   DATABASE_URL=postgresql://buildflow:buildflow@localhost:5433/buildflow \
 *     pnpm --filter @tps/bff exec vitest run tests/integration/tender-estimator.integration.test.ts
 *
 * This is the ONE cross-schema read BuildFlow's Project -> Tender rename actually broke
 * (parent migration 091: bf_project_estimators.project_id -> bf_tender_estimators.tender_id),
 * and until this file it had no test at all — which is why the break could only have been
 * found by sending an ITT. Migration 091 left a compatibility view at the old name purely to
 * hold it up; this test is what lets that view be dropped (parent issue #55).
 *
 * The join is two-sided and both sides moved: the TABLE and column on BuildFlow's side, and
 * the `step_data.takeoff` KEY on ours. A test that only seeded the table would still pass
 * against a query reading the old payload key, so every case here goes through the payload.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { BoqReadDatabase } from '../../src/boqReadDb.js';
import { loadWorkerConfig } from '../../src/config.js';
import { Database } from '../../src/db.js';
import { ScmsReadDatabase } from '../../src/scmsReadDb.js';
import { TenderPrepDatabase } from '../../src/tenderPrepDb.js';
import type { Actor } from '../../src/types.js';

const { DATABASE_URL } = process.env;

describe('the default tender estimator', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
  const db = new Database(config);
  const tpDb = new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db));

  const created: { organizationId: string[]; tenderId: string[]; workflowId: string[]; userId: string[] } = {
    organizationId: [], tenderId: [], workflowId: [], userId: []
  };

  afterAll(async () => {
    if (created.workflowId.length) {
      await db.query(`DELETE FROM tps.itt_letter_details WHERE workflow_id = ANY($1::uuid[])`, [created.workflowId]);
      await db.query(`DELETE FROM tps.workflows WHERE id = ANY($1::uuid[])`, [created.workflowId]);
    }
    if (created.tenderId.length) {
      await db.query(`DELETE FROM public.bf_tender_estimators WHERE tender_id = ANY($1::uuid[])`, [created.tenderId]);
      await db.query(`DELETE FROM public.bf_tenders WHERE id = ANY($1::uuid[])`, [created.tenderId]);
    }
    if (created.organizationId.length) {
      await db.query(`DELETE FROM public.bf_organization_memberships WHERE organization_id = ANY($1::uuid[])`, [created.organizationId]);
      await db.query(`DELETE FROM public.bf_organizations WHERE id = ANY($1::uuid[])`, [created.organizationId]);
    }
    if (created.userId.length) await db.query(`DELETE FROM public.bf_users WHERE id = ANY($1::uuid[])`, [created.userId]);
    await db.close();
  });

  /** An organisation, a tender with two named estimators, and a workflow whose stored
   *  take-off payload points at that tender under the CURRENT key spelling. */
  async function seed(options: { estimators?: Array<{ name: string; email: string; seq: number }>; tenderKey?: string } = {}) {
    const { estimators = [
      { name: 'Priya Shah', email: 'priya@novamerx.test', seq: 1 },
      { name: 'Sam Colleague', email: 'sam@novamerx.test', seq: 2 }
    ], tenderKey = 'tenderId' } = options;

    const suffix = randomUUID();
    const organizationId = randomUUID();
    const userId = randomUUID();
    await db.query(`INSERT INTO public.bf_organizations (id, oidc_issuer, external_id, name) VALUES ($1,'test',$2,'Estimator Test Org')`,
      [organizationId, `ext-${suffix}`]);
    created.organizationId.push(organizationId);
    await db.query(`INSERT INTO public.bf_users (id, oidc_issuer, oidc_subject, email) VALUES ($1,'test',$2,$3)`,
      [userId, `sub-${suffix}`, `actor+${suffix}@novamerx.test`]);
    created.userId.push(userId);
    await db.query(`INSERT INTO public.bf_organization_memberships (organization_id, user_id) VALUES ($1,$2)`, [organizationId, userId]);

    const tenderId = randomUUID();
    await db.query(`INSERT INTO public.bf_tenders (id, organization_id, name, reference, created_by) VALUES ($1,$2,'Reading Gateway','RDG-002',$3)`,
      [tenderId, organizationId, userId]);
    created.tenderId.push(tenderId);
    for (const e of estimators) {
      await db.query(`INSERT INTO public.bf_tender_estimators (tender_id, name, email, seq) VALUES ($1,$2,$3,$4)`,
        [tenderId, e.name, e.email, e.seq]);
    }

    const workflowId = randomUUID();
    await db.query(
      `INSERT INTO tps.workflows (id, package_id, organization_id, created_by, step_data)
       VALUES ($1, $2, $3, $4, jsonb_build_object('takeoff', jsonb_build_object($5::text, $6::text)))`,
      [workflowId, randomUUID(), organizationId, userId, tenderKey, tenderId]
    );
    created.workflowId.push(workflowId);

    const actor: Actor = {
      userId, organizationId, subject: `sub-${suffix}`, email: `actor+${suffix}@novamerx.test`,
      displayName: 'Acting Estimator'
    } as Actor;
    return { actor, workflowId, tenderId };
  }

  it('signs an ITT as the tender’s seq=1 estimator, not the person clicking send', async () => {
    // The whole point of the middle rung: a tender names its estimators once, and every
    // package under it defaults to that name without anyone re-typing it.
    const { actor, workflowId } = await seed();
    const context = await tpDb.letterContextFor(actor, workflowId);
    expect(context.estimatorName).toBe('Priya Shah');
    expect(context.estimatorEmail).toBe('priya@novamerx.test');
  }, 30_000);

  it('falls back to the acting user when the tender names nobody', async () => {
    const { actor, workflowId } = await seed({ estimators: [] });
    const context = await tpDb.letterContextFor(actor, workflowId);
    expect(context.estimatorName).toBe('Acting Estimator');
    expect(context.estimatorEmail).toBe(actor.email);
  }, 30_000);

  it('reads the tenderId key, not the legacy projectId one', async () => {
    // A workflow launched before BuildFlow issue #53 carries only `projectId`, and that id
    // named the VESTIGIAL tender row migration 091 dropped -- so it resolves to nothing.
    // Falling back to it would join a dangling id and quietly sign the letter as whoever
    // happened to press send. Resolving to no estimator is the honest answer.
    const { actor, workflowId } = await seed({ tenderKey: 'projectId' });
    const context = await tpDb.letterContextFor(actor, workflowId);
    expect(context.estimatorName).toBe('Acting Estimator');
  }, 30_000);
});
