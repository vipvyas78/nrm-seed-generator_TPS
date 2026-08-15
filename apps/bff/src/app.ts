import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { buildAuthenticator, requireActor } from './auth.js';
import type { Config } from './config.js';
import { Database } from './db.js';
import { AppError } from './errors.js';
import { BoqReadDatabase } from './boqReadDb.js';
import { DropboxDocumentLinkProvider } from './documentLinkProvider.js';
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
  const boqDb = new BoqReadDatabase(db);
  const documentLinks = config.DROPBOX_ACCESS_TOKEN
    ? new DropboxDocumentLinkProvider(config.DROPBOX_ACCESS_TOKEN)
    : undefined;
  const tpDb = new TenderPrepDatabase(db, scmsDb, boqDb, documentLinks);

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

    // Static segment, so it takes precedence over GET /api/tender-prep/:workflowId —
    // no route conflict, same reasoning as /api/tender-prep/trades below.
    protectedApi.get('/api/tender-prep/workflows', async (request) => {
      return tpDb.listWorkflows(requireActor(request));
    });

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

    // Jump to any step. advance is forward-only, which stranded anyone who needed to go
    // back to the Tender Launch Pack to revise a shortlist.
    protectedApi.post('/api/tender-prep/:workflowId/step', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const { step } = body(request, z.object({ step: z.number().int().min(1).max(4) }));
      return tpDb.setStep(requireActor(request), workflowId, step);
    });

    // ── Step 1: Shortlist (Tender Launch Pack) ──────────────────────────────

    // Trades a shortlist can be built for, read from SCMS. Static segment, so it takes
    // precedence over GET /api/tender-prep/:workflowId — no route conflict.
    protectedApi.get('/api/tender-prep/trades', async (request) => {
      // Authenticated, but not org-filtered: the register is shared reference data.
      requireActor(request);
      const { search } = query(request, z.object({ search: z.string().trim().max(120).optional() }));
      return scmsDb.listTradeCategories(search);
    });

    // ── Project configuration: the client's package breakdown ───────────────
    //
    // Agreed once when the project is set up, not chosen per tender. Static segments, so
    // they take precedence over /api/tender-prep/:workflowId.

    // Free text on purpose: the route is the client's own wording, agreed at project
    // set-up. The first real package list carried eight distinct routes and none of the
    // three originally assumed — see migration 004.
    const routeOfProcurement = z.string().trim().min(1).max(200);

    protectedApi.get('/api/tender-prep/config/packages', async (request) => {
      const { projectId } = query(request, z.object({ projectId: uuid.optional() }));
      return tpDb.listPackageConfig(requireActor(request), projectId ?? null);
    });

    protectedApi.put('/api/tender-prep/config/packages', async (request) => {
      const input = body(request, z.object({
        // Omitted means the organisation-wide default template, inherited by any project
        // without a list of its own.
        projectId: uuid.nullish(),
        packages: z.array(z.object({
          seq: z.number().int().positive(),
          name: z.string().trim().min(1).max(200),
          routeOfProcurement,
          // Empty means the package name is itself the term to match on.
          tradeTerms: z.array(z.string().trim().min(1).max(200)).optional(),
          // NRM attribution for the trade BoQ. When either is set, codes decide which
          // measured lines belong to this package and the description matcher is not used.
          boqGeCodes: z.array(z.string().trim().min(1).max(20)).optional(),
          boqElementPrefixes: z.array(z.string().trim().min(1).max(20)).optional(),
          // Named lines this package claims or disowns whatever their NRM code says, for
          // work the take-off filed under the wrong element. Longer than a code because
          // they are BoQ description phrases.
          boqIncludeTerms: z.array(z.string().trim().min(3).max(200)).max(50).optional(),
          boqExcludeTerms: z.array(z.string().trim().min(3).max(200)).max(50).optional(),
          notes: z.string().trim().max(2000).optional()
        })).max(500)
      }));
      return tpDb.replacePackageConfig(requireActor(request), input.projectId ?? null, input.packages);
    });

    protectedApi.get('/api/tender-prep/config/routes', async (request) => {
      return tpDb.listRouteOptions(requireActor(request));
    });

    // Break a package into sub-packages, e.g. MEP into Mechanical / Electrical / Plumbing.
    protectedApi.post('/api/tender-prep/config/packages/:packageId/split', async (request) => {
      const { packageId } = params(request, z.object({ packageId: uuid }));
      const { children } = body(request, z.object({
        children: z.array(z.object({
          name: z.string().trim().min(1).max(200),
          routeOfProcurement: routeOfProcurement.optional(),
          tradeTerms: z.array(z.string().trim().min(1).max(200)).optional(),
          boqGeCodes: z.array(z.string().trim().min(1).max(20)).optional(),
          boqElementPrefixes: z.array(z.string().trim().min(1).max(20)).optional(),
          boqIncludeTerms: z.array(z.string().trim().min(3).max(200)).max(50).optional(),
          boqExcludeTerms: z.array(z.string().trim().min(3).max(200)).max(50).optional()
        })).min(2).max(20)
      }));
      return tpDb.splitPackage(requireActor(request), packageId, children);
    });

    protectedApi.delete('/api/tender-prep/config/packages/:packageId/split', async (request, reply) => {
      const { packageId } = params(request, z.object({ packageId: uuid }));
      await tpDb.unsplitPackage(requireActor(request), packageId);
      return reply.status(204).send();
    });

    // ITT house standards: what a compliant return contains, and who provides what.
    protectedApi.get('/api/tender-prep/config/return-forms', async (request) =>
      tpDb.listReturnForms(requireActor(request)));

    protectedApi.put('/api/tender-prep/config/return-forms', async (request) => {
      const { forms } = body(request, z.object({
        forms: z.array(z.object({
          seq: z.number().int().positive(),
          name: z.string().trim().min(1).max(200),
          description: z.string().trim().max(1000).optional(),
          isRequired: z.boolean().optional()
        })).max(50)
      }));
      return tpDb.replaceReturnForms(requireActor(request), forms);
    });

    protectedApi.get('/api/tender-prep/config/scope-coverage', async (request) =>
      tpDb.scopeMatrixCoverage(requireActor(request)));

    protectedApi.put('/api/tender-prep/config/scope-items', async (request) => {
      const { items } = body(request, z.object({
        items: z.array(z.object({
          ref: z.number().int(),
          description: z.string().trim().min(1).max(2000),
          procurementStage: z.string().trim().max(60).nullish(),
          designation: z.string().trim().max(60).nullish(),
          packages: z.array(z.string().trim().min(1).max(200))
        })).max(5000)
      }));
      return tpDb.replaceScopeItems(requireActor(request), items);
    });

    protectedApi.get('/api/tender-prep/config/attendances', async (request) =>
      tpDb.listAttendances(requireActor(request), null));

    protectedApi.put('/api/tender-prep/config/attendances', async (request) => {
      const { items } = body(request, z.object({
        items: z.array(z.object({
          group: z.string().trim().min(1).max(120),
          description: z.string().trim().min(1).max(1000),
          owner: z.enum(['SC', 'H', 'J', 'N/A']),
          notes: z.string().trim().max(1000).optional()
        })).max(500)
      }));
      return tpDb.replaceAttendances(requireActor(request), items);
    });

    // Authored bills, for packages a take-off cannot measure: surveys, consultant fees.
    protectedApi.get('/api/tender-prep/config/packages/bill', async (request) => {
      const { packageName } = query(request, z.object({ packageName: z.string().trim().min(1).max(200) }));
      return tpDb.getPackageBill(requireActor(request), packageName);
    });

    protectedApi.put('/api/tender-prep/config/packages/bill', async (request) => {
      const input = body(request, z.object({
        packageName: z.string().trim().min(1).max(200),
        lines: z.array(z.object({
          section: z.string().trim().max(120).optional(),
          ref: z.string().trim().max(40).optional(),
          description: z.string().trim().min(1).max(2000),
          unit: z.string().trim().max(20).optional(),
          quantity: z.number().optional(),
          requiredFor: z.string().trim().max(200).optional(),
          notes: z.string().trim().max(2000).optional()
        })).max(1000)
      }));
      return tpDb.replacePackageBill(requireActor(request), input.packageName, input.lines);
    });

    protectedApi.get('/api/tender-prep/:workflowId/packages/boq', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const { packageName } = query(request, z.object({ packageName: z.string().trim().min(1).max(200) }));
      return tpDb.getPackageBoq(requireActor(request), workflowId, packageName);
    });

    // Measured work no package claims. Worth checking before any ITT is issued.
    protectedApi.get('/api/tender-prep/:workflowId/boq/unattributed', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.getUnattributedBoq(requireActor(request), workflowId);
    });

    protectedApi.get('/api/tender-prep/:workflowId/launch-table', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const { perPackage } = query(request, z.object({
        perPackage: z.coerce.number().int().min(1).max(50).default(10)
      }));
      return tpDb.getTenderLaunchTable(requireActor(request), workflowId, perPackage);
    });

    protectedApi.post('/api/tender-prep/:workflowId/packages/selection', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const input = body(request, z.object({
        packageName: z.string().trim().min(1).max(200),
        packageSeq: z.number().int().positive().optional(),
        routeOfProcurement: routeOfProcurement.optional(),
        boardOverrideNotes: z.string().trim().max(2000).optional(),
        // Everything the meeting saw, not only what it picked — the record has to show
        // who was considered and why, so there is no .min() here and no cap of five.
        entries: z.array(z.object({
          subcontractorId: uuid,
          rank: z.number().int().positive(),
          selected: z.boolean(),
          suggestionReason: z.string().trim().max(1000).optional(),
          performanceScore: z.number().min(0).max(100).optional(),
          complianceFlags: z.record(z.unknown()).optional()
        })).max(200)
      }));
      return tpDb.savePackageSelection(requireActor(request), workflowId, input);
    });

    // ── Step 2: ITT Dispatch ────────────────────────────────────────────────

    // The packages that have an ITT, and the ITT itself. Assembly is server-side so the
    // screen, an export and a future email all render the same pack.
    protectedApi.get('/api/tender-prep/:workflowId/itts', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.listItts(requireActor(request), workflowId);
    });

    protectedApi.get('/api/tender-prep/:workflowId/itt-pack', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const { packageName } = query(request, z.object({ packageName: z.string().trim().min(1).max(200) }));
      return tpDb.getPackageItt(requireActor(request), workflowId, packageName);
    });

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
