import { Worker, type Job } from 'bullmq';
import type { WorkerConfig } from './config.js';
import { TAKEOFF_COMPLETION_QUEUE, takeoffCompletionMessage, type TakeoffCompletion } from './takeoffCompletion.js';
import type { TenderPrepDatabase } from './tenderPrepDb.js';
import type { Actor } from './types.js';

export { TAKEOFF_COMPLETION_QUEUE };

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
  const actor: Actor = {
    userId: message.requestedBy,
    organizationId: message.organizationId,
    subject: `buildflow-takeoff-${message.takeoffId}`
  };
  await tpDb.launchFromTakeoff(actor, message);
}

export function startTakeoffCompletionWorker(config: WorkerConfig, tpDb: TenderPrepDatabase): Worker {
  return new Worker(
    TAKEOFF_COMPLETION_QUEUE,
    (job) => handleTakeoffCompleted(job, tpDb),
    { connection: redisConnection(config), concurrency: 1 }
  );
}
