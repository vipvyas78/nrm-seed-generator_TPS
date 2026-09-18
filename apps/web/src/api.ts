import { accessToken } from './auth';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * What BuildFlow sends when a take-off completes, stashed on the workflow by the queue
 * consumer. Present only on a workflow launched from a take-off — a workflow started by
 * hand in this app has none.
 */
export type TakeoffCompletion = {
  takeoffId: string;
  pipelineSessionId?: string | null;
  packageId: string;
  packageName?: string | null;
  packageVersionId?: string | null;
  versionNumber?: number | null;
  revision?: number | null;
  projectId?: string | null;
  projectName?: string | null;
  tenderId: string | null;
  tenderName: string | null;
  tenderReference: string | null;
  itemCount?: number | null;
  gifaM2?: number | string | null;
  completedAt?: string | null;
};

export type TenderPrepWorkflow = {
  id: string;
  package_id: string;
  organization_id: string;
  current_step: number;
  step_data: { takeoff?: TakeoffCompletion; takeoffReceivedAt?: string } & Record<string, unknown>;
  locked_at?: string;
  created_at: string;
  updated_at: string;
};

/**
 * The client's own wording, configured per project — not a fixed set. The first real
 * package list used eight distinct routes ("Full scope including cart away", "Design
 * (connection only), supply and install", …), so this is deliberately not a union.
 */
export type RouteOfProcurement = string;

/** One line of the client's agreed package breakdown, fixed at project configuration. */
export type PackageConfig = {
  id: string;
  seq: number;
  name: string;
  route_of_procurement: RouteOfProcurement;
  trade_terms: string[];
  notes?: string | null;
};

/** One row of the Tender Launch table: a package, its route, and its suggested firms. */
export type LaunchTableRow = {
  package_config_id: string;
  seq: number;
  sub_seq: number | null;
  /** "42" for a package, "42.2" for a breakdown of it. */
  display_ref: string;
  /** Broken down into sub-packages: not tendered itself, its children are. */
  is_heading: boolean;
  is_sub_package: boolean;
  package_name: string;
  /** What the client's package list specifies, before any choice made at launch. */
  configured_route: RouteOfProcurement;
  /** The route in force — the launch choice where one was made, else the configured one. */
  route_of_procurement: RouteOfProcurement;
  route_options: string[];
  trade_terms: string[];
  /** Authored bill lines stranded on a heading — nobody has been asked to price them. */
  stranded_bill_lines: number;
  /** Set when the row was derived from a released take-off rather than hand-loaded. */
  wp_code?: string | null;
  /** Why this package is in the list: All | TOQ | D&B | Manual. */
  wp_scope_condition?: string | null;
  derived_from_takeoff?: string | null;
  notes?: string | null;
  confirmed_at: string | null;
  board_override_notes: string | null;
  /** How long this package is tendered for: 1-5 days or 1-8 weeks. Null when undecided. */
  tender_return_period_value: number | null;
  tender_return_period_unit: TenderReturnUnit | null;
  /** The return date actually issued for this package, dd/mm/yyyy. Null until an ITT goes
   *  out; never recomputed on a read, so it cannot drift from the letter a tenderer holds. */
  tender_return_deadline: string | null;
  subcontractors: LaunchCandidate[];
};

/** Weeks are calendar weeks; days are WORKING days, so five days is a working week.
 *  Mirrors apps/bff/src/tenderReturnPeriod.ts and the CHECK in migration 021 — the two
 *  are separate packages, so the limits are restated rather than imported. The server
 *  refuses anything out of range whatever this says; this is only what the user is told. */
export type TenderReturnUnit = 'days' | 'weeks';
export const TENDER_RETURN_MAX: Record<TenderReturnUnit, number> = { days: 5, weeks: 8 };

/** One line of the ITT index: a package with an ITT ready to view. */
export type IttSummary = {
  package_name: string;
  package_seq: number | null;
  route_of_procurement: string;
  confirmed_at: string | null;
  recipients: number;
  dispatched: number;
  sent: number;
  failed: number;
  skipped_no_email: number;
  /** A buyer's manual "will_tender" mark — see recordIttResponse. Not the same fact as
   * responses_received below, which is a SUBMITTED priced bill. */
  responded: number;
  /** Submitted returns via the online pricing portal — drives "response received" and
   * the "Open responses" button. */
  responses_received: number;
  portal_links: number;
  /** A viewer's Access identity did not match the link it was issued to, at least once —
   * worth a warning on the row rather than sitting unseen in the database. */
  portal_denials: number;
};

export type IttBoqLine = {
  id: string;
  ge_code: string | null;
  element_code: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
  is_priceable: boolean;
  ignored: boolean;
};

export type IttLineSection = 'return_form' | 'boq_line' | 'bill_line' | 'scope_item' | 'document';

/** The assembled Invitation to Tender for one package. Rates are deliberately absent. */
export type IttPack = {
  package_name: string;
  display_ref: string;
  route_of_procurement: string;
  takeoff: Record<string, unknown>;
  boq_id: string | null;
  confirmed_at: string | null;
  recipients: Array<{ shortlist_entry_id: string; subcontractor_id: string; rank: number; suggestion_reason: string | null }>;
  boq_lines: IttBoqLine[];
  /** Lines written in TPS for work a take-off cannot measure — surveys, staged fees. */
  bill_lines: Array<{
    id: string; seq: number; section: string | null; ref: string | null; description: string;
    unit: string; quantity: string | null; required_for: string | null; notes: string | null;
    ignored: boolean;
  }>;
  boq_summary: {
    total: number; priceable: number; scope_only: number; authored: number;
    /** Split by which mechanism claimed the line, so a thin bill and a take-off that
        resolved no work package cannot be mistaken for one another. */
    by_work_package?: number; by_nrm_code?: number;
  };
  attributed_by_work_package?: boolean;
  wp_code?: string | null;
  wp_scope_condition?: string | null;
  documents: Array<{ id: string; doc_type: string; filename: string; page_count: number; ignored: boolean }>;
  /** The subset of `documents` this package's own take-off lines were read from. */
  spec_documents?: Array<{ id: string; doc_type: string; filename: string; page_count: number; ignored: boolean }>;
  spec_summary?: {
    cited_lines: number; total_lines: number; resolved: number;
    unresolved: number; unresolved_names: string[];
    /** False for a legacy package: boq_items has no spec_source_files to answer from. */
    available: boolean;
  };
  /** Section 1 — what a compliant tender return must contain. */
  return_forms: Array<{ id: string; seq: number; name: string; description: string | null; is_required: boolean; ignored: boolean }>;
  /**
   * Section 2 — what the subcontractor carries around the measured bill.
   *
   * Ordered by section, as the email prints it. `applies_to_all_trades` is the library's
   * own answer to general-vs-package-specific, so nothing stores a designation any more.
   */
  scope_items: Array<{
    id: string; section: string; section_code: string; description: string;
    procurement_stage: string | null; applies_to_all_trades: boolean; ignored: boolean;
  }>;
  scope_summary: {
    total: number; package_specific: number; general: number;
    contract: number; profit_plan: number;
    by_section: Array<{ section: string; total: number }>;
  };
  /** Section 3 — who provides what. SC subcontractor, H main contractor, J joint, N/A. */
  attendances: Array<{ seq: number; group_name: string; description: string; owner: string; notes: string | null }>;
  attendance_summary: { total: number; subcontractor: number; main_contractor: number; joint: number; not_available: number };
  /** Section 6 — terms of employment, issued in draft so the tenderer prices knowing them. */
  precontract_minutes: {
    form_of_subcontract: string | null; subcontract_type: string | null;
    executed_as: string | null; works_summary: string | null; status: string;
  } | null;
  value_engineering_required: boolean;
  /** Computed gaps — an ITT cannot look complete when it is not. */
  review_notes: string[];
};

export type TradeCategory = {
  trade_category: string;
  candidate_count: number;
};

/**
 * A candidate read from SCMS — not yet a shortlist entry. `performance_score` is a string
 * because Postgres returns NUMERIC that way, and null when the firm has never been rated,
 * which is different from scoring zero.
 */
export type LaunchCandidate = {
  subcontractor_id: string;
  name: string;
  trading_as?: string;
  status: string;
  profile_completeness_pct: number;
  performance_score: string | null;
  ratings_count: number;
  /** The SCMS trade strings that actually satisfied this package — shows loose matches. */
  matched_trades: string[];
  /** Whether the tender launch meeting picked this firm. */
  selected: boolean;
  /** One line composed by the BFF from the ranking signals. Never invented. */
  suggestion_reason: string;
  /** What distinguishes the firm — value bands, coverage, accreditations. From the register. */
  usp: string;
  contact_name?: string | null;
  contact_role?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  website?: string | null;
  regional_coverage?: string[] | null;
  value_bands?: string[] | null;
  trade_count?: number;
  /** Previously picked, but the register no longer offers it for this package. */
  /** No supply chain built for this package yet — shown as a marker, not selectable. */
  is_placeholder?: boolean;
  off_register: boolean;
  compliance_flags: {
    pqq_status: string;
    cis_status: string;
    at_risk: boolean;
    profile_completeness_pct: number;
    pl_expiry: string | null;
    pl_active: boolean;
    el_expiry: string | null;
    el_active: boolean;
    accreditations: string[];
  };
};

/** The outcome of clicking "Confirm ITT" for one package. */
export type ConfirmIttResult = {
  package_name: string;
  sent: number;
  failed: number;
  skipped_no_email: number;
  recipients: Array<{ subcontractorId: string; status: 'sent' | 'failed' | 'skipped_no_email'; error?: string }>;
};

/**
 * One email per SUBCONTRACTOR, covering every confirmed package that firm was shortlisted
 * against — so each recipient row names the packages its single email carried.
 */
export type SendAllIttsResult = {
  packages: number;
  subcontractors: number;
  sent: number;
  failed: number;
  skipped_no_email: number;
  /** Confirmed packages that could not be built, and so went to nobody. */
  unassembled_packages: Array<{ packageName: string; error: string }>;
  recipients: Array<{
    subcontractorId: string;
    packages: string[];
    status: 'sent' | 'failed' | 'skipped_no_email';
    error?: string;
  }>;
};

/** One firm shortlisted for a package, as the compose box offers it. */
export type IttDraftRecipient = {
  shortlistEntryId: string;
  subcontractorId: string;
  name: string | null;
  contactName: string | null;
  /** Null when SCMS holds no contact email — shown as unreachable, never silently dropped. */
  email: string | null;
};

/**
 * One package's ITT as the compose modal shows it, before anything is sent.
 *
 * `html` and `text` are a PREVIEW ONLY. They are displayed read-only and never sent back: the
 * server rebuilds the body from its own assembly when sending, so no scope or return
 * requirement can be altered in a browser on its way to a tenderer.
 */
export type IttDraft = {
  packageName: string;
  subject: string;
  html: string;
  text: string;
  recipients: IttDraftRecipient[];
  bundleUrl: string | null;
  completeBundleUrl: string | null;
  /** TEMPORARY (testing the pricing-portal link) — null outside test mode. */
  portalUrl: string | null;
  attachments: Array<{ filename: string; contentType: string; bytes: number }>;
  attachmentsOmittedOversize: boolean;
};

/** What actually went out when the compose modal's Send was clicked. */
export type SendIttDraftResult = {
  package_name: string;
  to: string[];
  cc: string[];
  recipients: number;
  /** Addresses matched back to a shortlisted firm, so the ITT's dispatch record was updated. */
  recorded: number;
  /** Hand-typed addresses belonging to nobody on the shortlist — sent to, but not recorded. */
  not_recorded: number;
  attachments: number;
  email_message_id: string | null;
};

export type IttLetterDetails = {
  workflow_id: string;
  site_address: string | null;
  tender_return_deadline: string | null;
  clarifications_close_date: string | null;
  site_visit_permitted: boolean | null;
  estimator_name: string | null;
  estimator_email: string | null;
};
export type IttLetterDetailsInput = {
  siteAddress?: string | null; tenderReturnDeadline?: string | null; clarificationsCloseDate?: string | null;
  siteVisitPermitted?: boolean | null; estimatorName?: string | null; estimatorEmail?: string | null;
};
export type IttDispatch = {
  id: string;
  shortlist_entry_id: string;
  dispatched_at?: string;
  response?: 'will_tender' | 'decline' | 'considering' | 'no_response';
  responded_at?: string;
  reminder_sent_at?: string;
  trade_category?: string;
  rank?: number;
  subcontractor_id?: string;
};

// ── Subcontractor pricing portal ────────────────────────────────────────────

export type PortalLineStatus = 'priced' | 'included' | 'excluded' | 'not_addressed';

export type PortalLine = {
  id: string;
  seq: number;
  ge_code: string | null;
  element_code: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
  is_priceable: boolean;
  rate: string | null;
  total: string | null;
  status: PortalLineStatus;
  note: string | null;
  added_by_tenderer: boolean;
};

/** One firm on the "Open responses" modal's list — the ITT Dispatch page's buyer view. */
export type PortalResponseSummary = {
  id: string;
  shortlist_entry_id: string;
  package_name: string;
  subcontractor_id: string | null;
  tenderer_name: string;
  /** The firm's current SCMS name, falling back to what was on file when the link was
   * minted — the two can differ if SCMS was corrected afterward. */
  firm_name: string;
  rank: number;
  /** Null when no link was ever issued — see blocked_reason for why. */
  token: string | null;
  recipient_email: string;
  recipient_domain: string;
  expires_at: string | null;
  is_test: boolean;
  blocked_reason: 'public_email_domain' | 'access_unconfigured' | null;
  submitted_at: string | null;
  draft_saved_at: string | null;
  denied_attempts: number;
  last_denied_email: string | null;
  reopened_at: string | null;
};

/** One firm's priced bill, read-only — what "Open response" opens. */
export type PortalResponseDetail = PortalResponseSummary & {
  programme_weeks: number | null;
  qualifications: string | null;
  exclusions: string | null;
  tender_return_id: string | null;
  lines: PortalLine[];
};

/** What the PUBLIC pricing page (no BuildFlow auth) reads and writes, via `portalApi`. */
export type PortalPackage = {
  id: string;
  package_name: string;
  tenderer_name: string;
  recipient_email: string;
  submitted_at: string | null;
  programme_weeks: number | null;
  qualifications: string | null;
  exclusions: string | null;
  tender_return_deadline: string | null;
  lines: PortalLine[];
};

export type PortalDraftInput = {
  programmeWeeks: number | null;
  qualifications: string | null;
  exclusions: string | null;
  lines: Array<{ id: string; quantity: number | null; rate: number | null; status: PortalLineStatus; note: string | null }>;
};

export type PortalNewLineInput = { description: string; quantity: number | null; unit: string | null };

export type TenderComparative = {
  id: string;
  workflow_id: string;
  tenderer_name: string;
  tendered_sum?: number;
  estimate_sum?: number;
  scope_compliance?: Record<string, unknown>;
  qualifications?: string;
  recommendation?: string;
};

export type TenderSubmission = {
  id: string;
  workflow_id: string;
  packages: unknown[];
  aggregate_total?: number;
  board_approved_at?: string;
  dispatched_at?: string;
};

// ── API Client ─────────────────────────────────────────────────────────────

const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3200';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null) headers.set('content-type', 'application/json');
  const token = await accessToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (!token && import.meta.env.VITE_DEV_SUBJECT && import.meta.env.VITE_DEV_ORGANIZATION) {
    headers.set('x-buildflow-dev-subject', import.meta.env.VITE_DEV_SUBJECT);
    headers.set('x-buildflow-dev-organization', import.meta.env.VITE_DEV_ORGANIZATION);
    if (import.meta.env.VITE_DEV_EMAIL) headers.set('x-buildflow-dev-email', import.meta.env.VITE_DEV_EMAIL);
  }
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(detail.message ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  // Workflow
  listWorkflows: () => request<TenderPrepWorkflow[]>('/api/tender-prep/workflows'),
  createWorkflow: (packageId: string) =>
    request<TenderPrepWorkflow>(`/api/packages/${packageId}/tender-prep`, { method: 'POST' }),
  // Null when nothing has launched tender prep for this package yet.
  getWorkflowByPackage: (packageId: string) =>
    request<TenderPrepWorkflow | null>(`/api/packages/${packageId}/tender-prep`),
  getWorkflow: (workflowId: string) =>
    request<TenderPrepWorkflow>(`/api/tender-prep/${workflowId}`),
  setStep: (workflowId: string, step: number) =>
    request<TenderPrepWorkflow>(`/api/tender-prep/${workflowId}/step`, { method: 'POST', body: JSON.stringify({ step }) }),
  advanceStep: (workflowId: string) =>
    request<TenderPrepWorkflow>(`/api/tender-prep/${workflowId}/advance`, { method: 'POST' }),

  // Step 1: Shortlist (Tender Launch Pack)
  listTrades: (search?: string) =>
    request<TradeCategory[]>(`/api/tender-prep/trades${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  getLaunchTable: (workflowId: string, perPackage?: number) =>
    request<LaunchTableRow[]>(`/api/tender-prep/${workflowId}/launch-table${perPackage ? `?perPackage=${perPackage}` : ''}`),
  savePackageSelection: (workflowId: string, input: {
    packageName: string;
    packageSeq?: number;
    routeOfProcurement?: RouteOfProcurement;
    boardOverrideNotes?: string;
    tenderReturnPeriod?: { value: number; unit: TenderReturnUnit } | null;
    entries: Array<{
      subcontractorId: string; rank: number; selected: boolean; suggestionReason?: string;
      performanceScore?: number; complianceFlags?: Record<string, unknown>;
    }>;
  }) => request<unknown>(`/api/tender-prep/${workflowId}/packages/selection`, { method: 'POST', body: JSON.stringify(input) }),

  splitPackage: (packageConfigId: string, children: Array<{ name: string; routeOfProcurement?: string; tradeTerms?: string[] }>) =>
    request<unknown>(`/api/tender-prep/config/packages/${packageConfigId}/split`, { method: 'POST', body: JSON.stringify({ children }) }),
  unsplitPackage: (packageConfigId: string) =>
    request<void>(`/api/tender-prep/config/packages/${packageConfigId}/split`, { method: 'DELETE' }),

  // Project configuration
  getPackageConfig: (projectId?: string) =>
    request<PackageConfig[]>(`/api/tender-prep/config/packages${projectId ? `?projectId=${projectId}` : ''}`),
  putPackageConfig: (input: {
    projectId?: string | null;
    packages: Array<{ seq: number; name: string; routeOfProcurement: RouteOfProcurement; tradeTerms?: string[]; notes?: string }>;
  }) => request<PackageConfig[]>(`/api/tender-prep/config/packages`, { method: 'PUT', body: JSON.stringify(input) }),

  // Step 2: ITT
  listItts: (workflowId: string) => request<IttSummary[]>(`/api/tender-prep/${workflowId}/itts`),
  getIttPack: (workflowId: string, packageName: string) =>
    request<IttPack>(`/api/tender-prep/${workflowId}/itt-pack?packageName=${encodeURIComponent(packageName)}`),
  listItt: (workflowId: string) => request<IttDispatch[]>(`/api/tender-prep/${workflowId}/itt`),
  setIttLineOverride: (workflowId: string, packageName: string, input: { section: IttLineSection; itemId: string; ignored: boolean }) =>
    request<{ ignored: boolean }>(`/api/tender-prep/${workflowId}/itts/${encodeURIComponent(packageName)}/line-overrides`, {
      method: 'PUT', body: JSON.stringify(input)
    }),
  confirmItt: (workflowId: string, packageName: string) =>
    request<ConfirmIttResult>(`/api/tender-prep/${workflowId}/itts/${encodeURIComponent(packageName)}/confirm`, { method: 'POST' }),
  sendAllItts: (workflowId: string) =>
    request<SendAllIttsResult>(`/api/tender-prep/${workflowId}/itts/send-all`, { method: 'POST' }),
  getIttDraft: (workflowId: string, packageName: string) =>
    request<IttDraft>(`/api/tender-prep/${workflowId}/itts/${encodeURIComponent(packageName)}/draft`),
  /** Only the addresses and subject travel — the server rebuilds the body it sends. */
  sendIttDraft: (workflowId: string, packageName: string, input: { to: string[]; cc: string[]; subject: string }) =>
    request<SendIttDraftResult>(`/api/tender-prep/${workflowId}/itts/${encodeURIComponent(packageName)}/draft/send`, {
      method: 'POST', body: JSON.stringify(input)
    }),
  recordIttResponse: (dispatchId: string, response: IttDispatch['response']) =>
    request<IttDispatch>(`/api/tender-prep/itt/${dispatchId}`, { method: 'PATCH', body: JSON.stringify({ response }) }),
  getIttLetterDetails: (workflowId: string) =>
    request<IttLetterDetails>(`/api/tender-prep/${workflowId}/itt-letter-details`),
  saveIttLetterDetails: (workflowId: string, input: IttLetterDetailsInput) =>
    request<IttLetterDetails>(`/api/tender-prep/${workflowId}/itt-letter-details`, { method: 'PUT', body: JSON.stringify(input) }),

  // Step 2: subcontractor pricing portal — the buyer-facing "Open responses" side
  listPortalResponses: (workflowId: string, packageName: string) =>
    request<PortalResponseSummary[]>(`/api/tender-prep/${workflowId}/portal-responses?packageName=${encodeURIComponent(packageName)}`),
  getPortalResponse: (workflowId: string, linkId: string) =>
    request<PortalResponseDetail>(`/api/tender-prep/${workflowId}/portal-responses/${linkId}`),
  reopenPortalResponse: (workflowId: string, linkId: string) =>
    request<PortalResponseDetail>(`/api/tender-prep/${workflowId}/portal-responses/${linkId}/reopen`, { method: 'POST' }),

  // Step 3: Comparative
  listComparative: (workflowId: string) => request<TenderComparative[]>(`/api/tender-prep/${workflowId}/comparative`),
  upsertComparative: (workflowId: string, input: Omit<TenderComparative, 'id' | 'workflow_id'>) =>
    request<TenderComparative>(`/api/tender-prep/${workflowId}/comparative`, { method: 'POST', body: JSON.stringify(input) }),

  // Step 4: Submission
  getSubmission: (workflowId: string) => request<TenderSubmission | null>(`/api/tender-prep/${workflowId}/submission`),
  saveSubmission: (workflowId: string, input: { packages: unknown[]; aggregateTotal?: number }) =>
    request<TenderSubmission>(`/api/tender-prep/${workflowId}/submission`, { method: 'POST', body: JSON.stringify(input) }),
  boardApproveSubmission: (workflowId: string) =>
    request<TenderSubmission>(`/api/tender-prep/${workflowId}/submission/approve`, { method: 'POST' })
};

// ── portalApi: the PUBLIC pricing page, no BuildFlow authentication ─────────────────
//
// Deliberately NOT `request()` above. That helper always attaches an OIDC bearer or the
// x-buildflow-dev-* headers (api.ts:352-358) — a subcontractor opening an emailed link is
// not a BuildFlow user, and a dev header would provision a BuildFlow actor for them. What
// gates these calls instead is Cloudflare Access at the edge plus the token/identity
// binding the server checks on every request (see app.ts's public /portal/:token routes).
//
// The base URL is resolved at RUNTIME, not from VITE_API_URL, because the deployed page is
// served at dev.novamerx.ai/tps/respond/:token and its fetches must stay same-origin
// (dev.novamerx.ai/tps-api/...) for the host-scoped CF_Authorization cookie to ride along —
// a cross-origin fetch to a separate API host would not carry it. Locally (no /tps prefix,
// no Cloudflare Access in front of anything) it falls back to VITE_API_URL exactly as the
// authenticated api object does.
function portalBaseUrl(): string {
  if (window.location.pathname.startsWith('/tps')) return '/tps-api';
  return import.meta.env.VITE_API_URL ?? 'http://localhost:3200';
}

async function portalRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null) headers.set('content-type', 'application/json');
  const response = await fetch(`${portalBaseUrl()}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(detail.message ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const portalApi = {
  get: (token: string) => portalRequest<PortalPackage>(`/portal/${encodeURIComponent(token)}`),
  saveDraft: (token: string, input: PortalDraftInput) =>
    portalRequest<PortalPackage>(`/portal/${encodeURIComponent(token)}/draft`, { method: 'PUT', body: JSON.stringify(input) }),
  submit: (token: string) => portalRequest<PortalPackage>(`/portal/${encodeURIComponent(token)}/submit`, { method: 'POST' }),
  addLine: (token: string, input: PortalNewLineInput) =>
    portalRequest<PortalPackage>(`/portal/${encodeURIComponent(token)}/lines`, { method: 'POST', body: JSON.stringify(input) }),
  deleteLine: (token: string, lineId: string) =>
    portalRequest<PortalPackage>(`/portal/${encodeURIComponent(token)}/lines/${encodeURIComponent(lineId)}`, { method: 'DELETE' })
};
