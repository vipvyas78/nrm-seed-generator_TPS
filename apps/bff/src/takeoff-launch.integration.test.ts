/**
 * Launching tender preparation from a BuildFlow take-off — real PostgreSQL, no Redis.
 *
 *   pnpm --filter @tps/bff exec vitest run src/takeoff-launch.integration.test.ts
 *
 * The queue hop is BullMQ's problem. What is ours is the handler: it must land the
 * workflow on Tender Launch Pack, survive redelivery, and never rewind someone who has
 * already moved on.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';
import { Database } from './db.js';
import { handleTakeoffCompleted } from './queues.js';
import { ScmsReadDatabase } from './scmsReadDb.js';
import { takeoffCompletionMessage, type TakeoffCompletion } from './takeoffCompletion.js';
import { TenderPrepDatabase } from './tenderPrepDb.js';

const { DATABASE_URL } = process.env;

function message(overrides: Partial<TakeoffCompletion> = {}): TakeoffCompletion {
  return {
    takeoffId: `TOQ-${randomUUID()}`,
    pipelineSessionId: `session-${randomUUID()}`,
    source: 'analysis',
    analysisRunId: randomUUID(),
    takeoffRunId: null,
    packageId: randomUUID(),
    organizationId: randomUUID(),
    requestedBy: randomUUID(),
    projectId: randomUUID(),
    projectName: 'Reading Phase 2',
    packageName: 'Internal Finishes',
    packageVersionId: randomUUID(),
    versionNumber: 3,
    revision: 2,
    tenderId: randomUUID(),
    tenderName: 'Reading Phase 2 Main Works',
    tenderReference: 'RDG-002',
    itemCount: 412,
    gifaM2: 4210.5,
    completedAt: new Date().toISOString(),
    ...overrides
  };
}

describe('takeoffCompletionMessage', () => {
  it('accepts a package with no tender', () => {
    // bf_takeoff_packages.tender_id is nullable, so the producer emits an explicit null.
    const parsed = takeoffCompletionMessage.parse(
      message({ tenderId: null, tenderName: null, tenderReference: null }));
    expect(parsed.tenderId).toBeNull();
    expect(parsed.packageId).toBeTruthy();
  });

  it('ignores fields BuildFlow adds later', () => {
    // Unknown keys must not reject, or the two repos need a lockstep deploy.
    const parsed = takeoffCompletionMessage.parse({ ...message(), somethingNew: 'value' });
    expect(parsed.takeoffId).toBeTruthy();
  });

  it('refuses a message with no package to launch', () => {
    const { packageId: _dropped, ...withoutPackage } = message();
    expect(() => takeoffCompletionMessage.parse(withoutPackage)).toThrow();
  });
});

describe('launching from a take-off', () => {
  if (!DATABASE_URL) {
    it.skip('skipped - DATABASE_URL not set', () => {});
    return;
  }

  const connect = () => {
    const config = loadWorkerConfig({ ...process.env, REDIS_URL: 'redis://unused:6379' });
    const db = new Database(config);
    return { db, tpDb: new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA)) };
  };

  it('creates the workflow on Tender Launch Pack and keeps the take-off detail', async () => {
    const { db, tpDb } = connect();
    const msg = message();
    try {
      await handleTakeoffCompleted({ data: msg }, tpDb);

      const workflow = await db.one<{ current_step: number; created_by: string; step_data: Record<string, unknown> }>(
        `SELECT * FROM workflows WHERE package_id = $1`, [msg.packageId]);
      // Step 1 IS Tender Launch Pack now — the consumer never writes current_step, it
      // just takes the column default.
      expect(workflow.current_step).toBe(1);
      expect(workflow.created_by).toBe(msg.requestedBy);
      const takeoff = (workflow.step_data as { takeoff: TakeoffCompletion }).takeoff;
      expect(takeoff.takeoffId).toBe(msg.takeoffId);
      expect(takeoff.tenderReference).toBe('RDG-002');
      expect(takeoff.itemCount).toBe(412);
    } finally {
      await db.query(`DELETE FROM workflows WHERE package_id = $1`, [msg.packageId]);
      await db.close();
    }
  }, 30_000);

  it('is a no-op on redelivery', async () => {
    const { db, tpDb } = connect();
    const msg = message();
    try {
      await handleTakeoffCompleted({ data: msg }, tpDb);
      await handleTakeoffCompleted({ data: msg }, tpDb);

      const rows = await db.query(`SELECT id FROM workflows WHERE package_id = $1`, [msg.packageId]);
      expect(rows).toHaveLength(1);
    } finally {
      await db.query(`DELETE FROM workflows WHERE package_id = $1`, [msg.packageId]);
      await db.close();
    }
  }, 30_000);

  it('refreshes the take-off detail without rewinding a workflow already in progress', async () => {
    // A take-off re-run must not drag a buyer who has reached ITT Dispatch back to the
    // first step. The data updates; the position does not.
    const { db, tpDb } = connect();
    const first = message();
    try {
      await handleTakeoffCompleted({ data: first }, tpDb);
      await db.query(`UPDATE workflows SET current_step = 3 WHERE package_id = $1`, [first.packageId]);

      const rerun = message({
        packageId: first.packageId, organizationId: first.organizationId,
        requestedBy: first.requestedBy, itemCount: 590
      });
      await handleTakeoffCompleted({ data: rerun }, tpDb);

      const workflow = await db.one<{ current_step: number; step_data: Record<string, unknown> }>(
        `SELECT * FROM workflows WHERE package_id = $1`, [first.packageId]);
      expect(workflow.current_step).toBe(3);
      const takeoff = (workflow.step_data as { takeoff: TakeoffCompletion }).takeoff;
      expect(takeoff.takeoffId).toBe(rerun.takeoffId);
      expect(takeoff.itemCount).toBe(590);
    } finally {
      await db.query(`DELETE FROM workflows WHERE package_id = $1`, [first.packageId]);
      await db.close();
    }
  }, 30_000);

  it('refuses to write another organization\'s take-off into an existing workflow', async () => {
    const { db, tpDb } = connect();
    const first = message();
    try {
      await handleTakeoffCompleted({ data: first }, tpDb);
      const intruder = message({ packageId: first.packageId });
      await expect(handleTakeoffCompleted({ data: intruder }, tpDb)).rejects.toThrow();

      const workflow = await db.one<{ organization_id: string; step_data: Record<string, unknown> }>(
        `SELECT * FROM workflows WHERE package_id = $1`, [first.packageId]);
      expect(workflow.organization_id).toBe(first.organizationId);
      expect((workflow.step_data as { takeoff: TakeoffCompletion }).takeoff.takeoffId).toBe(first.takeoffId);
    } finally {
      await db.query(`DELETE FROM workflows WHERE package_id = $1`, [first.packageId]);
      await db.close();
    }
  }, 30_000);
});
