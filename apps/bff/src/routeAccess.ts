/**
 * Issue #37's approval axis in TPS.
 *
 * Same mechanism and same reasoning as BuildFlow's `routeAccess.ts`: a map from route
 * template to `read | ordinary | approval`, enforced in one `preHandler`, with an
 * unclassified route REFUSED rather than waved through and a test that fails the build
 * on any route this file does not carry.
 *
 * TPS is where most of the acts that leave the building actually happen. A BuildFlow
 * take-off is an internal document until somebody presses one of these: sending an ITT,
 * approving and issuing an addendum, putting a query to the employer, approving the
 * firm's own submission. Those are the matrix's "Approval level" column, and before this
 * file an L2 could do every one of them.
 */

export type RouteAccess = 'read' | 'ordinary' | 'approval';

export function routeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

export const ROUTE_ACCESS: Record<string, RouteAccess> = {
  // ── the session. Read-only here: BuildFlow owns signing in, signing out and changing
  // a password, because two applications minting sessions against one table would be two
  // password policies and two lockout counters.
  'GET /api/auth/me': 'read',

  // ── workflow lifecycle. Working through the wizard is the tender preparer's job.
  'GET /api/tender-prep/workflows': 'read',
  'POST /api/packages/:packageId/tender-prep': 'ordinary',
  'GET /api/packages/:packageId/tender-prep': 'read',
  'GET /api/tender-prep/:workflowId': 'read',
  'POST /api/tender-prep/:workflowId/advance': 'ordinary',
  'POST /api/tender-prep/:workflowId/step': 'ordinary',
  'GET /api/tender-prep/trades': 'read',

  // ── configuration. Organisation-wide: a package split, a return form or a scope
  // clause edited here changes every tender the firm runs, which is squarely approval
  // work and squarely not one project's business. The same call BuildFlow's config makes.
  'GET /api/tender-prep/config/packages': 'read',
  'PUT /api/tender-prep/config/packages': 'approval',
  'GET /api/tender-prep/config/routes': 'read',
  'POST /api/tender-prep/config/packages/:packageId/split': 'approval',
  'DELETE /api/tender-prep/config/packages/:packageId/split': 'approval',
  'GET /api/tender-prep/config/return-forms': 'read',
  'PUT /api/tender-prep/config/return-forms': 'approval',
  'GET /api/tender-prep/config/scope-coverage': 'read',
  'PUT /api/tender-prep/config/scope-items': 'approval',
  'GET /api/tender-prep/config/attendances': 'read',
  'PUT /api/tender-prep/config/attendances': 'approval',
  'GET /api/tender-prep/config/packages/bill': 'read',
  'PUT /api/tender-prep/config/packages/bill': 'approval',

  // ── the ITT: composing is work, sending is the sign-off
  'GET /api/tender-prep/:workflowId/itt-letter-details': 'read',
  'PUT /api/tender-prep/:workflowId/itt-letter-details': 'ordinary',
  'GET /api/tender-prep/:workflowId/packages/boq': 'read',
  'GET /api/tender-prep/:workflowId/boq/unattributed': 'read',
  'GET /api/tender-prep/:workflowId/launch-table': 'read',
  'GET /api/tender-prep/:workflowId/dashboard': 'read',
  'POST /api/tender-prep/:workflowId/packages/selection': 'ordinary',
  'GET /api/tender-prep/:workflowId/itts': 'read',
  'GET /api/tender-prep/:workflowId/itt-pack': 'read',
  'GET /api/tender-prep/:workflowId/itt': 'read',
  'PUT /api/tender-prep/:workflowId/itts/:packageName/line-overrides': 'ordinary',
  'GET /api/tender-prep/:workflowId/itts/:packageName/draft': 'read',
  // The three that put a tender in front of subcontractors.
  'POST /api/tender-prep/:workflowId/itts/:packageName/draft/send': 'approval',
  'POST /api/tender-prep/:workflowId/itts/:packageName/confirm': 'approval',
  'POST /api/tender-prep/:workflowId/itts/send-all': 'approval',
  // A reminder chases a tender already sent; it commits the firm to nothing new.
  'GET /api/tender-prep/itt/:dispatchId/reminder': 'read',
  'POST /api/tender-prep/itt/:dispatchId/reminder': 'ordinary',
  'GET /api/tender-prep/:workflowId/itt-reminders': 'read',
  'PATCH /api/tender-prep/itt/:dispatchId': 'ordinary',

  // ── responses and comms
  'GET /api/tender-prep/:workflowId/portal-responses': 'read',
  'GET /api/tender-prep/:workflowId/portal-responses/:linkId': 'read',
  'POST /api/tender-prep/:workflowId/portal-responses/:linkId/reopen': 'ordinary',
  'GET /api/tender-prep/:workflowId/threads': 'read',
  'GET /api/comms/threads/:threadId': 'read',
  'GET /api/notifications': 'read',
  'POST /api/notifications/read': 'ordinary',
  'GET /api/comms/timeline': 'read',
  'GET /api/tender-prep/:workflowId/queries': 'read',
  'GET /api/tender-prep/:workflowId/client-answers': 'read',
  'GET /api/tender-prep/:workflowId/comms-defaults': 'read',
  // Both of these send mail outside the firm.
  'POST /api/tender-prep/:workflowId/threads/forward': 'approval',
  'POST /api/comms/messages/:messageId/relay': 'approval',
  // Attributing an unrecognised inbound email to a thread is filing, not sending.
  'POST /api/comms/messages/:messageId/attribute': 'ordinary',

  // ── RFI. Drafting an answer is work; approving it, asking the employer and forwarding
  // are the acts that leave the building.
  'GET /api/tender-prep/:workflowId/rfi': 'read',
  'POST /api/tender-prep/:workflowId/rfi/questions/:questionId/approve': 'approval',
  'POST /api/tender-prep/:workflowId/rfi/questions/:questionId/ask-client': 'approval',
  'POST /api/tender-prep/:workflowId/rfi/questions/:questionId/dismiss': 'ordinary',
  'POST /api/tender-prep/:workflowId/rfi/responses': 'ordinary',
  'POST /api/tender-prep/:workflowId/rfi/client-forward': 'approval',

  // ── addenda. Raising one is work — it is a proposal off a computed delta. Approving
  // and issuing are the decision and the send, and both move a date tenderers already
  // hold.
  'GET /api/tender-prep/:workflowId/addenda': 'read',
  'POST /api/tender-prep/:workflowId/addenda': 'ordinary',
  'POST /api/tender-prep/addenda/:addendumId/approve': 'approval',
  'POST /api/tender-prep/addenda/:addendumId/issue': 'approval',

  // ── comparison and the bid itself
  'GET /api/tender-prep/:workflowId/comparative': 'read',
  'POST /api/tender-prep/:workflowId/comparative': 'ordinary',
  'GET /api/tender-prep/:workflowId/submission': 'read',
  'POST /api/tender-prep/:workflowId/submission': 'ordinary',
  // The firm's own tender to the employer. There is no larger commitment in this app.
  'POST /api/tender-prep/:workflowId/submission/approve': 'approval'
};

/** What this route demands. An unknown route demands approval — see the file header. */
export function accessFor(method: string, url: string | undefined): RouteAccess {
  if (!url) return 'approval';
  return ROUTE_ACCESS[routeKey(method, url)] ?? 'approval';
}

export function unclassifiedRoutes(registered: readonly string[]): string[] {
  return [...new Set(registered.filter((key) => !(key in ROUTE_ACCESS)))].sort();
}

export function orphanedRouteEntries(registered: readonly string[]): string[] {
  const live = new Set(registered);
  return Object.keys(ROUTE_ACCESS).filter((key) => !live.has(key)).sort();
}

/**
 * How to reach a TENDER from a route parameter, for the scope gate.
 *
 * TPS has never had a per-tender check — every query in `tenderPrepDb` is scoped by
 * organisation alone, so an L2 could open, price and issue a tender nobody assigned them
 * to. The gate is a `preHandler` rather than a predicate threaded through four thousand
 * lines of queries, because a preHandler covers every route including the ones nobody
 * has written yet, while a predicate covers the queries somebody remembered.
 *
 * Each entry is a parameter name and one statement resolving it to `bf_tenders.id`.
 * A parameter that resolves to NOTHING is not refused here: the handler's own 404 is a
 * better answer than a 403 about a row that does not exist, and inventing a refusal for
 * a bad id would tell a caller that the id was real.
 *
 * `:linkId`, `:questionId` and `:packageName` are deliberately absent: each is always
 * nested under a `:workflowId` in the same path, so the gate has already resolved the
 * tender from that one.
 *
 * `:messageId` and `:threadId` are NOT here, and not because they cannot be resolved —
 * they reach a tender through `comms.workflow_id` perfectly well. They live in
 * `commsDb.tenderIdForMessage` / `tenderIdForThread` because `commsDb.ts` is the only
 * file in TPS permitted to name a `comms.` table in SQL (commsBoundary.test.ts enforces
 * it, and the reasoning is that the schema's DDL lives in a repository containing no
 * code that reads it, so the blast radius of a breaking change is however many files
 * name it). The gate calls those two after trying this table.
 *
 * That `workflow_id` is NULLABLE, so an organisation-level thread — an email nobody has
 * attributed to a tender yet — resolves to nothing and falls back to the organisation
 * check. Which is right: there is no tender to have been assigned to.
 */
export const TENDER_FROM_PARAM: Record<string, string> = {
  workflowId: `SELECT p.tender_id FROM tps.workflows w
                 JOIN public.bf_takeoff_packages p ON p.id = w.package_id
                WHERE w.id = $1`,
  packageId: `SELECT tender_id FROM public.bf_takeoff_packages WHERE id = $1`,
  addendumId: `SELECT p.tender_id FROM tps.addenda a
                 JOIN tps.workflows w ON w.id = a.workflow_id
                 JOIN public.bf_takeoff_packages p ON p.id = w.package_id
                WHERE a.id = $1`,
  dispatchId: `SELECT p.tender_id FROM tps.itt_dispatch d
                 JOIN tps.shortlist_entries e ON e.id = d.shortlist_entry_id
                 JOIN tps.shortlists s ON s.id = e.shortlist_id
                 JOIN tps.workflows w ON w.id = s.workflow_id
                 JOIN public.bf_takeoff_packages p ON p.id = w.package_id
                WHERE d.id = $1`
};

/**
 * The parameters `commsDb` resolves, named here so the gate, the test and the boundary
 * all read one list. The SQL itself is in commsDb.ts — see TENDER_FROM_PARAM's note.
 */
export const COMMS_TENDER_PARAMS = ['messageId', 'threadId'] as const;

/** Every parameter the scope gate can reach a tender from, wherever the query lives. */
export function resolvableTenderParams(): string[] {
  return [...Object.keys(TENDER_FROM_PARAM), ...COMMS_TENDER_PARAMS];
}

/** Routes whose USE is worth an audit row even though they only read. */
export const AUDITED_READS: ReadonlySet<string> = new Set([
  routeKey('GET', '/api/tender-prep/:workflowId/itt-pack'),
  routeKey('GET', '/api/tender-prep/:workflowId/itts/:packageName/draft'),
  routeKey('GET', '/api/tender-prep/:workflowId/comparative')
]);
