import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { buildAccessVerifier } from './accessJwt.js';
import { buildAuthenticator, requireActor } from './auth.js';
import type { Config } from './config.js';
import { CloudflareAccessAdmin } from './cloudflareAccess.js';
import { CommsDatabase } from './commsDb.js';
import {
  decodedAttachmentBytes, idempotencyKeyFor, inboundEmailPayload, verifyInboundSignature
} from './inboundEmail.js';
import { BuildflowCommsAttachmentsClient } from './buildflowCommsAttachmentsClient.js';
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
import { TENDER_RETURN_MAX, TENDER_RETURN_UNITS } from './tenderReturnPeriod.js';

const uuid = z.string().uuid();

/**
 * What a subcontractor may attach to one query, and how big the request carrying it may be.
 *
 * Two numbers rather than one, and they are not the same thing. The REQUEST limit is what
 * Fastify refuses outright, and has to allow for base64's ~33% overhead plus the JSON
 * envelope. The ATTACHMENT limit is measured on the DECODED bytes, which is the figure a
 * person would recognise, and is what the error message talks about — `Buffer.from(…,
 * 'base64')` silently discards anything that is not base64, so the encoded length proves
 * nothing about what actually arrived.
 */
const RFI_ATTACHMENT_BYTE_LIMIT = 8 * 1024 * 1024;
const RFI_REQUEST_BYTE_LIMIT = 12 * 1024 * 1024;

/**
 * The same pair for an inbound email, and the same distinction.
 *
 * 20MB of request allows for base64's ~33% overhead plus the JSON envelope and the raw
 * .eml copy, against ~15MB of message — Cloudflare Email Routing caps a message near
 * 25MB anyway. Fastify's own default is 1MB, which every real email with a drawing
 * attached would exceed, presenting as an opaque 413 on exactly the messages worth
 * keeping.
 */
const INBOUND_ATTACHMENT_BYTE_LIMIT = 15 * 1024 * 1024;
const INBOUND_EMAIL_BYTE_LIMIT = 20 * 1024 * 1024;

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
  // The RFI message store (schema `comms`, migration 022). Unconditional: it needs only
  // the database, exactly as portalDb does.
  const commsDb = new CommsDatabase(db);
  // Gated on the SAME pair as the other four BuildFlow clients, so a half-configured
  // deployment is not a thing that exists. Without it a query can still be raised, just
  // not with a file attached — and that is refused outright rather than silently dropped.
  const commsAttachments = config.BUILDFLOW_BASE_URL && config.BUILDFLOW_DOCUMENT_LINKS_TOKEN
    ? new BuildflowCommsAttachmentsClient(config.BUILDFLOW_BASE_URL, config.BUILDFLOW_DOCUMENT_LINKS_TOKEN)
    : undefined;
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
    mepBoq, commsDb, commsAttachments, config.CLIENT_LINK_TTL_DAYS
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

  // ── Subcontractor queries, raised from the same portal link ────────────────────
  //
  // Same authentication as every route above it — Cloudflare Access at the edge plus the
  // token-to-recipient binding `resolvePortalToken` enforces in this process. Nothing new
  // to configure and nothing new to get wrong.
  //
  // Attachments arrive base64-encoded inside the JSON body rather than as multipart: this
  // BFF registers no multipart parser, and adding one for a single optional file on one
  // route is more surface than the encoding costs. `bodyLimit` is raised for this route
  // ALONE, because Fastify's default is 1MB and a single drawing exceeds it — a limit that
  // would otherwise present as an opaque 413 on exactly the queries worth attaching
  // something to.
  app.post('/portal/:token/rfi', {
    bodyLimit: RFI_REQUEST_BYTE_LIMIT
  }, async (request) => {
    const { token } = params(request, portalTokenParams);
    const identity = await verifyAccessIdentity(request);
    const input = body(request, z.object({
      // Collected, not assumed. The person raising a query is routinely a colleague of
      // the estimator the ITT was addressed to.
      authorName: z.string().trim().min(1).max(200),
      authorEmail: z.string().trim().email().max(320),
      subject: z.string().trim().max(300).nullish(),
      body: z.string().trim().min(1).max(20000),
      attachments: z.array(z.object({
        filename: z.string().trim().min(1).max(400),
        contentBase64: z.string().max(RFI_REQUEST_BYTE_LIMIT)
      })).max(5).default([])
    }));
    const attachments = input.attachments.map((attachment) => ({
      filename: attachment.filename,
      // Buffer.from ignores anything that is not base64 rather than throwing, so the
      // decoded length is checked below instead of trusting the encoded one.
      content: Uint8Array.from(Buffer.from(attachment.contentBase64, 'base64'))
    }));
    const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.content.byteLength, 0);
    if (totalBytes > RFI_ATTACHMENT_BYTE_LIMIT) {
      throw new AppError(413, 'Those files are too large to send here. Email them instead.', 'ATTACHMENTS_TOO_LARGE');
    }
    return tpDb.raisePortalRfi(token, identity?.email ?? null, {
      authorName: input.authorName,
      authorEmail: input.authorEmail,
      subject: input.subject ?? null,
      body: input.body,
      attachments
    });
  });

  // A tenderer's own history: one thread, never a list, and only the one their link
  // belongs to. `null` means they have raised nothing yet, which is an ordinary answer.
  app.get('/portal/:token/thread', async (request) => {
    const { token } = params(request, portalTokenParams);
    const identity = await verifyAccessIdentity(request);
    return tpDb.getPortalThread(token, identity?.email ?? null);
  });

  // ── The Client's reply page: PUBLIC, same shape as the portal above ────────────
  //
  // Declared here for the same reason every /portal route is: the Client is not a
  // BuildFlow user and carries no OIDC bearer. Cloudflare Access gates the path at the
  // edge — which is why forwardQueriesToClient unions the Client addresses into the
  // include list BEFORE the email leaves — and `resolveClientToken` proves in this
  // process that the verified identity matches the link.
  app.get('/client/:token', async (request) => {
    const { token } = params(request, portalTokenParams);
    const identity = await verifyAccessIdentity(request);
    return tpDb.getClientReplyPage(token, identity?.email ?? null);
  });

  app.post('/client/:token', async (request) => {
    const { token } = params(request, portalTokenParams);
    const identity = await verifyAccessIdentity(request);
    const input = body(request, z.object({ body: z.string().trim().min(1).max(20000) }));
    return tpDb.submitClientReply(token, identity?.email ?? null, { body: input.body });
  });

  // ── Inbound email, from the Cloudflare Email Worker ────────────────────────────
  //
  // Registered ONLY when both secrets are set. Unset, this route does not exist at all
  // and the feature is in-app only — which is a far better failure than a route that
  // accepts unauthenticated mail from the internet.
  //
  // THIS IS THE ONE ENDPOINT IN EITHER REPO REACHABLE FROM THE PUBLIC INTERNET. Every
  // other /internal/* route is called over the shared Docker network, so a bearer is
  // enough for them. Here a leaked bearer would let anyone forge the Client's answer to a
  // tender query, so the body is signed as well and the timestamp sits inside the
  // signature. See TPS_INBOUND_EMAIL_API.md.
  if (config.INBOUND_EMAIL_TOKEN && config.INBOUND_EMAIL_SIGNING_SECRET) {
    const inboundToken = config.INBOUND_EMAIL_TOKEN;
    const inboundSecret = config.INBOUND_EMAIL_SIGNING_SECRET;
    await app.register(async (inbound) => {
      // An encapsulated scope so this parser applies to this route ALONE. The signature
      // covers the bytes that arrived, so the raw string has to survive parsing — and
      // making every route in the app keep its raw body to serve one would be a cost
      // paid on every request.
      inbound.addContentTypeParser<string>(
        'application/json', { parseAs: 'string', bodyLimit: INBOUND_EMAIL_BYTE_LIMIT },
        (request, rawBody, done) => {
          (request as FastifyRequest & { rawBody?: string }).rawBody = rawBody;
          try {
            done(null, JSON.parse(rawBody));
          } catch {
            done(new AppError(422, 'Body is not valid JSON', 'VALIDATION_FAILED'));
          }
        }
      );

      inbound.post('/internal/email/inbound', { bodyLimit: INBOUND_EMAIL_BYTE_LIMIT }, async (request, reply) => {
        if (request.headers.authorization !== `Bearer ${inboundToken}`) {
          throw new AppError(401, 'Invalid inbound email token', 'UNAUTHENTICATED');
        }
        const verification = verifyInboundSignature({
          secret: inboundSecret,
          signatureHeader: request.headers['x-tps-signature'] as string | undefined,
          timestampHeader: request.headers['x-tps-timestamp'] as string | undefined,
          rawBody: (request as FastifyRequest & { rawBody?: string }).rawBody ?? ''
        });
        if (!verification.ok) {
          throw new AppError(401, `Signature ${verification.reason}`, 'BAD_SIGNATURE');
        }

        const payload = inboundEmailPayload.parse(request.body);
        if (decodedAttachmentBytes(payload) > INBOUND_ATTACHMENT_BYTE_LIMIT) {
          throw new AppError(413, 'Attachments exceed the inbound limit', 'MESSAGE_TOO_LARGE');
        }
        const key = idempotencyKeyFor(payload, request.headers['idempotency-key'] as string | undefined);

        // 202, and a DUPLICATE is a 200 rather than a 409: a retry from a Worker is
        // ordinary traffic, and a 4xx would make it retry for ever. Anything that failed
        // to persist throws instead, so the Worker retries — never 2xx a message that
        // was not stored.
        const result = await tpDb.ingestInboundEmail(payload, key);
        return reply.status(result.status === 'duplicate' ? 200 : 202).send(result);
      });
    });
  }

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

    // How long a package is tendered for. Nested rather than two flat fields: the pair IS
    // the value, so "a number with no unit" cannot be expressed on the wire at all and the
    // refinement only has to carry the part that genuinely needs it — a bound that depends
    // on a sibling field. Two flat optionals would let { value: 3 } reach Postgres and fail
    // as a raw constraint violation, which is a 500 where this is a 422 naming the rule.
    const tenderReturnPeriod = z.object({
      value: z.number().int(),
      unit: z.enum(TENDER_RETURN_UNITS)
    }).superRefine((period, ctx) => {
      const max = TENDER_RETURN_MAX[period.unit];
      if (period.value < 1 || period.value > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: `A tender return period in ${period.unit} must be between 1 and ${max}. Tenders are returned in 1-5 days or 1-8 weeks.`
        });
      }
    });

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
      // `packageConfigId` narrows the table to one package. Each package costs an SCMS
      // candidate search, so the dashboard's approval modal — which edits exactly one —
      // should not pay for the whole list to open.
      const { perPackage, packageConfigId } = query(request, z.object({
        perPackage: z.coerce.number().int().min(1).max(50).default(10),
        packageConfigId: uuid.optional()
      }));
      return tpDb.getTenderLaunchTable(requireActor(request), workflowId, perPackage, packageConfigId);
    });

    /**
     * The tender dashboard — one row per trade package, for BuildFlow's projects page to
     * link into and for a buyer to work down. Workflow-scoped like every other route here;
     * BuildFlow links with its own package id, which the page resolves to a workflow through
     * the lookup the tender-prep page already uses.
     */
    protectedApi.get('/api/tender-prep/:workflowId/dashboard', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.dashboardRows(requireActor(request), workflowId);
    });

    protectedApi.post('/api/tender-prep/:workflowId/packages/selection', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const input = body(request, z.object({
        packageName: z.string().trim().min(1).max(200),
        packageSeq: z.number().int().positive().optional(),
        routeOfProcurement: routeOfProcurement.optional(),
        boardOverrideNotes: z.string().trim().max(2000).optional(),
        // Null clears the period; omitted leaves it as it is.
        tenderReturnPeriod: tenderReturnPeriod.nullish(),
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

    // ── Subcontractor queries: the buyer's side ─────────────────────────────
    //
    // The "Communications" modal on ITT Dispatch. Listed per tender and opened per
    // thread, because a thread is a conversation with one firm and the list is the set of
    // firms currently talking to us.
    protectedApi.get('/api/tender-prep/:workflowId/threads', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.listCommsThreads(requireActor(request), workflowId);
    });

    // Addressed by thread rather than nested under the workflow: a thread that could not
    // be attributed to a tender at all has no workflow to nest under, and inventing a
    // placeholder one to keep the URL tidy would make the untriaged case unreachable.
    // getCommsThread authorises through the thread's own workflow where it has one.
    protectedApi.get('/api/comms/threads/:threadId', async (request) => {
      const { threadId } = params(request, z.object({ threadId: uuid }));
      return tpDb.getCommsThread(requireActor(request), threadId);
    });

    protectedApi.get('/api/tender-prep/:workflowId/queries', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.listCommsQueries(requireActor(request), workflowId);
    });

    protectedApi.get('/api/tender-prep/:workflowId/client-answers', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.listClientAnswers(requireActor(request), workflowId);
    });

    // What to pre-fill the forward form with: the Client contact this organisation
    // configured in BuildFlow. Overridable on the form — the configured contact is a
    // default, not a rule.
    protectedApi.get('/api/tender-prep/:workflowId/comms-defaults', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      return tpDb.commsDefaults(requireActor(request), workflowId);
    });

    // Several selected queries put to the Client as ONE message. The ids are checked
    // against this tender server-side: assertWorkflowAccess vouches for the workflow, not
    // for a list of message ids a caller supplied.
    protectedApi.post('/api/tender-prep/:workflowId/threads/forward', async (request) => {
      const { workflowId } = params(request, z.object({ workflowId: uuid }));
      const input = body(request, z.object({
        messageIds: z.array(uuid).min(1).max(50),
        clientEmail: z.string().trim().email('The client needs a valid email address').max(320),
        clientName: z.string().trim().max(200).nullish(),
        note: z.string().trim().max(4000).nullish()
      }));
      return tpDb.forwardQueriesToClient(requireActor(request), workflowId, {
        messageIds: input.messageIds,
        clientEmail: input.clientEmail,
        clientName: input.clientName ?? null,
        note: input.note ?? null
      });
    });

    // The Client's answer passed back to the firms that asked. The recipients are derived
    // from comms.forward_items, never chosen by the caller — letting a caller pick would
    // let an answer reach a competitor pricing the same package.
    protectedApi.post('/api/comms/messages/:messageId/relay', async (request) => {
      const { messageId } = params(request, z.object({ messageId: uuid }));
      const input = body(request, z.object({ note: z.string().trim().max(4000).nullish() }));
      return tpDb.relayClientAnswer(requireActor(request), messageId, { note: input.note ?? null });
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
