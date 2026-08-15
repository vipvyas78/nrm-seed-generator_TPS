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
  notes?: string | null;
  confirmed_at: string | null;
  board_override_notes: string | null;
  subcontractors: LaunchCandidate[];
};

/** One line of the ITT index: a package with an ITT ready to view. */
export type IttSummary = {
  package_name: string;
  package_seq: number | null;
  route_of_procurement: string;
  confirmed_at: string | null;
  recipients: number;
  dispatched: number;
  responded: number;
};

export type IttBoqLine = {
  ge_code: string | null;
  element_code: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
  is_priceable: boolean;
};

/** The assembled Invitation to Tender for one package. Rates are deliberately absent. */
export type IttPack = {
  package_name: string;
  display_ref: string;
  route_of_procurement: string;
  takeoff: Record<string, unknown>;
  boq_id: string | null;
  confirmed_at: string | null;
  recipients: Array<{ subcontractor_id: string; rank: number; suggestion_reason: string | null }>;
  boq_lines: IttBoqLine[];
  /** Lines written in TPS for work a take-off cannot measure — surveys, staged fees. */
  bill_lines: Array<{
    seq: number; section: string | null; ref: string | null; description: string;
    unit: string; quantity: string | null; required_for: string | null; notes: string | null;
  }>;
  boq_summary: { total: number; priceable: number; scope_only: number; authored: number };
  documents: Array<{ doc_type: string; filename: string; page_count: number }>;
  /** Section 1 — what a compliant tender return must contain. */
  return_forms: Array<{ seq: number; name: string; description: string | null; is_required: boolean }>;
  /** Section 2 — what the subcontractor carries around the measured bill. */
  scope_items: Array<{
    ref: number; description: string;
    procurement_stage: string | null; designation: string | null;
  }>;
  scope_summary: {
    total: number; package_specific: number; general: number;
    contract: number; profit_plan: number;
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
  dispatchItt: (workflowId: string) =>
    request<IttDispatch[]>(`/api/tender-prep/${workflowId}/itt/dispatch`, { method: 'POST' }),
  recordIttResponse: (dispatchId: string, response: IttDispatch['response']) =>
    request<IttDispatch>(`/api/tender-prep/itt/${dispatchId}`, { method: 'PATCH', body: JSON.stringify({ response }) }),

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
