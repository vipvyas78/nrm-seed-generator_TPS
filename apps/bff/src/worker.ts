import { createServer } from 'node:http';
import { Queue } from 'bullmq';
import { loadWorkerConfig } from './config.js';
import { BoqReadDatabase } from './boqReadDb.js';
import { Database } from './db.js';
import {
  TAKEOFF_COMPLETION_QUEUE, TAKEOFF_TENDER_QUEUE, redisConnection, startTakeoffCompletionWorker, startTakeoffTenderWorker
} from './queues.js';
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

// GET /internal/busy (issue #145) — what the container platform asks before stopping this
// worker for inactivity: a job in flight, or one waiting, keeps it up. Never published;
// only the container's own Durable Object reaches the port, so it says one boolean.
let active = 0;
for (const { worker } of workers) {
  worker.on('active', () => { active += 1; });
  worker.on('completed', () => { active = Math.max(0, active - 1); });
  worker.on('failed', () => { active = Math.max(0, active - 1); });
}
const watched = config.WORKER_HTTP_PORT
  ? [TAKEOFF_COMPLETION_QUEUE, TAKEOFF_TENDER_QUEUE].map((name) => new Queue(name, { connection: redisConnection(config) }))
  : [];
async function busy(): Promise<boolean> {
  if (active > 0) return true;
  const counts = await Promise.all(watched.map((queue) => queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized')));
  return counts.some((count) => Object.values(count).some((n) => n > 0));
}
const server = config.WORKER_HTTP_PORT
  ? createServer((request, response) => {
      const reply = (body: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.method === 'GET' && request.url === '/internal/busy') {
        // Cannot tell, so say busy: stopping a worker mid-job is the expensive mistake.
        busy().then((value) => reply({ busy: value }), (error: unknown) => {
          console.error('Busy check failed', error);
          reply({ busy: true });
        });
        return;
      }
      if (request.method === 'GET' && request.url === '/health') return reply({ status: 'ok' });
      response.writeHead(404).end();
    }).listen(config.WORKER_HTTP_PORT, '0.0.0.0')
  : undefined;

async function shutdown() {
  server?.close();
  await Promise.all(watched.map((queue) => queue.close()));
  await Promise.all(workers.map(({ worker }) => worker.close()));
  await db.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
