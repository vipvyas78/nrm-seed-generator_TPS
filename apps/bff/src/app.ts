import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { buildAuthenticator, requireActor } from './auth.js';
import type { Config } from './config.js';
import { Database } from './db.js';
import { AppError } from './errors.js';
import { ScmsReadDatabase } from './scmsReadDb.js';
import { TenderPrepDatabase } from './tenderPrepDb.js';

const uuid = z.string().uuid();

function body<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return schema.parse(request.body);
}

function query<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return schema.parse(request.query);
}

function params<T extends z.ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return schema.parse(request.params);
}

declare module 'fastify' {
  interface FastifyInstance {
    tps: { config: Config; db: Database; tpDb: TenderPrepDatabase; scmsDb: ScmsReadDatabase };
  }
}

export async function createApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.LOG_LEVEL } });
  const db = new Database(config);
  const scmsDb = new ScmsReadDatabase(db, config.SCMS_SCHEMA);
  const tpDb = new TenderPrepDatabase(db, scmsDb);

  app.decorate('tps', { config, db, tpDb, scmsDb });
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.status(422).send({ error: 'VALIDATION_FAILED', message: error.issues.map((i) => i.message).join('; ') });
    if (error instanceof AppError) return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: 'REQUEST_FAILED', message: error instanceof Error ? error.message : 'Invalid request' });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  });

  app.addHook('onClose', async () => { await db.close(); });
  app.get('/health', async () => ({ status: 'ok', service: 'tps-bff' }));

  await app.register(async (protectedApi) => {
    protectedApi.addHook('preHandler', buildAuthenticator(config, db));

    // ── Workflow lifecycle ──────────────────────────────────────────────────

    protectedApi.post('/api/packages/:packageId/tender-prep', async (request, reply) => {
      const { packageId } = params(request, z.object({ packageId: uuid }));
      return reply.status(201).send(await tpDb.createWorkflow(requireActor(request), packageId));
    });

    // A take-off completing launches a workflow with nobody in the app, so the UI needs
    // to find one it never started. Returns null rather than 404 — "not launched yet" is
    // an ordinary answer here, not an error.
    protectedApi.get('/api/packages/:packageId/tender-prep', async (request) => {
      const { packageId } = params(request, z.object({ packageId: uuid }));
      return tpDb.findWorkflowByPackage(requireActor(request), packageId);
    });

    protectedApi.get('/api/tender-prep/:workflowId', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.getWorkflow(requireActor(request), workflowId);
    });

    protectedApi.post('/api/tender-prep/:workflowId/advance', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.advanceStep(requireActor(request), workflowId);
    });

    // ── Step 1: Shortlist (Tender Launch Pack) ──────────────────────────────

    // Trades a shortlist can be built for, read from SCMS. Static segment, so it takes
    // precedence over GET /api/tender-prep/:workflowId — no route conflict.
    protectedApi.get('/api/tender-prep/trades', async (request) => {
      const { search } = query(request, z.object({ search: z.string().trim().max(120).optional() }));
      return scmsDb.listTradeCategories(requireActor(request), search);
    });

    protectedApi.get('/api/tender-prep/:workflowId/shortlist/candidates', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const { trade, limit } = query(request, z.object({
        trade: z.string().trim().min(1).max(120),
        // A shortlist holds at most 5 (tps.shortlist_entries CHECK rank BETWEEN 1 AND 5),
        // so offer a slightly wider pool to choose from.
        limit: z.coerce.number().int().min(1).max(50).default(10)
      }));
      return tpDb.listShortlistCandidates(requireActor(request), workflowId, trade, limit);
    });

    protectedApi.get('/api/tender-prep/:workflowId/shortlist', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.getShortlists(requireActor(request), workflowId);
    });

    protectedApi.post('/api/tender-prep/:workflowId/shortlist/confirm', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const input = body(request, z.object({
        tradeCategory: z.string().trim().min(1).max(120),
        boardOverrideNotes: z.string().trim().max(2000).optional(),
        entries: z.array(z.object({
          subcontractorId: uuid,
          rank: z.number().int().min(1).max(5),
          performanceScore: z.number().min(0).max(100).optional(),
          complianceFlags: z.record(z.unknown()).optional()
        })).min(1).max(5)
      }));
      return tpDb.confirmShortlist(requireActor(request), workflowId, input);
    });

    // ── Step 2: ITT Dispatch ────────────────────────────────────────────────

    protectedApi.get('/api/tender-prep/:workflowId/itt', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.listIttDispatch(requireActor(request), workflowId);
    });

    protectedApi.post('/api/tender-prep/:workflowId/itt/dispatch', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.dispatchItt(requireActor(request), workflowId);
    });

    protectedApi.patch('/api/tender-prep/itt/:dispatchId', async (request) => {
      const { dispatchId } = params(request, z.object({ dispatchId: uuid }));
      const { response } = body(request, z.object({ response: z.enum(['will_tender', 'decline', 'considering', 'no_response']) }));
      return tpDb.recordIttResponse(requireActor(request), dispatchId, response);
    });

    // ── Step 3: Comparative ─────────────────────────────────────────────────

    protectedApi.get('/api/tender-prep/:workflowId/comparative', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.listComparative(requireActor(request), workflowId);
    });

    protectedApi.post('/api/tender-prep/:workflowId/comparative', async (request, reply) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const input = body(request, z.object({
        tendererName: z.string().trim().min(1).max(240),
        tenderedSum: z.number().min(0).optional(),
        estimateSum: z.number().min(0).optional(),
        scopeCompliance: z.record(z.unknown()).optional(),
        qualifications: z.string().trim().max(4000).optional(),
        recommendation: z.string().trim().max(2000).optional()
      }));
      return reply.status(201).send(await tpDb.upsertComparative(requireActor(request), workflowId, input));
    });

    // ── Step 4: Submission ──────────────────────────────────────────────────

    protectedApi.get('/api/tender-prep/:workflowId/submission', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.getSubmission(requireActor(request), workflowId);
    });

    protectedApi.post('/api/tender-prep/:workflowId/submission', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const input = body(request, z.object({
        packages: z.array(z.record(z.unknown())),
        aggregateTotal: z.number().min(0).optional()
      }));
      return tpDb.saveSubmission(requireActor(request), workflowId, input);
    });

    protectedApi.post('/api/tender-prep/:workflowId/submission/approve', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.boardApproveSubmission(requireActor(request), workflowId);
    });
  });

  return app;
}
