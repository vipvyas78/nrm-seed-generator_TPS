import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { api, type IttDispatch, type ShortlistCandidate, type SoaRagRow, type TenderComparative, type TenderPrepWorkflow } from './api';
import { oidc, signIn } from './auth';

function ErrorMessage({ error }: { error: unknown }) {
  return error ? <p className="error">{error instanceof Error ? error.message : 'Something went wrong'}</p> : null;
}
function Busy({ children = 'Loading…' }: { children?: string }) { return <p className="muted">{children}</p>; }

const STEP_TITLES = ['Parsed Outputs', 'Employer RFIs', 'SoA RAG', 'Tender Launch Pack', 'ITT Dispatch', 'Comparative Analysis', 'Tender Submission'];

// ── AppShell ───────────────────────────────────────────────────────────────

export function AppShell() {
  const [signingIn, setSigningIn] = useState(false);
  return <main className="shell">
    <header>
      <span className="brand">BuildFlow</span>
      <span className="header-sub">Tender Preparation</span>
      {oidc && <button className="link-button" disabled={signingIn} onClick={() => { setSigningIn(true); void signIn(); }}>Sign in</button>}
    </header>
    <Outlet />
  </main>;
}

export function AuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  useState(() => {
    if (!oidc) { navigate('/', { replace: true }); return; }
    void oidc.signinRedirectCallback().then(() => navigate('/', { replace: true })).catch((r: unknown) => setError(r instanceof Error ? r.message : 'Sign-in failed'));
  });
  return <main className="shell"><p>{error ?? 'Completing sign-in…'}</p></main>;
}

// ── TenderPrepPage ─────────────────────────────────────────────────────────

export function TenderPrepPage() {
  const { packageId = '' } = useParams();
  const queryClient = useQueryClient();

  const workflowQuery = useQuery({ queryKey: ['workflow', packageId], queryFn: () => api.getWorkflow(packageId), enabled: false });
  const [workflowId, setWorkflowId] = useState<string | null>(null);

  const createWorkflow = useMutation({
    mutationFn: () => api.createWorkflow(packageId),
    onSuccess: (wf) => { setWorkflowId(wf.id); void queryClient.invalidateQueries({ queryKey: ['workflow', packageId] }); }
  });

  const workflow = useQuery({
    queryKey: ['workflow-detail', workflowId],
    queryFn: () => api.getWorkflow(workflowId!),
    enabled: Boolean(workflowId),
    refetchInterval: false
  });

  const advance = useMutation({
    mutationFn: () => api.advanceStep(workflowId!),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['workflow-detail', workflowId] })
  });

  if (!workflowId) {
    return <section className="centered">
      <h1>Tender Preparation</h1>
      <p className="muted">Package: {packageId}</p>
      <p style={{ marginBottom: 16 }}>Start the 7-step tender preparation workflow for this package.</p>
      <ErrorMessage error={createWorkflow.error} />
      <button onClick={() => createWorkflow.mutate()} disabled={createWorkflow.isPending}>
        {createWorkflow.isPending ? 'Starting…' : 'Start Tender Preparation →'}
      </button>
    </section>;
  }

  if (workflow.isLoading) return <Busy />;
  if (!workflow.data) return <ErrorMessage error={workflow.error} />;

  const wf = workflow.data as TenderPrepWorkflow;
  const currentStep = wf.current_step;

  return <div className="wizard-layout">
    <aside className="wizard-sidebar">
      <h3>Tender Preparation</h3>
      <ul className="step-list">
        {STEP_TITLES.map((title, i) => {
          const stepNum = i + 1;
          const done = stepNum < currentStep;
          const active = stepNum === currentStep;
          return <li key={stepNum} className={`step-item ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
            <span className="step-num">{done ? '✓' : stepNum}</span>
            <span className="step-title">{title}</span>
          </li>;
        })}
      </ul>
    </aside>

    <section className="wizard-content">
      <div className="step-header">
        <h2>Step {currentStep}: {STEP_TITLES[currentStep - 1]}</h2>
        {currentStep < 7 && <button className="secondary small" onClick={() => advance.mutate()} disabled={advance.isPending}>
          Next: {STEP_TITLES[currentStep]} →
        </button>}
      </div>
      <ErrorMessage error={advance.error} />

      {currentStep === 1 && <Step1ParsedOutputs packageId={packageId} />}
      {currentStep === 2 && <Step2Rfis workflowId={workflowId} />}
      {currentStep === 3 && <Step3SoaRag workflowId={workflowId} />}
      {currentStep === 4 && <Step4TenderLaunchPack workflowId={workflowId} />}
      {currentStep === 5 && <Step5IttDispatch workflowId={workflowId} />}
      {currentStep === 6 && <Step6Comparative workflowId={workflowId} />}
      {currentStep === 7 && <Step7Submission workflowId={workflowId} />}
    </section>
  </div>;
}

// ── Step 1: Parsed Outputs ─────────────────────────────────────────────────

function Step1ParsedOutputs({ packageId }: { packageId: string }) {
  const mainAppUrl = import.meta.env.VITE_MAIN_APP_URL ?? 'http://localhost:5173';
  return <div className="panel">
    <h3>BOQ / QTO Summary</h3>
    <p className="muted">This step provides a read-only view of the analysis outputs for the package.</p>
    <div className="info-row">
      <div className="info-item"><span className="info-label">Package ID</span><code>{packageId}</code></div>
    </div>
    <p style={{ marginTop: 12 }}>
      <a href={`${mainAppUrl}/packages/${packageId}`} target="_blank" rel="noreferrer" className="button-link">
        View full analysis in BuildFlow →
      </a>
    </p>
    <p className="muted" style={{ marginTop: 12, fontSize: '0.8rem' }}>
      Review the Classification and TOQ tabs in the main app, then advance to Step 2 when ready.
    </p>
  </div>;
}

// ── Step 2: Employer RFIs ─────────────────────────────────────────────────

function Step2Rfis({ workflowId }: { workflowId: string }) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const rfis = useQuery({ queryKey: ['rfis', workflowId], queryFn: () => api.listRfis(workflowId) });
  const createRfi = useMutation({
    mutationFn: () => api.createRfi(workflowId, description),
    onSuccess: () => { setDescription(''); void queryClient.invalidateQueries({ queryKey: ['rfis', workflowId] }); }
  });
  const updateRfi = useMutation({
    mutationFn: ({ rfiId, patch }: { rfiId: string; patch: { status?: string } }) => api.updateRfi(rfiId, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['rfis', workflowId] })
  });

  const submit = (e: FormEvent) => { e.preventDefault(); if (description.trim()) createRfi.mutate(); };

  return <div>
    <div className="panel">
      <h3>Add RFI Item</h3>
      <form className="inline-form" onSubmit={submit}>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the conflict or clarification required…" />
        <button disabled={createRfi.isPending}>Add</button>
      </form>
    </div>
    <div className="panel">
      <h3>RFI Schedule ({rfis.data?.length ?? 0} items)</h3>
      {rfis.isLoading ? <Busy /> : rfis.data?.length === 0 ? <p className="muted">No RFI items yet.</p>
        : <table className="data-table">
            <thead><tr><th>Description</th><th>Status</th><th>Response</th><th>Actions</th></tr></thead>
            <tbody>{rfis.data?.map((rfi) => <tr key={rfi.id} className={rfi.status === 'closed' ? 'row-done' : ''}>
              <td>{rfi.description}</td>
              <td><span className={`badge badge-${rfi.status === 'closed' ? 'green' : rfi.status === 'responded' ? 'blue' : 'amber'}`}>{rfi.status}</span></td>
              <td className="muted">{rfi.employer_response ?? '—'}</td>
              <td>
                {rfi.status === 'open' && <button className="small" onClick={() => updateRfi.mutate({ rfiId: rfi.id, patch: { status: 'responded' } })}>Mark responded</button>}
                {rfi.status === 'responded' && <button className="small" onClick={() => updateRfi.mutate({ rfiId: rfi.id, patch: { status: 'closed' } })}>Close</button>}
              </td>
            </tr>)}</tbody>
          </table>}
    </div>
  </div>;
}

// ── Step 3: SoA RAG ───────────────────────────────────────────────────────

function Step3SoaRag({ workflowId }: { workflowId: string }) {
  const queryClient = useQueryClient();
  const [editingRows, setEditingRows] = useState<SoaRagRow[]>([]);
  const [newClause, setNewClause] = useState('');
  const rag = useQuery({ queryKey: ['soa-rag', workflowId], queryFn: () => api.getSoaRag(workflowId) });

  const save = useMutation({
    mutationFn: (rows: SoaRagRow[]) => api.upsertSoaRag(workflowId, rows.map((r) => ({
      clauseRef: r.clause_ref, amendmentText: r.amendment_text, ragStatus: r.rag_status,
      jctNec4Ref: r.jct_nec4_ref, commentary: r.commentary
    }))),
    onSuccess: () => { setEditingRows([]); void queryClient.invalidateQueries({ queryKey: ['soa-rag', workflowId] }); }
  });

  const rows = editingRows.length > 0 ? editingRows : (rag.data ?? []);
  const hasRed = rows.some((r) => r.rag_status === 'red');

  const addRow = () => {
    if (!newClause.trim()) return;
    setEditingRows([...(editingRows.length > 0 ? editingRows : (rag.data ?? [])),
      { id: '', workflow_id: workflowId, clause_ref: newClause, rag_status: 'green' }]);
    setNewClause('');
  };

  const updateRow = (i: number, field: keyof SoaRagRow, value: string) => {
    const current = editingRows.length > 0 ? editingRows : [...(rag.data ?? [])];
    const updated = current.map((r, idx) => idx === i ? { ...r, [field]: value } : r);
    setEditingRows(updated);
  };

  return <div>
    {hasRed && <div className="alert alert-red"><strong>Director review required:</strong> Clauses marked RED must have a commentary note from a Director before proceeding.</div>}
    <div className="alert alert-grey"><strong>Legal disclaimer:</strong> SoA commentary is for internal planning purposes only and does not constitute legal advice.</div>
    <div className="panel">
      <div className="inline-form" style={{ marginBottom: 12 }}>
        <input value={newClause} onChange={(e) => setNewClause(e.target.value)} placeholder="Clause reference (e.g. A1.1.2)" />
        <button className="secondary small" onClick={addRow}>Add clause</button>
      </div>
      {rag.isLoading ? <Busy /> : <table className="data-table">
        <thead><tr><th>Clause Ref</th><th>RAG</th><th>JCT/NEC4 Ref</th><th>Commentary</th></tr></thead>
        <tbody>{rows.map((row, i) => <tr key={row.clause_ref}>
          <td><code>{row.clause_ref}</code></td>
          <td><select className="rag-select" value={row.rag_status} onChange={(e) => updateRow(i, 'rag_status', e.target.value as 'red' | 'amber' | 'green')} style={{ background: row.rag_status === 'red' ? '#fee2e2' : row.rag_status === 'amber' ? '#fef3c7' : '#dcfce7' }}>
            <option value="green">Green</option>
            <option value="amber">Amber</option>
            <option value="red">Red</option>
          </select></td>
          <td><input value={row.jct_nec4_ref ?? ''} onChange={(e) => updateRow(i, 'jct_nec4_ref', e.target.value)} placeholder="e.g. cl. 3.14" style={{ maxWidth: 120 }} /></td>
          <td><input value={row.commentary ?? ''} onChange={(e) => updateRow(i, 'commentary', e.target.value)} placeholder={row.rag_status === 'red' ? 'Director review note required' : 'Commentary…'} /></td>
        </tr>)}
        {rows.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: '1.5rem' }}>No SoA clauses added yet.</td></tr>}
        </tbody>
      </table>}
      {editingRows.length > 0 && <div className="button-row" style={{ marginTop: 12 }}>
        <button className="secondary small" onClick={() => setEditingRows([])}>Discard changes</button>
        <button className="small" onClick={() => save.mutate(editingRows)} disabled={save.isPending}>Save RAG status</button>
      </div>}
      <ErrorMessage error={save.error} />
    </div>
  </div>;
}

// ── Step 4: Tender Launch Pack ─────────────────────────────────────────────

const MAX_SHORTLIST = 5;

/** PQQ state and insurance cover are shown, not enforced — the buyer weighs them. */
function ComplianceBadges({ flags }: { flags: ShortlistCandidate['compliance_flags'] }) {
  const pqqTone = flags.pqq_status === 'approved' ? 'green' : flags.pqq_status === 'submitted' ? 'amber' : 'grey';
  return <span className="badge-row">
    <span className={`badge badge-${pqqTone}`}>PQQ {flags.pqq_status.replace('_', ' ')}</span>
    <span className={`badge badge-${flags.cis_status === 'UNKNOWN' ? 'grey' : 'green'}`}>CIS {flags.cis_status}</span>
    <span className={`badge badge-${flags.pl_active ? 'green' : 'red'}`} title={flags.pl_expiry ? `Expires ${flags.pl_expiry}` : 'No expiry recorded'}>
      PL {flags.pl_active ? 'active' : 'lapsed'}
    </span>
    <span className={`badge badge-${flags.el_active ? 'green' : 'red'}`} title={flags.el_expiry ? `Expires ${flags.el_expiry}` : 'No expiry recorded'}>
      EL {flags.el_active ? 'active' : 'lapsed'}
    </span>
    {flags.at_risk && <span className="badge badge-red">At risk</span>}
    {flags.accreditations.map((a) => <span key={a} className="badge badge-blue">{a}</span>)}
  </span>;
}

function Step4TenderLaunchPack({ workflowId }: { workflowId: string }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [trade, setTrade] = useState<string | null>(null);
  // Selection order is the ranking: first picked is rank 1.
  const [picked, setPicked] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

  const trades = useQuery({ queryKey: ['trades', search], queryFn: () => api.listTrades(search || undefined) });
  const shortlists = useQuery({ queryKey: ['shortlists', workflowId], queryFn: () => api.getShortlists(workflowId) });
  const candidates = useQuery({
    queryKey: ['candidates', workflowId, trade],
    queryFn: () => api.getShortlistCandidates(workflowId, trade!),
    enabled: Boolean(trade)
  });

  const lock = useMutation({
    mutationFn: () => api.confirmShortlist(workflowId, {
      tradeCategory: trade!,
      boardOverrideNotes: notes.trim() || undefined,
      entries: picked.map((id, i) => {
        const c = candidates.data?.find((x) => x.subcontractor_id === id);
        return {
          subcontractorId: id,
          rank: i + 1,
          // NUMERIC arrives as a string, and stays absent when the firm is unrated.
          performanceScore: c?.performance_score != null ? Number(c.performance_score) : undefined,
          complianceFlags: c?.compliance_flags
        };
      })
    }),
    onSuccess: () => {
      setPicked([]); setTrade(null); setNotes(''); setSearch('');
      void queryClient.invalidateQueries({ queryKey: ['shortlists', workflowId] });
    }
  });

  const toggle = (id: string) => setPicked((p) =>
    p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_SHORTLIST ? p : [...p, id]);

  const selectTrade = (t: string) => { setTrade(t); setPicked([]); };
  const alreadyLocked = new Set(shortlists.data?.map((s) => s.trade_category));

  return <div>
    <div className="panel">
      <h3>Programme (Placeholder)</h3>
      <p className="muted">Tender programme Gantt — phase milestones will be displayed here.</p>
      <div className="gantt-placeholder">Programme chart will be rendered here in a future release.</div>
    </div>

    <div className="panel">
      <h3>Select a Trade</h3>
      <p className="muted">Trades are read from SCMS. The count is the number of firms eligible to be invited.</p>
      <div className="inline-form" style={{ marginBottom: 12 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search trades, e.g. Groundworks…" />
      </div>
      {trades.isLoading ? <Busy />
        : trades.error ? <ErrorMessage error={trades.error} />
        : trades.data?.length === 0 ? <p className="muted">No trades match “{search}”.</p>
        : <div className="trade-chips">
            {trades.data?.map((t) => <button
              key={t.trade_category}
              className={`trade-chip ${trade === t.trade_category ? 'active' : ''}`}
              onClick={() => selectTrade(t.trade_category)}>
              {t.trade_category}
              <span className="trade-count">{t.candidate_count}</span>
              {alreadyLocked.has(t.trade_category) && <span className="badge badge-green">locked</span>}
            </button>)}
          </div>}
    </div>

    {trade && <div className="panel">
      <div className="shortlist-header">
        <h3>{trade} — Candidates</h3>
        <span className="muted">{picked.length} of {MAX_SHORTLIST} selected</span>
      </div>
      {candidates.isLoading ? <Busy />
        : candidates.error ? <ErrorMessage error={candidates.error} />
        : candidates.data?.length === 0 ? <p className="muted">No eligible firms carry this trade in SCMS.</p>
        : <>
          <table className="data-table">
            <thead><tr><th>Rank</th><th>Subcontractor</th><th>Performance</th><th>Profile</th><th>Compliance</th></tr></thead>
            <tbody>{candidates.data?.map((c) => {
              const at = picked.indexOf(c.subcontractor_id);
              return <tr key={c.subcontractor_id} className={at >= 0 ? 'row-done' : ''}>
                <td>
                  <button
                    className={`rank-toggle ${at >= 0 ? 'active' : ''}`}
                    disabled={at < 0 && picked.length >= MAX_SHORTLIST}
                    onClick={() => toggle(c.subcontractor_id)}>
                    {at >= 0 ? `#${at + 1}` : 'Add'}
                  </button>
                </td>
                <td>
                  <strong>{c.name}</strong>
                  {c.trading_as && <span className="muted"> t/a {c.trading_as}</span>}
                </td>
                <td>{c.performance_score != null
                  ? <>{Number(c.performance_score).toFixed(1)} <span className="muted">({c.ratings_count})</span></>
                  : <span className="muted">Unrated</span>}</td>
                <td>{c.profile_completeness_pct}%</td>
                <td><ComplianceBadges flags={c.compliance_flags} /></td>
              </tr>;
            })}</tbody>
          </table>
          <div className="inline-form" style={{ marginTop: 12 }}>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Board override notes (optional)…" />
            <button onClick={() => lock.mutate()} disabled={picked.length === 0 || lock.isPending}>
              {lock.isPending ? 'Locking…' : `Lock Shortlist (${picked.length})`}
            </button>
          </div>
          <ErrorMessage error={lock.error} />
        </>}
    </div>}

    <div className="panel">
      <h3>Locked Shortlists</h3>
      {shortlists.isLoading ? <Busy />
        : shortlists.data?.length === 0 ? <p className="muted">Nothing locked yet. Pick a trade above to build a shortlist.</p>
        : shortlists.data?.map((sl) => <div key={sl.trade_category} className="shortlist-card">
          <div className="shortlist-header">
            <h4>{sl.trade_category}</h4>
            {sl.confirmed_at && <span className="badge badge-green">Locked {new Date(sl.confirmed_at).toLocaleDateString()}</span>}
          </div>
          {sl.board_override_notes && <p className="muted" style={{ fontSize: '0.8rem' }}>{sl.board_override_notes}</p>}
          <table className="data-table"><thead><tr><th>Rank</th><th>Subcontractor ID</th><th>Performance Score</th><th>Board Approved</th></tr></thead>
            <tbody>{sl.entries.map((e) => <tr key={e.id}>
              <td>#{e.rank}</td>
              <td><code>{e.subcontractor_id}</code></td>
              <td>{e.performance_score ?? <span className="muted">Unrated</span>}</td>
              <td>{e.board_approved ? <span className="badge badge-green">Yes</span> : <span className="badge badge-grey">Pending</span>}</td>
            </tr>)}</tbody>
          </table>
        </div>)}
    </div>
  </div>;
}

// ── Step 5: ITT Dispatch ──────────────────────────────────────────────────

function Step5IttDispatch({ workflowId }: { workflowId: string }) {
  const queryClient = useQueryClient();
  const itts = useQuery({ queryKey: ['itt', workflowId], queryFn: () => api.listItt(workflowId) });

  const dispatch = useMutation({
    mutationFn: () => api.dispatchItt(workflowId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['itt', workflowId] })
  });

  const respond = useMutation({
    mutationFn: ({ dispatchId, response }: { dispatchId: string; response: IttDispatch['response'] }) =>
      api.recordIttResponse(dispatchId, response),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['itt', workflowId] })
  });

  const stats = {
    sent: itts.data?.filter((d) => d.dispatched_at).length ?? 0,
    willTender: itts.data?.filter((d) => d.response === 'will_tender').length ?? 0,
    declined: itts.data?.filter((d) => d.response === 'decline').length ?? 0,
    noResponse: itts.data?.filter((d) => !d.response).length ?? 0
  };

  return <div className="panel">
    <div className="stats-bar">
      <div className="stat"><span className="stat-value">{stats.sent}</span><span className="stat-label">Sent</span></div>
      <div className="stat"><span className="stat-value" style={{ color: '#22c55e' }}>{stats.willTender}</span><span className="stat-label">Will Tender</span></div>
      <div className="stat"><span className="stat-value" style={{ color: '#ef4444' }}>{stats.declined}</span><span className="stat-label">Declined</span></div>
      <div className="stat"><span className="stat-value" style={{ color: '#6b7280' }}>{stats.noResponse}</span><span className="stat-label">No Response</span></div>
    </div>
    <div className="button-row" style={{ marginBottom: 12 }}>
      <button onClick={() => dispatch.mutate()} disabled={dispatch.isPending}>Dispatch ITTs</button>
    </div>
    {itts.isLoading ? <Busy /> : itts.data?.length === 0 ? <p className="muted">No ITTs dispatched. Lock shortlists in Step 4 first.</p>
      : <table className="data-table">
          <thead><tr><th>Trade</th><th>Rank</th><th>Sub ID</th><th>Dispatched</th><th>Response</th><th>Action</th></tr></thead>
          <tbody>{itts.data?.map((d) => <tr key={d.id}>
            <td>{d.trade_category ?? '—'}</td>
            <td>#{d.rank}</td>
            <td><code style={{ fontSize: '0.75rem' }}>{d.subcontractor_id}</code></td>
            <td>{d.dispatched_at ? new Date(d.dispatched_at).toLocaleDateString() : '—'}</td>
            <td>{d.response
              ? <span className={`badge badge-${d.response === 'will_tender' ? 'green' : d.response === 'decline' ? 'red' : 'amber'}`}>{d.response.replace('_', ' ')}</span>
              : <span className="badge badge-grey">Awaiting</span>}</td>
            <td>
              {!d.response && d.dispatched_at && <select className="small-select" defaultValue="" onChange={(e) => { if (e.target.value) respond.mutate({ dispatchId: d.id, response: e.target.value as IttDispatch['response'] }); }}>
                <option value="" disabled>Record response…</option>
                <option value="will_tender">Will tender</option>
                <option value="decline">Decline</option>
                <option value="considering">Considering</option>
                <option value="no_response">No response</option>
              </select>}
            </td>
          </tr>)}</tbody>
        </table>}
  </div>;
}

// ── Step 6: Comparative Analysis ──────────────────────────────────────────

function Step6Comparative({ workflowId }: { workflowId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [tendered, setTendered] = useState('');
  const [estimate, setEstimate] = useState('');
  const [recommendation, setRecommendation] = useState('');

  const rows = useQuery({ queryKey: ['comparative', workflowId], queryFn: () => api.listComparative(workflowId) });

  const add = useMutation({
    mutationFn: () => api.upsertComparative(workflowId, {
      tenderer_name: name, tendered_sum: tendered ? Number(tendered) : undefined,
      estimate_sum: estimate ? Number(estimate) : undefined, recommendation: recommendation || undefined
    }),
    onSuccess: () => { setName(''); setTendered(''); setEstimate(''); setRecommendation(''); void queryClient.invalidateQueries({ queryKey: ['comparative', workflowId] }); }
  });

  const fmt = (n?: number) => n !== undefined ? `£${n.toLocaleString()}` : '—';
  const variance = (t?: number, e?: number) => t && e ? ((t - e) / e * 100).toFixed(1) : null;

  return <div className="panel">
    <h3>Add Tenderer</h3>
    <form className="inline-form" onSubmit={(ev) => { ev.preventDefault(); if (name.trim()) add.mutate(); }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tenderer name" required />
      <input type="number" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder="Tendered sum £" />
      <input type="number" value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="Estimate £" />
      <input value={recommendation} onChange={(e) => setRecommendation(e.target.value)} placeholder="Recommendation" />
      <button disabled={add.isPending}>Add</button>
    </form>
    <ErrorMessage error={add.error} />
    {rows.isLoading ? <Busy /> : <table className="data-table" style={{ marginTop: 16 }}>
      <thead><tr><th>Tenderer</th><th>Tendered Sum</th><th>Estimate</th><th>Variance</th><th>Recommendation</th></tr></thead>
      <tbody>{(rows.data as TenderComparative[])?.map((r) => {
        const v = variance(r.tendered_sum ?? undefined, r.estimate_sum ?? undefined);
        return <tr key={r.id}>
          <td><strong>{r.tenderer_name}</strong></td>
          <td>{fmt(r.tendered_sum ?? undefined)}</td>
          <td>{fmt(r.estimate_sum ?? undefined)}</td>
          <td className={v ? (parseFloat(v) > 5 ? 'text-red' : parseFloat(v) < -5 ? 'text-green' : '') : ''}>{v ? `${v}%` : '—'}</td>
          <td>{r.recommendation ?? '—'}</td>
        </tr>;
      })}
      {rows.data?.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: '1.5rem' }}>No comparative data entered.</td></tr>}
      </tbody>
    </table>}
  </div>;
}

// ── Step 7: Tender Submission ─────────────────────────────────────────────

function Step7Submission({ workflowId }: { workflowId: string }) {
  const queryClient = useQueryClient();
  const [packages, setPackages] = useState<Array<{ name: string; subCost: string; prelims: string; riskPct: string; marginPct: string }>>([
    { name: '', subCost: '', prelims: '', riskPct: '', marginPct: '' }
  ]);

  const submission = useQuery({ queryKey: ['submission', workflowId], queryFn: () => api.getSubmission(workflowId) });

  const save = useMutation({
    mutationFn: () => {
      const pkgs = packages.map((p) => {
        const sub = Number(p.subCost) || 0;
        const prelims = Number(p.prelims) || 0;
        const risk = Number(p.riskPct) || 0;
        const margin = Number(p.marginPct) || 0;
        const base = sub + prelims;
        const total = base * (1 + risk / 100) * (1 + margin / 100);
        return { name: p.name, sub_cost: sub, prelims, risk_pct: risk, margin_pct: margin, total: Math.round(total) };
      });
      const aggregateTotal = pkgs.reduce((s, p) => s + p.total, 0);
      return api.saveSubmission(workflowId, { packages: pkgs, aggregateTotal });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['submission', workflowId] })
  });

  const approve = useMutation({
    mutationFn: () => api.boardApproveSubmission(workflowId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['submission', workflowId] })
  });

  const addRow = () => setPackages([...packages, { name: '', subCost: '', prelims: '', riskPct: '', marginPct: '' }]);
  const updatePkg = (i: number, field: keyof typeof packages[0], value: string) => {
    setPackages(packages.map((p, idx) => idx === i ? { ...p, [field]: value } : p));
  };

  const sub = submission.data;
  const isApproved = Boolean(sub?.board_approved_at);

  return <div>
    {sub?.board_approved_at && <div className="alert alert-green"><strong>Board Approved</strong> — {new Date(sub.board_approved_at).toLocaleString()}</div>}
    <div className="panel">
      <h3>Cost Build-up</h3>
      <table className="data-table">
        <thead><tr><th>Package</th><th>Sub Cost £</th><th>Prelims £</th><th>Risk %</th><th>Margin %</th><th>Total £</th></tr></thead>
        <tbody>{packages.map((p, i) => {
          const base = (Number(p.subCost) || 0) + (Number(p.prelims) || 0);
          const total = base * (1 + (Number(p.riskPct) || 0) / 100) * (1 + (Number(p.marginPct) || 0) / 100);
          return <tr key={i}>
            <td><input value={p.name} onChange={(e) => updatePkg(i, 'name', e.target.value)} placeholder="Package name" /></td>
            <td><input type="number" value={p.subCost} onChange={(e) => updatePkg(i, 'subCost', e.target.value)} placeholder="0" /></td>
            <td><input type="number" value={p.prelims} onChange={(e) => updatePkg(i, 'prelims', e.target.value)} placeholder="0" /></td>
            <td><input type="number" value={p.riskPct} onChange={(e) => updatePkg(i, 'riskPct', e.target.value)} placeholder="0" /></td>
            <td><input type="number" value={p.marginPct} onChange={(e) => updatePkg(i, 'marginPct', e.target.value)} placeholder="0" /></td>
            <td><strong>{total > 0 ? `£${Math.round(total).toLocaleString()}` : '—'}</strong></td>
          </tr>;
        })}
        </tbody>
        <tfoot>
          <tr><td colSpan={5} style={{ textAlign: 'right', fontWeight: 600, padding: '8px 12px' }}>Aggregate Total</td>
            <td style={{ fontWeight: 700, fontSize: '1rem', padding: '8px 12px' }}>
              £{packages.reduce((s, p) => {
                const base = (Number(p.subCost) || 0) + (Number(p.prelims) || 0);
                return s + base * (1 + (Number(p.riskPct) || 0) / 100) * (1 + (Number(p.marginPct) || 0) / 100);
              }, 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </td>
          </tr>
        </tfoot>
      </table>
      <div className="button-row" style={{ marginTop: 12 }}>
        <button className="secondary small" onClick={addRow}>+ Add package</button>
        <button className="small" onClick={() => save.mutate()} disabled={save.isPending || isApproved}>Save draft</button>
      </div>
      <ErrorMessage error={save.error} />
    </div>
    <div className="panel">
      <h3>Board Approval</h3>
      {isApproved
        ? <p className="muted">Submission approved by Board. Ready for dispatch.</p>
        : <>
          <p className="muted" style={{ marginBottom: 12 }}>Save the cost build-up above, then request Board approval to finalise.</p>
          <button onClick={() => approve.mutate()} disabled={approve.isPending || !sub}>
            {approve.isPending ? 'Submitting…' : 'Request Board Approval'}
          </button>
          <ErrorMessage error={approve.error} />
        </>}
    </div>
  </div>;
}
