import { accessToken } from './auth';

// ── Types ──────────────────────────────────────────────────────────────────

export type TenderPrepWorkflow = {
  id: string;
  package_id: string;
  organization_id: string;
  current_step: number;
  step_data: Record<string, unknown>;
  locked_at?: string;
  created_at: string;
  updated_at: string;
};

export type TenderPrepRfi = {
  id: string;
  workflow_id: string;
  description: string;
  status: 'open' | 'responded' | 'closed';
  employer_response?: string;
  resolved_at?: string;
  created_at: string;
};

export type SoaRagRow = {
  id: string;
  workflow_id: string;
  clause_ref: string;
  amendment_text?: string;
  rag_status: 'red' | 'amber' | 'green';
  jct_nec4_ref?: string;
  commentary?: string;
  reviewed_by?: string;
};

export type SoaRagUpsert = {
  clauseRef: string;
  amendmentText?: string;
  ragStatus: 'red' | 'amber' | 'green';
  jctNec4Ref?: string;
  commentary?: string;
};

export type TenderPrepShortlist = {
  id: string;
  workflow_id: string;
  trade_category: string;
  confirmed_at?: string;
  board_override_notes?: string;
  entries: TenderPrepShortlistEntry[];
};

export type TenderPrepShortlistEntry = {
  id: string;
  shortlist_id: string;
  subcontractor_id: string;
  rank: number;
  performance_score?: number;
  compliance_flags?: Record<string, unknown>;
  board_approved: boolean;
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
export type ShortlistCandidate = {
  subcontractor_id: string;
  name: string;
  trading_as?: string;
  status: string;
  profile_completeness_pct: number;
  performance_score: string | null;
  ratings_count: number;
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
  createWorkflow: (packageId: string) =>
    request<TenderPrepWorkflow>(`/api/packages/${packageId}/tender-prep`, { method: 'POST' }),
  getWorkflow: (workflowId: string) =>
    request<TenderPrepWorkflow>(`/api/tender-prep/${workflowId}`),
  advanceStep: (workflowId: string) =>
    request<TenderPrepWorkflow>(`/api/tender-prep/${workflowId}/advance`, { method: 'POST' }),

  // Step 2: RFIs
  listRfis: (workflowId: string) => request<TenderPrepRfi[]>(`/api/tender-prep/${workflowId}/rfis`),
  createRfi: (workflowId: string, description: string) =>
    request<TenderPrepRfi>(`/api/tender-prep/${workflowId}/rfis`, { method: 'POST', body: JSON.stringify({ description }) }),
  updateRfi: (rfiId: string, patch: { status?: string; employerResponse?: string }) =>
    request<TenderPrepRfi>(`/api/tender-prep/rfis/${rfiId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // Step 3: SoA RAG
  getSoaRag: (workflowId: string) => request<SoaRagRow[]>(`/api/tender-prep/${workflowId}/soa-rag`),
  // camelCase, matching the BFF's request schema — the response comes back snake_case as SoaRagRow.
  upsertSoaRag: (workflowId: string, rows: SoaRagUpsert[]) =>
    request<SoaRagRow[]>(`/api/tender-prep/${workflowId}/soa-rag`, { method: 'POST', body: JSON.stringify({ rows }) }),

  // Step 4: Shortlist
  listTrades: (search?: string) =>
    request<TradeCategory[]>(`/api/tender-prep/trades${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  getShortlistCandidates: (workflowId: string, trade: string, limit?: number) =>
    request<ShortlistCandidate[]>(`/api/tender-prep/${workflowId}/shortlist/candidates?trade=${encodeURIComponent(trade)}${limit ? `&limit=${limit}` : ''}`),
  getShortlists: (workflowId: string) => request<TenderPrepShortlist[]>(`/api/tender-prep/${workflowId}/shortlist`),
  confirmShortlist: (workflowId: string, input: { tradeCategory: string; boardOverrideNotes?: string; entries: Array<{ subcontractorId: string; rank: number; performanceScore?: number; complianceFlags?: Record<string, unknown> }> }) =>
    request<TenderPrepShortlist>(`/api/tender-prep/${workflowId}/shortlist/confirm`, { method: 'POST', body: JSON.stringify(input) }),

  // Step 5: ITT
  listItt: (workflowId: string) => request<IttDispatch[]>(`/api/tender-prep/${workflowId}/itt`),
  dispatchItt: (workflowId: string) =>
    request<IttDispatch[]>(`/api/tender-prep/${workflowId}/itt/dispatch`, { method: 'POST' }),
  recordIttResponse: (dispatchId: string, response: IttDispatch['response']) =>
    request<IttDispatch>(`/api/tender-prep/itt/${dispatchId}`, { method: 'PATCH', body: JSON.stringify({ response }) }),

  // Step 6: Comparative
  listComparative: (workflowId: string) => request<TenderComparative[]>(`/api/tender-prep/${workflowId}/comparative`),
  upsertComparative: (workflowId: string, input: Omit<TenderComparative, 'id' | 'workflow_id'>) =>
    request<TenderComparative>(`/api/tender-prep/${workflowId}/comparative`, { method: 'POST', body: JSON.stringify(input) }),

  // Step 7: Submission
  getSubmission: (workflowId: string) => request<TenderSubmission | null>(`/api/tender-prep/${workflowId}/submission`),
  saveSubmission: (workflowId: string, input: { packages: unknown[]; aggregateTotal?: number }) =>
    request<TenderSubmission>(`/api/tender-prep/${workflowId}/submission`, { method: 'POST', body: JSON.stringify(input) }),
  boardApproveSubmission: (workflowId: string) =>
    request<TenderSubmission>(`/api/tender-prep/${workflowId}/submission/approve`, { method: 'POST' })
};
