import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { Outlet, useNavigate, useParams } from 'react-router-dom';
import { api, type ConfirmIttResult, type IttDispatch, type IttLineSection, type IttPack, type LaunchTableRow, type TakeoffCompletion, type TenderComparative, type TenderPrepWorkflow } from './api';
import { oidc, signIn } from './auth';

function ErrorMessage({ error }: { error: unknown }) {
  return error ? <p className="error">{error instanceof Error ? error.message : 'Something went wrong'}</p> : null;
}
function Busy({ children = 'Loading…' }: { children?: string }) { return <p className="muted">{children}</p>; }

// Parsed Outputs, Employer RFIs and SoA RAG live in the take-off module, not here. A
// completed take-off launches a workflow straight onto Tender Launch Pack.
const STEP_TITLES = ['Tender Launch Pack', 'ITT Dispatch', 'Comparative Analysis', 'Tender Submission'];
const FINAL_STEP = STEP_TITLES.length;

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

// ── PackagesListPage ────────────────────────────────────────────────────────

export function PackagesListPage() {
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api.listWorkflows() });

  if (workflows.isLoading) return <Busy />;

  return <section style={{ padding: 24 }}>
    <h1 style={{ marginBottom: 16 }}>Tender Preparation Packages</h1>
    <ErrorMessage error={workflows.error} />
    {workflows.data && workflows.data.length === 0 && <p className="muted">
      No packages yet. A workflow appears here once a take-off completes for a package, or one is started by hand.
    </p>}
    {workflows.data && workflows.data.length > 0 && <table className="data-table">
      <thead><tr><th>Package</th><th>Step</th><th>Updated</th><th /></tr></thead>
      <tbody>
        {workflows.data.map((wf) => {
          const takeoff = wf.step_data?.takeoff;
          return <tr key={wf.id}>
            <td>{takeoff?.packageName ?? wf.package_id}</td>
            <td>Step {wf.current_step}: {STEP_TITLES[wf.current_step - 1]}</td>
            <td>{new Date(wf.updated_at).toLocaleString()}</td>
            <td><a className="button-link" href={`/packages/${wf.package_id}/tender-prep`}>Open →</a></td>
          </tr>;
        })}
      </tbody>
    </table>}
  </section>;
}

// ── TenderPrepPage ─────────────────────────────────────────────────────────

export function TenderPrepPage() {
  const { packageId = '' } = useParams();
  const queryClient = useQueryClient();

  // A completed take-off launches the workflow with nobody in the app, so the page has
  // to look for one it never started. Polling while none exists means a page left open
  // during a pipeline run picks the launch up on its own.
  const existing = useQuery({
    queryKey: ['workflow-by-package', packageId],
    queryFn: () => api.getWorkflowByPackage(packageId),
    refetchInterval: (query) => (query.state.data ? false : 15_000)
  });

  const createWorkflow = useMutation({
    mutationFn: () => api.createWorkflow(packageId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['workflow-by-package', packageId] })
  });

  const workflowId = existing.data?.id ?? null;

  const advance = useMutation({
    mutationFn: () => api.advanceStep(workflowId!),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['workflow-by-package', packageId] })
  });

  // Steps are freely navigable in both directions. Each step's data is kept
  // independently, so revisiting the Tender Launch Pack to revise a shortlist loses
  // nothing downstream.
  const goToStep = useMutation({
    mutationFn: (step: number) => api.setStep(workflowId!, step),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['workflow-by-package', packageId] })
  });

  if (existing.isLoading) return <Busy />;

  if (!workflowId) {
    return <section className="centered">
      <h1>Tender Preparation</h1>
      <p className="muted">Package: {packageId}</p>
      <p style={{ marginBottom: 16 }}>
        Tender preparation starts on its own once the take-off for this package completes.
        Start it now to work ahead of that.
      </p>
      <ErrorMessage error={existing.error} />
      <ErrorMessage error={createWorkflow.error} />
      <button onClick={() => createWorkflow.mutate()} disabled={createWorkflow.isPending}>
        {createWorkflow.isPending ? 'Starting…' : 'Start Tender Preparation →'}
      </button>
    </section>;
  }

  const wf = existing.data as TenderPrepWorkflow;
  const currentStep = wf.current_step;
  const takeoff = wf.step_data?.takeoff;

  return <div className="wizard-layout">
    <aside className="wizard-sidebar">
      <h3>Tender Preparation</h3>
      <ul className="step-list">
        {STEP_TITLES.map((title, i) => {
          const stepNum = i + 1;
          const done = stepNum < currentStep;
          const active = stepNum === currentStep;
          return <li key={stepNum} className={`step-item ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
            <button
              className="step-jump"
              disabled={active || goToStep.isPending}
              onClick={() => goToStep.mutate(stepNum)}
              title={active ? 'Current step' : `Go to ${title}`}>
              <span className="step-num">{done ? '✓' : stepNum}</span>
              <span className="step-title">{title}</span>
            </button>
          </li>;
        })}
      </ul>
    </aside>

    <section className="wizard-content">
      <div className="step-header">
        <h2>Step {currentStep}: {STEP_TITLES[currentStep - 1]}</h2>
        <div className="button-row">
          {currentStep > 1 && <button className="secondary small" onClick={() => goToStep.mutate(currentStep - 1)} disabled={goToStep.isPending}>
            ← Back: {STEP_TITLES[currentStep - 2]}
          </button>}
          {currentStep < FINAL_STEP && <button className="secondary small" onClick={() => advance.mutate()} disabled={advance.isPending}>
            Next: {STEP_TITLES[currentStep]} →
          </button>}
        </div>
      </div>
      <ErrorMessage error={advance.error} />
      <ErrorMessage error={goToStep.error} />

      {currentStep === 1 && takeoff && <TakeoffSummary takeoff={takeoff} packageId={packageId} />}
      {currentStep === 1 && <Step1TenderLaunchPack workflowId={workflowId} />}
      {currentStep === 2 && <Step2IttDispatch workflowId={workflowId} />}
      {currentStep === 3 && <Step3Comparative workflowId={workflowId} />}
      {currentStep === 4 && <Step4Submission workflowId={workflowId} />}
    </section>
  </div>;
}

// ── Step 1: Tender Launch Pack ─────────────────────────────────────────────

/**
 * Where this workflow came from. Shown only when the take-off launched it — a workflow
 * started by hand carries no `step_data.takeoff`. The numbers are BuildFlow's, reported
 * as at the moment it published, so the back-link is how you get the live view.
 */
function TakeoffSummary({ takeoff, packageId }: { takeoff: TakeoffCompletion; packageId: string }) {
  const mainAppUrl = import.meta.env.VITE_MAIN_APP_URL ?? 'http://localhost:5173';
  const gifa = takeoff.gifaM2 == null ? null : Number(takeoff.gifaM2);
  return <div className="panel">
    <h3>Launched from take-off</h3>
    <div className="info-row">
      <div className="info-item">
        <span className="info-label">Tender</span>
        {takeoff.tenderName ?? <span className="muted">not assigned to a tender</span>}
        {takeoff.tenderReference && <> · <code>{takeoff.tenderReference}</code></>}
      </div>
      <div className="info-item">
        <span className="info-label">Package</span>
        {takeoff.packageName ?? packageId}
        {takeoff.versionNumber != null && <> · v{takeoff.versionNumber}.{takeoff.revision ?? 1}</>}
      </div>
      <div className="info-item"><span className="info-label">Take-off</span><code>{takeoff.takeoffId}</code></div>
      {takeoff.itemCount != null && <div className="info-item"><span className="info-label">Items</span>{takeoff.itemCount}</div>}
      {gifa != null && Number.isFinite(gifa) && <div className="info-item"><span className="info-label">GIFA</span>{gifa.toLocaleString()} m²</div>}
    </div>
    <p style={{ marginTop: 12 }}>
      <a href={`${mainAppUrl}/packages/${packageId}`} target="_blank" rel="noreferrer" className="button-link">
        View the take-off in BuildFlow →
      </a>
    </p>
  </div>;
}


// ── Step 1: Tender Launch Pack ────────────────────────────────────────────
//
// The client's agreed package breakdown, in their own order, one row per package. The
// suggested firms sit inside the row rather than exploding it, so the numbering stays 1..N
// and reads as the project breakdown it is.

/**
 * One package. Selection is held locally until saved, so management can work down the
 * table during the meeting and commit a package once, rather than firing a write per tick.
 */
function PackageRow({ row, workflowId }: { row: LaunchTableRow; workflowId: string }) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(row.subcontractors.filter((s) => s.selected).map((s) => s.subcontractor_id))
  );
  const [notes, setNotes] = useState(row.board_override_notes ?? '');
  const [open, setOpen] = useState(true);
  // The route is chosen the same way the subcontractors are: offered, then picked.
  const [route, setRoute] = useState(row.route_of_procurement);
  const [splitting, setSplitting] = useState(false);
  const [splitNames, setSplitNames] = useState('');

  const split = useMutation({
    mutationFn: () => api.splitPackage(row.package_config_id,
      splitNames.split(/[,\n]/).map((n) => n.trim()).filter(Boolean).map((n) => ({ name: n }))),
    onSuccess: () => { setSplitting(false); setSplitNames(''); void queryClient.invalidateQueries({ queryKey: ['launch-table', workflowId] }); }
  });
  const unsplit = useMutation({
    mutationFn: () => api.unsplitPackage(row.package_config_id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['launch-table', workflowId] })
  });

  const save = useMutation({
    mutationFn: () => api.savePackageSelection(workflowId, {
      packageName: row.package_name,
      packageSeq: row.seq,
      routeOfProcurement: route,
      boardOverrideNotes: notes.trim() || undefined,
      // Everything shown, not just the ticks — the record has to answer "who was
      // considered", not only "who was chosen".
      entries: row.subcontractors
        .filter((s) => !s.off_register)
        .map((s, i) => ({
          subcontractorId: s.subcontractor_id,
          rank: i + 1,
          selected: picked.has(s.subcontractor_id),
          suggestionReason: s.suggestion_reason,
          performanceScore: s.performance_score != null ? Number(s.performance_score) : undefined,
          complianceFlags: s.compliance_flags
        }))
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['launch-table', workflowId] })
  });

  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const dirty = (() => {
    const saved = new Set(row.subcontractors.filter((s) => s.selected).map((s) => s.subcontractor_id));
    if (saved.size !== picked.size) return true;
    for (const id of picked) if (!saved.has(id)) return true;
    if (route !== row.route_of_procurement) return true;
    return notes.trim() !== (row.board_override_notes ?? '').trim();
  })();

  return <tr className={`pkg-row ${row.is_heading ? 'pkg-heading' : ''} ${row.is_sub_package ? 'pkg-child' : ''}`}>
    <td className="pkg-seq">{row.display_ref}</td>
    <td className="pkg-name">
      <strong>{row.package_name}</strong>
      {row.is_heading && <span className="badge badge-grey">broken down</span>}
      {row.stranded_bill_lines > 0 && <div className="alert alert-red tiny" style={{ marginTop: 6 }}>
        {row.stranded_bill_lines} priced items sit on this heading and will not be tendered. Move them onto the sub-packages.
      </div>}
      {row.notes && <div className="muted pkg-note">{row.notes}</div>}
      {!row.is_heading && <button className="link-toggle" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : `Show ${row.subcontractors.length}`} subcontractors
      </button>}
      {/* Splitting is only offered on a top-level package: a breakdown is one level deep. */}
      {!row.is_sub_package && (row.is_heading
        ? <button className="link-toggle" onClick={() => unsplit.mutate()} disabled={unsplit.isPending}>
            Undo breakdown
          </button>
        : <button className="link-toggle" onClick={() => setSplitting(!splitting)}>
            {splitting ? 'Cancel' : 'Break down…'}
          </button>)}
      {splitting && <div className="split-box">
        <input
          value={splitNames}
          onChange={(e) => setSplitNames(e.target.value)}
          placeholder="Mechanical, Electrical, Plumbing"
        />
        <div className="muted tiny">Comma-separated. Each becomes its own tendered package.</div>
        <button className="small" onClick={() => split.mutate()}
                disabled={split.isPending || splitNames.split(/[,\n]/).filter((n) => n.trim()).length < 2}>
          {split.isPending ? 'Splitting…' : 'Create sub-packages'}
        </button>
        <ErrorMessage error={split.error} />
      </div>}
    </td>
    <td>
      {row.is_heading
        ? <span className="muted tiny">—</span>
        : <>
            <select className="route-select" value={route} onChange={(e) => setRoute(e.target.value)}>
              {(row.route_options.includes(route) ? row.route_options : [route, ...row.route_options])
                .map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            {route !== row.configured_route &&
              <div className="muted tiny">was “{row.configured_route}”</div>}
          </>}
    </td>
    <td className="pkg-subs">
      {row.is_heading
        ? <p className="muted tiny">Tendered as its sub-packages below.</p>
        : null}
      {row.is_heading ? null : row.subcontractors.length === 0
        ? <p className="muted">No firms in the register match {row.trade_terms.map((t) => `“${t}”`).join(', ')}.</p>
        : open && <>
          <table className="sub-table">
            <thead>
              <tr>
                <th style={{ width: '2rem' }}>Invite</th>
                <th>Subcontractor</th>
                <th>USP</th>
                <th>Contact</th>
                <th>Why suggested</th>
              </tr>
            </thead>
            <tbody>
              {row.subcontractors.map((s) => <tr key={s.subcontractor_id} className={s.off_register ? 'off-register' : s.is_placeholder ? 'placeholder-row' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={picked.has(s.subcontractor_id)}
                    disabled={s.off_register || Boolean(s.is_placeholder)}
                    onChange={() => toggle(s.subcontractor_id)}
                  />
                </td>
                <td>
                  <span className="sub-name">{s.name}</span>
                  {s.trading_as && <div className="muted tiny">t/a {s.trading_as}</div>}
                  {s.website && <div className="tiny"><a href={s.website} target="_blank" rel="noreferrer">website</a></div>}
                </td>
                <td className="tiny">{s.usp}</td>
                <td className="tiny">
                  {s.contact_name
                    ? <>
                        <div>{s.contact_name}{s.contact_role && <span className="muted"> · {s.contact_role.replace('_', '-')}</span>}</div>
                        {s.contact_email && <div><a href={`mailto:${s.contact_email}`}>{s.contact_email}</a></div>}
                        {s.contact_phone && <div className="muted">{s.contact_phone}</div>}
                      </>
                    : <span className="muted">No contact on file</span>}
                </td>
                <td className="tiny muted">{s.suggestion_reason}</td>
              </tr>)}
            </tbody>
          </table>
          <div className="pkg-actions">
            <input
              className="pkg-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Meeting notes / override reason (optional)…"
            />
            <span className="muted">{picked.size} selected</span>
            <button className="small" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending ? 'Saving…' : row.confirmed_at ? 'Update' : 'Confirm'}
            </button>
            {row.confirmed_at && !dirty && <span className="badge badge-green">Confirmed</span>}
          </div>
          <ErrorMessage error={save.error} />
        </>}
    </td>
  </tr>;
}

function Step1TenderLaunchPack({ workflowId }: { workflowId: string }) {
  const table = useQuery({
    queryKey: ['launch-table', workflowId],
    queryFn: () => api.getLaunchTable(workflowId)
  });

  if (table.isLoading) return <Busy />;
  if (table.error) return <ErrorMessage error={table.error} />;

  const rows = table.data ?? [];
  if (rows.length === 0) {
    return <div className="panel">
      <h3>No package breakdown configured</h3>
      <p className="muted">
        The Tender Launch Pack works through the package list agreed with the client when the
        project is set up. Nothing is configured for this project or as an organisation
        default, so there is nothing to tender yet.
      </p>
      <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>
        Configure it via <code>PUT /api/tender-prep/config/packages</code>.
      </p>
    </div>;
  }

  const totalSelected = rows.reduce((n, r) => n + r.subcontractors.filter((s) => s.selected).length, 0);
  const confirmed = rows.filter((r) => r.confirmed_at).length;

  return <div className="panel">
    <div className="shortlist-header">
      <h3>Tender Launch</h3>
      <span className="muted">{confirmed} of {rows.length} packages confirmed · {totalSelected} subcontractors selected</span>
    </div>
    <p className="muted" style={{ marginBottom: 12 }}>
      Suggestions are read live from the supply chain register. Tick the firms to invite —
      only those receive an ITT at Step 2.
    </p>
    <div className="table-scroll">
      <table className="data-table launch-table">
        <thead>
          <tr>
            <th style={{ width: '3rem' }}>#</th>
            <th style={{ width: '16rem' }}>Package</th>
            <th style={{ width: '11rem' }}>Route of Procurement</th>
            <th>Subcontractors · invite and why suggested</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <PackageRow key={row.display_ref} row={row} workflowId={workflowId} />)}
        </tbody>
      </table>
    </div>
  </div>;
}

// ── Step 2: ITT Dispatch ──────────────────────────────────────────────────

// ── Step 2: ITT Dispatch ──────────────────────────────────────────────────
//
// One ITT per trade package, assembled server-side from the live project data. Nothing is
// sent from here: these are the packs as they would go out, for review first.

/**
 * Checkbox for excluding one ITT line from what gets emailed, without touching the
 * underlying source data. Fires immediately on click — there is no separate save step, so
 * the pack is refetched on success rather than staged locally.
 */
function IgnoreToggle({ workflowId, packageName, section, itemId, ignored, label = 'Ignore for ITT' }: {
  workflowId: string; packageName: string; section: IttLineSection; itemId: string; ignored: boolean; label?: string;
}) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.setIttLineOverride(workflowId, packageName, { section, itemId, ignored: next }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['itt-pack', workflowId, packageName] })
  });
  return <label className="tiny muted" style={{ whiteSpace: 'nowrap' }}>
    <input type="checkbox" checked={ignored} disabled={toggle.isPending}
      onChange={(e) => toggle.mutate(e.target.checked)} />
    {' '}{label}
  </label>;
}

function DocSchedule({ docs, workflowId, packageName }: { docs: IttPack['documents']; workflowId: string; packageName: string }) {
  const groups = docs.reduce<Record<string, IttPack['documents']>>((acc, d) => {
    (acc[d.doc_type] ??= []).push(d);
    return acc;
  }, {});
  const label = (t: string) => t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return <>{Object.entries(groups).map(([type, items]) => <details key={type} className="doc-group">
    <summary><strong>{label(type)}</strong> <span className="muted">({items.length})</span></summary>
    <ul className="doc-list">
      {items.map((d) => <li key={d.filename} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
        <span style={d.ignored ? { textDecoration: 'line-through', color: 'var(--muted, #888)' } : undefined}>
          {d.filename}{d.page_count > 0 && <span className="muted"> · {d.page_count} pp</span>}
        </span>
        <IgnoreToggle workflowId={workflowId} packageName={packageName} section="document" itemId={d.id} ignored={d.ignored} />
      </li>)}
    </ul>
  </details>)}</>;
}

function IttPackView({ pack, workflowId, packageName }: { pack: IttPack; workflowId: string; packageName: string }) {
  const t = pack.takeoff as Record<string, string | number | null>;
  return <div className="itt-pack">
    {pack.review_notes.length > 0 && <div className="alert alert-red">
      <strong>Not ready to issue:</strong>
      <ul style={{ margin: '4px 0 0 18px' }}>{pack.review_notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>}

    <div className="info-row">
      <div className="info-item"><span className="info-label">ITT reference</span>
        <code>ITT-{String(t.projectName ?? 'PROJECT').toUpperCase()}-{pack.display_ref}</code></div>
      <div className="info-item"><span className="info-label">Route of procurement</span>{pack.route_of_procurement}</div>
      <div className="info-item"><span className="info-label">Take-off</span><code>{String(t.takeoffId ?? '—')}</code></div>
      <div className="info-item"><span className="info-label">BoQ</span><code>{pack.boq_id ?? '—'}</code></div>
    </div>

    <h4>1. Tender return — what a compliant submission must contain</h4>
    <p className="muted tiny">Evaluation is based on these. A return missing a required item is not compliant.</p>
    <table className="data-table">
      <thead><tr><th style={{ width: '2rem' }}>#</th><th>Form</th><th>Detail</th><th>Required</th><th>Ignore for ITT</th></tr></thead>
      <tbody>{pack.return_forms.map((f) => <tr key={f.id} className={f.ignored ? 'scope-only' : ''}>
        <td className="tiny">{f.seq}</td>
        <td className="tiny"><strong>{f.name}</strong></td>
        <td className="tiny muted">{f.description ?? '—'}</td>
        <td>{f.is_required
          ? <span className="badge badge-red">Required</span>
          : <span className="badge badge-grey">Optional</span>}</td>
        <td><IgnoreToggle workflowId={workflowId} packageName={packageName} section="return_form" itemId={f.id} ignored={f.ignored} label="" /></td>
      </tr>)}</tbody>
    </table>

    <h4>1b. Recipients</h4>
    <p className="muted tiny">The firms selected at the tender launch meeting. Use "Confirm ITT" below to email them.</p>
    <table className="data-table">
      <thead><tr><th>Rank</th><th>Subcontractor</th><th>Why selected</th></tr></thead>
      <tbody>{pack.recipients.map((r) => <tr key={r.subcontractor_id}>
        <td>#{r.rank}</td>
        <td><code className="tiny">{r.subcontractor_id}</code></td>
        <td className="tiny muted">{r.suggestion_reason ?? '—'}</td>
      </tr>)}</tbody>
    </table>

    <h4>2. Scope and Bill of Quantities</h4>
    <p className="muted tiny">
      {pack.boq_summary.total} lines attributed by NRM classification — {pack.boq_summary.priceable} with
      measured quantities, {pack.boq_summary.scope_only} carrying scope without a quantity.
      Rates are omitted deliberately: each tenderer prices independently.
    </p>
    <div className="table-scroll">
      <table className="data-table itt-boq">
        <thead><tr><th>GE</th><th>Element</th><th>Description</th><th>Qty</th><th>Unit</th><th>Rate £</th><th>Ignore for ITT</th></tr></thead>
        <tbody>{pack.boq_lines.map((l) => <tr key={l.id} className={l.is_priceable ? '' : 'scope-only'}>
          <td className="tiny">{l.ge_code}</td>
          <td className="tiny">{l.element_code ?? '—'}</td>
          <td className="tiny">{l.description}</td>
          <td className="tiny" style={{ textAlign: 'right' }}>
            {l.is_priceable ? Number(l.quantity).toLocaleString() : <span className="muted">scope</span>}
          </td>
          <td className="tiny">{l.unit ?? ''}</td>
          <td className="tiny muted" style={{ textAlign: 'right' }}>to be priced</td>
          <td><IgnoreToggle workflowId={workflowId} packageName={packageName} section="boq_line" itemId={l.id} ignored={l.ignored} label="" /></td>
        </tr>)}
        {pack.boq_lines.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: '1rem' }}>
          No measured lines attributed to this package.
        </td></tr>}
        </tbody>
      </table>
    </div>

    {pack.bill_lines.length > 0 && <>
      <h4>2b. Schedule of items to be priced</h4>
      <p className="muted tiny">
        {pack.bill_lines.length} authored lines. These are not measured from the take-off —
        surveys and staged fees have no quantity behind them — so each is priced as stated.
      </p>
      <div className="table-scroll">
        <table className="data-table itt-boq">
          <thead><tr><th>Ref</th><th>Item</th><th>Required for</th><th>Qty</th><th>Unit</th><th>Rate £</th><th>Ignore for ITT</th></tr></thead>
          <tbody>{pack.bill_lines.map((l, i, all) => <>
            {(i === 0 || all[i - 1].section !== l.section) && l.section &&
              <tr key={`s-${l.seq}`} className="bill-section"><td colSpan={7}><strong>{l.section}</strong></td></tr>}
            <tr key={l.id}>
              <td className="tiny">{l.ref ?? l.seq}</td>
              <td className="tiny">{l.description}{l.notes && <div className="muted">{l.notes}</div>}</td>
              <td className="tiny">{l.required_for ?? '—'}</td>
              <td className="tiny" style={{ textAlign: 'right' }}>{l.quantity ? Number(l.quantity).toLocaleString() : ''}</td>
              <td className="tiny">{l.unit}</td>
              <td className="tiny muted" style={{ textAlign: 'right' }}>to be priced</td>
              <td><IgnoreToggle workflowId={workflowId} packageName={packageName} section="bill_line" itemId={l.id} ignored={l.ignored} label="" /></td>
            </tr>
          </>)}</tbody>
        </table>
      </div>
    </>}

    <h4>2c. Scope of works matrix</h4>
    <p className="muted tiny">
      What the subcontractor carries around the measured bill — {pack.scope_summary.total} items:
      {' '}{pack.scope_summary.package_specific} specific to this package, {pack.scope_summary.general} general.
      {' '}<strong>{pack.scope_summary.contract}</strong> are Contract items to be priced;
      {' '}<strong>{pack.scope_summary.profit_plan}</strong> are Profit Plan and must <em>not</em> be priced by the tenderer.
    </p>
    {pack.scope_items.length === 0
      ? <p className="muted tiny">No scope items for this package.</p>
      : <details className="doc-group">
          <summary><strong>Show {pack.scope_items.length} scope items</strong></summary>
          <div className="table-scroll">
            <table className="data-table itt-boq">
              <thead><tr><th>Ref</th><th>Item</th><th>Designation</th><th>Cost basis</th><th>Ignore for ITT</th></tr></thead>
              <tbody>{pack.scope_items.map((s) => <tr key={s.id} className={s.procurement_stage === 'Profit Plan' ? 'scope-only' : ''}>
                <td className="tiny">{s.ref}</td>
                <td className="tiny">{s.description}</td>
                <td className="tiny">{s.designation ?? '—'}</td>
                <td className="tiny">{s.procurement_stage
                  ? <span className={`badge badge-${s.procurement_stage === 'Contract' ? 'blue' : 'amber'}`}>{s.procurement_stage}</span>
                  : '—'}</td>
                <td><IgnoreToggle workflowId={workflowId} packageName={packageName} section="scope_item" itemId={s.id} ignored={s.ignored} label="" /></td>
              </tr>)}</tbody>
            </table>
          </div>
        </details>}

    <h4>3. Documents issued</h4>
    <p className="muted tiny">
      All {pack.documents.length} tender documents are issued with every package — an Employer's
      Requirement binds the subcontractor whether or not its filename mentions their trade.
    </p>
    <DocSchedule docs={pack.documents} workflowId={workflowId} packageName={packageName} />

    <h4>4. Schedule of attendances</h4>
    <p className="muted tiny">
      Who provides what. <strong>SC</strong> subcontractor · <strong>H</strong> main contractor ·
      <strong> J</strong> joint · <strong>N/A</strong> not available.
      {' '}{pack.attendance_summary.subcontractor} carried by the subcontractor,
      {' '}{pack.attendance_summary.main_contractor} by the main contractor.
    </p>
    {pack.attendances.length === 0
      ? <p className="muted tiny">No schedule configured.</p>
      : <div className="table-scroll">
          <table className="data-table itt-boq">
            <thead><tr><th>Group</th><th>Attendance / responsibility</th><th>Owner</th><th>Notes</th></tr></thead>
            <tbody>{pack.attendances.map((a, i, all) => <tr key={a.seq}>
              <td className="tiny">{i === 0 || all[i - 1].group_name !== a.group_name ? <strong>{a.group_name}</strong> : ''}</td>
              <td className="tiny">{a.description}</td>
              <td><span className={`badge badge-${a.owner === 'SC' ? 'amber' : a.owner === 'H' ? 'green' : a.owner === 'J' ? 'blue' : 'grey'}`}>{a.owner}</span></td>
              <td className="tiny muted">{a.notes ?? ''}</td>
            </tr>)}</tbody>
          </table>
        </div>}

    <h4>5. Terms of employment — for information only</h4>
    <p className="muted tiny">
      The form of subcontract and draft pre-contract minutes are issued so a tenderer knows
      what they would be signing up to if successful. They are <strong>not</strong> priced against
      and are not a returnable.
    </p>
    {pack.precontract_minutes
      ? <div className="info-row">
          <div className="info-item"><span className="info-label">Form of subcontract</span>{pack.precontract_minutes.form_of_subcontract ?? '—'}</div>
          <div className="info-item"><span className="info-label">Type</span>{pack.precontract_minutes.subcontract_type ?? '—'}</div>
          <div className="info-item"><span className="info-label">Executed</span>{pack.precontract_minutes.executed_as ?? '—'}</div>
          <div className="info-item"><span className="info-label">Status</span>
            <span className="badge badge-grey">{pack.precontract_minutes.status.replace(/_/g, ' ')}</span></div>
        </div>
      : <p className="muted tiny">No draft minutes — the tenderer would be pricing without the terms of employment.</p>}

    <h4>6. Value Engineering</h4>
    <div className="alert alert-grey">
      <strong>Mandatory.</strong> Every tenderer must submit at least one Value Engineering
      proposal stating the saving, the programme effect, any departure from the specification
      and the Employer's Requirements clause affected. A return without one is not compliant.
    </div>
  </div>;
}

function Step2IttDispatch({ workflowId }: { workflowId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ConfirmIttResult | null>(null);
  const queryClient = useQueryClient();
  const itts = useQuery({ queryKey: ['itts', workflowId], queryFn: () => api.listItts(workflowId) });
  const pack = useQuery({
    queryKey: ['itt-pack', workflowId, open],
    queryFn: () => api.getIttPack(workflowId, open!),
    enabled: Boolean(open)
  });
  const confirm = useMutation({
    mutationFn: (packageName: string) => api.confirmItt(workflowId, packageName),
    onSuccess: (result) => {
      setLastResult(result);
      void queryClient.invalidateQueries({ queryKey: ['itts', workflowId] });
    }
  });

  if (itts.isLoading) return <Busy />;
  if (itts.error) return <ErrorMessage error={itts.error} />;
  const rows = itts.data ?? [];

  if (rows.length === 0) {
    return <div className="panel">
      <h3>No ITTs yet</h3>
      <p className="muted">
        An ITT is built for each package once the tender launch meeting has selected the firms
        to invite. Go back to the Tender Launch Pack, tick the subcontractors for a package and
        confirm it.
      </p>
    </div>;
  }

  return <div className="panel">
    <div className="shortlist-header">
      <h3>Invitations to Tender</h3>
      <span className="muted">{rows.length} package{rows.length === 1 ? '' : 's'} · {rows.reduce((n, r) => n + Number(r.recipients), 0)} recipients</span>
    </div>
    <p className="muted" style={{ marginBottom: 12 }}>
      Built from the live take-off, package configuration and document set. Review below —
      untick anything that should not go out under "Ignore for ITT" — then confirm to email
      the selected subcontractors.
    </p>
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>#</th><th>Package</th><th>Route of Procurement</th><th>Recipients</th><th>Status</th><th></th><th></th></tr></thead>
        <tbody>{rows.map((r) => <>
          <tr key={r.package_name}>
            <td>{r.package_seq ?? '—'}</td>
            <td><strong>{r.package_name}</strong></td>
            <td className="tiny">{r.route_of_procurement ?? '—'}</td>
            <td>{r.recipients}</td>
            <td>
              {Number(r.sent) > 0 && <span className="badge badge-green">sent {r.sent}</span>}
              {' '}{Number(r.failed) > 0 && <span className="badge badge-red">failed {r.failed}</span>}
              {' '}{Number(r.skipped_no_email) > 0 && <span className="badge badge-amber">no email {r.skipped_no_email}</span>}
              {Number(r.sent) === 0 && Number(r.failed) === 0 && Number(r.skipped_no_email) === 0 &&
                <span className="badge badge-grey">not sent</span>}
            </td>
            <td>
              <button className="small secondary" onClick={() => setOpen(open === r.package_name ? null : r.package_name)}>
                {open === r.package_name ? 'Close' : 'View ITT'}
              </button>
            </td>
            <td>
              <button
                className="small"
                disabled={!r.confirmed_at || Number(r.recipients) === 0 || (confirm.isPending && confirm.variables === r.package_name)}
                title={!r.confirmed_at ? 'Confirm the package at Step 1 first' : undefined}
                onClick={() => confirm.mutate(r.package_name)}
              >
                {confirm.isPending && confirm.variables === r.package_name ? 'Sending…' : Number(r.dispatched) > 0 ? 'Resend ITT' : 'Confirm ITT'}
              </button>
            </td>
          </tr>
          {lastResult && lastResult.package_name === r.package_name && <tr key={`${r.package_name}-result`}>
            <td colSpan={7}>
              <div className={`alert ${lastResult.failed > 0 ? 'alert-red' : 'alert-green'}`} style={{ marginTop: 0 }}>
                Sent {lastResult.sent}, failed {lastResult.failed}, no email on file {lastResult.skipped_no_email}.
                {lastResult.failed > 0 && ' Check the recipients below and try again.'}
              </div>
            </td>
          </tr>}
          {open === r.package_name && <tr key={`${r.package_name}-pack`}>
            <td colSpan={7} className="itt-cell">
              {pack.isLoading ? <Busy /> : pack.error ? <ErrorMessage error={pack.error} />
                : pack.data ? <IttPackView pack={pack.data} workflowId={workflowId} packageName={r.package_name} /> : null}
            </td>
          </tr>}
        </>)}</tbody>
      </table>
    </div>
  </div>;
}


// ── Step 3: Comparative Analysis ──────────────────────────────────────────

function Step3Comparative({ workflowId }: { workflowId: string }) {
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

// ── Step 4: Tender Submission ─────────────────────────────────────────────

function Step4Submission({ workflowId }: { workflowId: string }) {
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
