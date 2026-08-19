import { loadWorkerConfig } from './config.js';
import { BoqReadDatabase } from './boqReadDb.js';
import { Database } from './db.js';
import { startTakeoffCompletionWorker, startTakeoffTenderWorker } from './queues.js';
import { ScmsReadDatabase } from './scmsReadDb.js';
import { TenderPrepDatabase } from './tenderPrepDb.js';

const config = loadWorkerConfig();
const db = new Database(config);
const tpDb = new TenderPrepDatabase(db, new ScmsReadDatabase(db, config.SCMS_SCHEMA), new BoqReadDatabase(db));

// Two queues, one process. They are separate BullMQ workers because the topics are
// independent — a take-off can complete today and be tendered next week, or never — but
// there is no reason to pay for a second container to hear the second half of one contract.
const workers = [
  { name: 'take-off completion', worker: startTakeoffCompletionWorker(config, tpDb) },
  { name: 'take-off tender release', worker: startTakeoffTenderWorker(config, tpDb) }
];

// Without this, a Redis that cannot be reached is retried forever in silence: the process
// stays up, logs nothing, and consumes nothing — which looks identical to an idle queue.
// Throttled because a down Redis emits continuously.
const lastConnectionError = new Map<string, number>();
for (const { name, worker } of workers) {
  worker.on('failed', (job, error) => {
    console.error(`${name} job failed`, job?.id, job?.data, error);
  });
  worker.on('ready', () => console.log(`Listening on ${config.REDIS_URL} for BuildFlow ${name} messages`));
  worker.on('error', (error) => {
    if (Date.now() - (lastConnectionError.get(name) ?? 0) < 30_000) return;
    lastConnectionError.set(name, Date.now());
    console.error(`${name} worker cannot reach Redis at ${config.REDIS_URL}`, error);
  });
}

async function shutdown() {
  await Promise.all(workers.map(({ worker }) => worker.close()));
  await db.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
