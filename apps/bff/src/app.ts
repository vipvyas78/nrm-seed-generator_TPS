import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { buildAccessVerifier } from './accessJwt.js';
import { buildAuthenticator, requireActor } from './auth.js';
import type { Config } from './config.js';
import { CloudflareAccessAdmin } from './cloudflareAccess.js';
import { Database } from './db.js';
import { AppError } from './errors.js';
import { BoqReadDatabase } from './boqReadDb.js';
import { BuildflowDocumentBundlesClient } from './buildflowDocumentBundlesClient.js';
import { BuildflowDocumentLinksClient } from './buildflowDocumentLinksClient.js';
import { BuildflowMepBoqClient } from './buildflowMepBoqClient.js';
import { BuildflowSpecClauseClient } from './buildflowSpecClauseClient.js';
import { DropboxDocumentLinkProvider } from './documentLinkProvider.js';
import { EmailService } from './emailService.js';
import { PricingPortalDatabase } from './pricingPortalDb.js';
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
  const buildflowLinks = config.BUILDFLOW_BASE_URL && config.BUILDFLOW_DOCUMENT_LINKS_TOKEN
    ? new BuildflowDocumentLinksClient(config.BUILDFLOW_BASE_URL, config.BUILDFLOW_DOCUMENT_LINKS_TOKEN)
    : undefined;
  const specClauses = config.BUILDFLOW_BASE_URL && config.BUILDFLOW_DOCUMENT_LINKS_TOKEN
    ? new BuildflowSpecClauseClient(config.BUILDFLOW_BASE_URL, config.BUILDFLOW_DOCUMENT_LINKS_TOKEN)
    : undefined;
  // Same base URL and token as the other three BuildFlow reads: one integration, gated
  // on one pair of variables, so a half-configured deployment is not a thing that exists.
  const mepBoq = config.BUILDFLOW_BASE_URL && config.BUILDFLOW_DOCUMENT_LINKS_TOKEN
    ? new BuildflowMepBoqClient(config.BUILDFLOW_BASE_URL, config.BUILDFLOW_DOCUMENT_LINKS_TOKEN)
    : undefined;
  const documentBundles = config.BUILDFLOW_BASE_URL && config.BUILDFLOW_DOCUMENT_LINKS_TOKEN
    ? new BuildflowDocumentBundlesClient(config.BUILDFLOW_BASE_URL, config.BUILDFLOW_DOCUMENT_LINKS_TOKEN)
    : undefined;
  const emailService = config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_EMAIL_TOKEN
    ? new EmailService({ cloudflareAccountId: config.CLOUDFLARE_ACCOUNT_ID, cloudflareApiToken: config.CLOUDFLARE_EMAIL_TOKEN })
    : undefined;
  const testEmailOverride = config.TEST_EMAIL_FLAG
    ? { from: config.TEST_FROM_EMAIL_ACCOUNT!, to: config.TEST_TO_EMAIL_ACCOUNT! }
    : null;

  // The subcontractor pricing portal. portalDb needs only the database; accessAdmin
  // additionally needs a Cloudflare API token — without one, mintPortalLinksFor records
  // every recipient as blocked ('access_unconfigured') and the ITT sends exactly as it
  // did before this feature existed. See config.ts for what each variable gates.
  const portalDb = new PricingPortalDatabase(db);
  // Falls back to WEB_ORIGIN so a portal link and the Cloudflare Access destination it must
  // match (cloudflareAccess.ts's `portalHost`) can never drift apart from each other just
  // because PORTAL_BASE_URL is unset — see tenderPrepDb.ts's use of this same value below.
  const portalBaseUrl = config.PORTAL_BASE_URL ?? config.WEB_ORIGIN[0];
  const accessAdmin = config.CLOUDFLARE_API_TOKEN && config.CLOUDFLARE_ACCOUNT_ID
    ? new CloudflareAccessAdmin(
        db, config.CLOUDFLARE_ACCOUNT_ID, config.CLOUDFLARE_API_TOKEN,
        new URL(portalBaseUrl).host
      )
    : undefined;
  const verifyAccessIdentity = buildAccessVerifier(config, db);

  const tpDb = new TenderPrepDatabase(
    db, scmsDb, boqDb, documentLinks, buildflowLinks, specClauses, documentBundles,
    emailService, testEmailOverride, portalDb, accessAdmin, portalBaseUrl, config.PORTAL_LINK_TTL_DAYS,
    mepBoq
  );

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

  // ── Subcontractor pricing portal: PUBLIC routes, no BuildFlow authentication ────────
  //
  // Declared here, BEFORE the protectedApi.addHook('preHandler', buildAuthenticator(...))
  // block below — the same placement BuildFlow's own /links/:token and /bundles/:token
  // use, for the same reason: a subcontractor is not a BuildFlow user and carries no
  // OIDC bearer token or dev header. What stands in front of these instead is Cloudflare
  // Access at the edge (a policy naming the invited tenders' domains, see
  // cloudflareAccess.ts) PLUS the identity binding verified on every call below — the
  // URL token says WHICH dispatch, the verified Access email says WHO is asking, and
  // `tpDb.resolvePortalToken` (private, exercised only through these routes) requires
  // both to agree. Never trust `Cf-Access-Jwt-Assertion` at face value: nginx forwards
  // /tps-api/ to this process unauthenticated by itself, so the edge policy protects a
  // PATH, and this process is what actually proves who signed the header.
  const portalTokenParams = z.object({ token: z.string().min(1) });
  const portalLineIdParams = portalTokenParams.extend({ lineId: z.string().uuid() });
  const portalLineInput = z.object({
    id: z.string().uuid(),
    quantity: z.number().min(0).nullable(),
    rate: z.number().min(0).nullable(),
    status: z.enum(['priced', 'included', 'excluded', 'not_addressed']),
    note: z.string().trim().max(2000).nullable()
  });

  app.get('/portal/:token', async (request) => {
    const { token } = params(request, portalTokenParams);
    const identity = await verifyAccessIdentity(request);
    return tpDb.getPortalPackage(token, identity?.email ?? null);
  });

  app.put('/portal/:token/draft', async (request) => {
    const { token } = params(request, portalTokenParams);
    const identity = await verifyAccessIdentity(request);
    const input = body(request, z.object({
      programmeWeeks: z.number().int().min(0).nullable().optional(),
      qualifications: z.string().trim().max(4000).nullable().optional(),
      exclusions: z.string().trim().max(4000).nullable().optional(),
      lines: z.array(portalLineInput).max(5000)
    }));
    return tpDb.savePortalDraft(token, identity?.email ?? null, {
      header: {
        programmeWeeks: input.programmeWeeks ?? null,
        qualifications: input.qualifications ?? null,
        exclusions: input.exclusions ?? null
      },
      lines: input.lines
    });
  });

  app.post('/portal/:token/submit', async (request) => {
    const { token } = params(request, portalTokenParams);
    const identity = await verifyAccessIdentity(request);
    return tpDb.submitPortalResponse(token, identity?.email ?? null);
  });

  app.post('/portal/:token/lines', async (request) => {
    const { token } = params(request, portalTokenParams);
    const identity = await verifyAccessIdentity(request);
    const input = body(request, z.object({
      description: z.string().trim().min(1).max(500),
      quantity: z.number().min(0).nullable().optional(),
      unit: z.string().trim().max(50).nullable().optional()
    }));
    return tpDb.addPortalLine(token, identity?.email ?? null, {
      description: input.description, quantity: input.quantity ?? null, unit: input.unit ?? null
    });
  });

  app.delete('/portal/:token/lines/:lineId', async (request) => {
    const { token, lineId } = params(request, portalLineIdParams);
    const identity = await verifyAccessIdentity(request);
    return tpDb.deletePortalLine(token, identity?.email ?? null, lineId);
  });

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

    // Per-tender cover-letter facts nothing else models: site address, deadlines,
    // the estimator. GET pre-fills estimator name/email from the confirming actor's
    // own account when no row has been saved yet.
    protectedApi.get('/api/tender-prep/:workflowId/itt-letter-details', async (request) => {
      const actor = requireActor(request);
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const saved = await tpDb.getIttLetterDetails(actor, workflowId);
      return saved ?? {
        workflow_id: workflowId, site_address: null, tender_return_deadline: null,
        clarifications_close_date: null, site_visit_permitted: null,
        estimator_name: actor.displayName ?? null, estimator_email: actor.email ?? null
      };
    });

    protectedApi.put('/api/tender-prep/:workflowId/itt-letter-details', async (request) => {
      const actor = requireActor(request);
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const input = body(request, z.object({
        siteAddress: z.string().trim().max(500).nullish(),
        tenderReturnDeadline: z.string().trim().max(20).nullish(),
        clarificationsCloseDate: z.string().trim().max(20).nullish(),
        siteVisitPermitted: z.boolean().nullish(),
        estimatorName: z.string().trim().max(200).nullish(),
        estimatorEmail: z.string().trim().max(320).nullish()
      }));
      return tpDb.saveIttLetterDetails(actor, workflowId, input);
    });

    protectedApi.get('/api/tender-prep/config/scope-coverage', async (request) =>
      tpDb.scopeTradeCoverage(requireActor(request)));

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

    // "Ignore for ITT": excludes one line (a return form, BoQ line, authored bill line,
    // scope item or document) from what this package's ITT emails carry, without touching
    // the underlying source data.
    protectedApi.put('/api/tender-prep/:workflowId/itts/:packageName/line-overrides', async (request) => {
      const { workflowId, packageName } = params(request, z.object({ workflowId: uuid, packageName: z.string().trim().min(1).max(200) }));
      const { section, itemId, ignored } = body(request, z.object({
        section: z.enum(['return_form', 'boq_line', 'bill_line', 'scope_item', 'document']),
        itemId: uuid,
        ignored: z.boolean()
      }));
      return tpDb.setIttLineIgnored(requireActor(request), workflowId, { packageName, section, itemId, ignored });
    });

    // "Open draft Email": the exact ITT Confirm ITT would send, previewed in a compose modal so
    // it can be addressed by hand and sent from inside the app. Serves the rendered body, the
    // shortlisted firms' addresses and what the attachments will be.
    protectedApi.get('/api/tender-prep/:workflowId/itts/:packageName/draft', async (request) => {
      const { workflowId, packageName } = params(request, z.object({ workflowId: uuid, packageName: z.string().trim().min(1).max(200) }));
      return tpDb.draftIttEmail(requireActor(request), workflowId, packageName);
    });

    // Sends what that modal is showing. Only the addresses and the subject are accepted — the
    // body and attachments are rebuilt server-side from the same assembly the preview came
    // from, so no scope or return requirement can be edited on its way to a tenderer.
    protectedApi.post('/api/tender-prep/:workflowId/itts/:packageName/draft/send', async (request) => {
      const { workflowId, packageName } = params(request, z.object({ workflowId: uuid, packageName: z.string().trim().min(1).max(200) }));
      const input = body(request, z.object({
        to: z.array(z.string().trim().email('Every recipient must be a valid email address')).min(1).max(50),
        cc: z.array(z.string().trim().email('Every cc must be a valid email address')).max(50).default([]),
        subject: z.string().trim().min(1).max(500)
      }));
      return tpDb.sendIttDraft(requireActor(request), workflowId, packageName, input);
    });

    // Sends the ITT to every subcontractor selected for this package at the tender launch
    // meeting. Re-clicking resends to everyone currently selected.
    protectedApi.post('/api/tender-prep/:workflowId/itts/:packageName/confirm', async (request) => {
      const { workflowId, packageName } = params(request, z.object({ workflowId: uuid, packageName: z.string().trim().min(1).max(200) }));
      return tpDb.confirmAndSendItt(requireActor(request), workflowId, packageName);
    });

    // Sends ONE ITT per subcontractor, covering every confirmed package that firm was
    // shortlisted against, rather than one email per package. Declared before the
    // :packageName route reads as a package named "send-all" — it is a different arity, so
    // there is no conflict, but keeping them adjacent makes that obvious.
    protectedApi.post('/api/tender-prep/:workflowId/itts/send-all', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.sendIttsForWorkflow(requireActor(request), workflowId);
    });

    protectedApi.patch('/api/tender-prep/itt/:dispatchId', async (request) => {
      const { dispatchId } = params(request, z.object({ dispatchId: uuid }));
      const { response } = body(request, z.object({ response: z.enum(['will_tender', 'decline', 'considering', 'no_response']) }));
      return tpDb.recordIttResponse(requireActor(request), dispatchId, response);
    });

    // The "Open responses" modal on the ITT Dispatch page — every firm this package's ITT
    // went to, their portal status, and (below) one firm's priced bill read-only.
    protectedApi.get('/api/tender-prep/:workflowId/portal-responses', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const { packageName } = query(request, z.object({ packageName: z.string().trim().min(1).max(200) }));
      return tpDb.listPortalResponses(requireActor(request), workflowId, packageName);
    });

    protectedApi.get('/api/tender-prep/:workflowId/portal-responses/:linkId', async (request) => {
      const { workflowId, linkId } = params(request, z.object({ workflowId: uuid, linkId: uuid }));
      return tpDb.getPortalResponse(requireActor(request), workflowId, linkId);
    });

    // A buyer's decision, recorded — see reopenPortalResponse's doc comment.
    protectedApi.post('/api/tender-prep/:workflowId/portal-responses/:linkId/reopen', async (request) => {
      const { workflowId, linkId } = params(request, z.object({ workflowId: uuid, linkId: uuid }));
      return tpDb.reopenPortalResponse(requireActor(request), workflowId, linkId);
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
