import { Worker, type Job } from 'bullmq';
import type { WorkerConfig } from './config.js';
import {
  TAKEOFF_COMPLETION_QUEUE, TAKEOFF_TENDER_QUEUE,
  takeoffCompletionMessage, takeoffTenderedMessage,
  type TakeoffCompletion, type TakeoffTendered
} from './takeoffCompletion.js';
import type { TenderPrepDatabase } from './tenderPrepDb.js';
import { systemActor, type Actor } from './types.js';

export { TAKEOFF_COMPLETION_QUEUE, TAKEOFF_TENDER_QUEUE };

/** Same reasoning as handleTakeoffCompleted's: the actor is provenance, built from the message. */
function actorFor(message: { requestedBy: string; organizationId: string; takeoffId: string }): Actor {
  return systemActor({
    userId: message.requestedBy,
    organizationId: message.organizationId,
    subject: `buildflow-takeoff-${message.takeoffId}`
  });
}

/**
 * Mirrors BuildFlow's own redisConnection(). Both sides leave BullMQ's key prefix at its
 * default (`bull`) and Redis at db 0, which is what makes producer and consumer meet.
 */
function redisConnection(config: WorkerConfig) {
  const url = new URL(config.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    maxRetriesPerRequest: null
  };
}

/**
 * A take-off completed in BuildFlow — launch tender preparation for its package.
 *
 * The actor is built from the message rather than a request, so this never touches the
 * HTTP authenticator: TPS has no service-to-service auth path, and inventing one to call
 * our own route from our own process would be theatre. `subject` is provenance only —
 * launchFromTakeoff reads userId and organizationId, both of which are the parent's own
 * bf_users / bf_organizations ids and so are already provisioned.
 */
export async function handleTakeoffCompleted(
  job: Pick<Job, 'data'>, tpDb: TenderPrepDatabase
): Promise<void> {
  const message: TakeoffCompletion = takeoffCompletionMessage.parse(job.data);
  const actor: Actor = systemActor({
    userId: message.requestedBy,
    organizationId: message.organizationId,
    subject: `buildflow-takeoff-${message.takeoffId}`
  });
  await tpDb.launchFromTakeoff(actor, message);
}

export function startTakeoffCompletionWorker(config: WorkerConfig, tpDb: TenderPrepDatabase): Worker {
  return new Worker(
    TAKEOFF_COMPLETION_QUEUE,
    (job) => handleTakeoffCompleted(job, tpDb),
    { connection: redisConnection(config), concurrency: 1 }
  );
}

/**
 * A reviewed take-off has been released to tender — build this project's package list from
 * the work packages it resolved, the project's scope, and the NRM1 work-package config.
 *
 * The workflow itself is not created here. `takeoff.completed` already did that, and doing
 * it again would race the two consumers; if the completion message was somehow lost, the
 * packages still land and the lookup route will pick the workflow up when it appears.
 */
export async function handleTakeoffTendered(
  job: Pick<Job, 'data'>, tpDb: TenderPrepDatabase
): Promise<void> {
  const message: TakeoffTendered = takeoffTenderedMessage.parse(job.data);
  await tpDb.buildPackagesFromTakeoff(actorFor(message), message);
}

export function startTakeoffTenderWorker(config: WorkerConfig, tpDb: TenderPrepDatabase): Worker {
  return new Worker(
    TAKEOFF_TENDER_QUEUE,
    (job) => handleTakeoffTendered(job, tpDb),
    { connection: redisConnection(config), concurrency: 1 }
  );
}
