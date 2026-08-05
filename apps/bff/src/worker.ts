import { loadWorkerConfig } from './config.js';
import { Database } from './db.js';
import { startTakeoffCompletionWorker } from './queues.js';
import { ScmsReadDatabase } from './scmsReadDb.js';
import { TenderPrepDatabase } from './tenderPrepDb.js';

const config = loadWorkerConfig();
const db = new Database(config);
const tpDb = new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA));
const worker = startTakeoffCompletionWorker(config, tpDb);

worker.on('failed', (job, error) => {
  console.error('Take-off completion job failed', job?.id, job?.data, error);
});
worker.on('ready', () => console.log(`Listening on ${config.REDIS_URL} for BuildFlow take-off completions`));
// Without this, a Redis that cannot be reached is retried forever in silence: the process
// stays up, logs nothing, and consumes nothing — which looks identical to an idle queue.
// Throttled because a down Redis emits continuously.
let lastConnectionError = 0;
worker.on('error', (error) => {
  if (Date.now() - lastConnectionError < 30_000) return;
  lastConnectionError = Date.now();
  console.error(`Take-off completion worker cannot reach Redis at ${config.REDIS_URL}`, error);
});

async function shutdown() {
  await worker.close();
  await db.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
