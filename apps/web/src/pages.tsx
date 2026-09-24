import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, FormEvent, useEffect, useState } from 'react';
import { Link, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, TENDER_RETURN_MAX, type ConfirmIttResult, type IttDispatch, type IttLetterDetailsInput, type IttLineSection, type IttPack, type LaunchTableRow, type PortalResponseSummary, type SendAllIttsResult, type SendIttDraftResult, type TakeoffCompletion, type TenderComparative, type TenderPrepWorkflow, type TenderReturnUnit } from './api';
import { oidc, signIn } from './auth';
import { CommsModal } from './comms';
import { NotificationBell } from './notifications';
import { AddendaButton } from './addendum';

export function ErrorMessage({ error }: { error: unknown }) {
  return error ? <p className="error">{error instanceof Error ? error.message : 'Something went wrong'}</p> : null;
}
export function Busy({ children = 'Loading…' }: { children?: string }) { return <p className="muted">{children}</p>; }

// Parsed Outputs, Employer RFIs and SoA RAG live in the take-off module, not here. A
// completed take-off launches a workflow straight onto Tender Launch Pack.
const STEP_TITLES = ['Tender Launch Pack', 'ITT Dispatch', 'Comparative Analysis', 'Tender Submission'];
const FINAL_STEP = STEP_TITLES.length;

// ── AppShell ───────────────────────────────────────────────────────────────

export function AppShell() {
  const [signingIn, setSigningIn] = useState(false);
  // Issue #37. `retry: false` because a 401 here is an answer, not a failure — somebody
  // reached TPS without a session, and asking again does not change that.
  //
  // The response is checked for a LEVEL rather than trusted for being present. A body
  // that is not a session — `[]` from a stub, an HTML error page from a proxy, a shape
  // from a future version — is still truthy, and `authorisationLevel.toLowerCase()` on
  // it throws during render, which white-screens the whole shell rather than losing one
  // badge. Anything without a level reads as "no session", which is the safe direction.
  const sessionQuery = useQuery({ queryKey: ['session'], queryFn: () => api.session(), retry: false });
  const session = typeof sessionQuery.data?.authorisationLevel === 'string' ? sessionQuery.data : undefined;
  return <main className="shell">
    <header>
      <Link to="/" className="brand">BuildFlow</Link>
      <span className="header-sub">Tender Preparation</span>
      {/* One element claims the auto margin, not each control: `.link-button` sets
          margin-left:auto, so two of them split the free space and leave a gap. */}
      <nav className="header-nav">
        {/* On every page, because a subcontractor's query is not about the page you
            happen to be on. */}
        <NotificationBell />
        {/* The level is shown, not merely held: somebody whose send button refuses them
            needs to see why without asking. There is no sign-out here — BuildFlow owns
            the session, and a button that ended it from this shell would leave the other
            one holding a token it thinks is live. */}
        {session && <span className="session-identity" title={`Authorisation level ${session.authorisationLevel}`}>
          {session.displayName ?? session.email}
          <span className={`level-badge level-${session.authorisationLevel.toLowerCase()}`}>
            {session.authorisationLevel}
          </span>
        </span>}
        {oidc && !session && <button className="link-button" disabled={signingIn} onClick={() => { setSigningIn(true); void signIn(); }}>Sign in</button>}
      </nav>
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
            <td><Link className="button-link" to={`/packages/${wf.package_id}/tender-prep`}>Open →</Link></td>
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
  // Where a notification lands. `?thread=` rather than `?step=`, because the destination
  // is a conversation and the step is only where that conversation is read.
  const [searchParams] = useSearchParams();
  const deepLinkThreadId = searchParams.get('thread');
  // Where the dashboard's "drafts waiting" badge lands (issue #48) — the same
  // Communications modal, opened straight onto its fourth tab.
  const openRfi = searchParams.get('rfi') === '1';
  // Where an `addendum_approval_required` notification lands (tenderPrepDb.ts's
  // addendumDeepLink) — opens the Addenda modal on that addendum directly.
  const deepLinkAddendumId = searchParams.get('addendum');

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

  // A notification points at a conversation, and that conversation is read on Step 2.
  // Moving the cursor is not a side effect anybody loses work to — the steps are freely
  // navigable in both directions and each keeps its data independently — and landing on
  // Step 4 with a Communications modal over it would be the stranger thing to do.
  const stepNow = existing.data?.current_step;
  useEffect(() => {
    if ((!deepLinkThreadId && !openRfi) || !workflowId || stepNow == null || stepNow === 2) return;
    goToStep.mutate(2);
    // Keyed on the thread and the step alone. Including the mutation would re-run this
    // every time its own state changed, which is once per click of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkThreadId, openRfi, workflowId, stepNow]);

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
          {/* Not scoped to one step — an addendum can be raised any time after ITTs are
              out, and a subcontractor's revision has nothing to do with which step the
              estimator happens to be looking at. */}
          <AddendaButton workflowId={workflowId} initialAddendumId={deepLinkAddendumId} />
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
      {currentStep === 2 && <Step2IttDispatch workflowId={workflowId} initialThreadId={deepLinkThreadId} openRfi={openRfi} />}
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
// and reads as the tender breakdown it is.

/**
 * One package. Selection is held locally until saved, so management can work down the
 * table during the meeting and commit a package once, rather than firing a write per tick.
 */
export function PackageRow({ row, workflowId }: { row: LaunchTableRow; workflowId: string }) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(row.subcontractors.filter((s) => s.selected).map((s) => s.subcontractor_id))
  );
  const [notes, setNotes] = useState(row.board_override_notes ?? '');
  const [open, setOpen] = useState(true);
  // The route is chosen the same way the subcontractors are: offered, then picked.
  const [route, setRoute] = useState(row.route_of_procurement);
  // How long this package is tendered for. The value is held as a STRING, because an empty
  // box is the only way to say "not decided" — and because the unit picker is never empty,
  // "a unit with no number" cannot be expressed at all, which is the pairing rule the
  // database enforces, made structural in the UI rather than validated.
  const [periodValue, setPeriodValue] = useState(row.tender_return_period_value?.toString() ?? '');
  const [periodUnit, setPeriodUnit] = useState<TenderReturnUnit>(row.tender_return_period_unit ?? 'weeks');
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
      tenderReturnPeriod: periodNumber === null ? null : { value: periodNumber, unit: periodUnit },
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

  // Mirrors TENDER_RETURN_MAX on the server and the CHECK in migration 021. Out of range is
  // NOT clamped: clamping silently rewrites a number somebody typed during a meeting, so the
  // rule is shown and the save is refused instead. Switching weeks -> days with 7 in the box
  // keeps the 7 and says "Enter 1-5 days." — the user is mid-thought, it self-heals on the
  // next keystroke, and it can never be saved wrong.
  const periodMax = TENDER_RETURN_MAX[periodUnit];
  const periodNumber = periodValue === '' ? null : Number(periodValue);
  const periodInvalid = periodNumber !== null && (periodNumber < 1 || periodNumber > periodMax);

  const dirty = (() => {
    const saved = new Set(row.subcontractors.filter((s) => s.selected).map((s) => s.subcontractor_id));
    if (saved.size !== picked.size) return true;
    for (const id of picked) if (!saved.has(id)) return true;
    if (route !== row.route_of_procurement) return true;
    if (periodNumber !== (row.tender_return_period_value ?? null)) return true;
    // The unit only counts where a value exists: flipping the picker over an empty box
    // changes nothing server-side, so it is not a pending edit.
    if (periodNumber !== null && periodUnit !== (row.tender_return_period_unit ?? 'weeks')) return true;
    return notes.trim() !== (row.board_override_notes ?? '').trim();
  })();

  return <tr className={`pkg-row ${row.is_heading ? 'pkg-heading' : ''} ${row.is_sub_package ? 'pkg-child' : ''}`}>
    <td className="pkg-seq">{row.display_ref}</td>
    <td className="pkg-name">
      <strong>{row.package_name}</strong>
      {row.is_heading && <span className="badge badge-grey">broken down</span>}
      {/* Why this package is in the list at all. A Manual one is prelims and the like —
          nothing measures it, so it is offered rather than found, and a reviewer deciding
          whether to tender it needs to know which of the two they are looking at. */}
      {row.wp_scope_condition === 'Manual' && <span className="badge badge-amber" title="No take-off measures this work — added because every job carries it">manual</span>}
      {row.wp_scope_condition === 'D&B' && <span className="badge badge-blue" title="Included because this is a design-and-build appointment">design &amp; build</span>}
      {row.wp_code && <code className="tiny muted"> {row.wp_code}</code>}
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
    <td>
      {row.is_heading
        ? <span className="muted tiny">—</span>
        : <>
            <div className="return-period">
              {/* Text, not number: "only digits" is then literally true — a number input
                  still accepts e/+/- in several browsers and hands back an empty string for
                  input it dislikes, so the typist cannot see what they typed — and the
                  scroll wheel cannot silently change a value on a long table. One character
                  is enough; 8 is the largest legal number. */}
              <input
                className="return-period-value"
                value={periodValue}
                inputMode="numeric"
                maxLength={1}
                aria-label={`Tender return period for ${row.package_name}`}
                onChange={(e) => setPeriodValue(e.target.value.replace(/\D/g, ''))}
              />
              <select className="return-period-unit" value={periodUnit}
                      aria-label={`Tender return unit for ${row.package_name}`}
                      onChange={(e) => setPeriodUnit(e.target.value as TenderReturnUnit)}>
                <option value="weeks">weeks</option>
                <option value="days">days</option>
              </select>
            </div>
            {periodInvalid && <div className="alert alert-red tiny" style={{ marginTop: 4 }}>
              Enter 1–{periodMax} {periodUnit}.
            </div>}
            {row.tender_return_deadline &&
              <div className="muted tiny">issued {row.tender_return_deadline}</div>}
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
            <button className="small" onClick={() => save.mutate()} disabled={!dirty || periodInvalid || save.isPending}>
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
      <h3>Nothing to tender yet</h3>
      <p className="muted">
        The package list is built from the take-off. Review it in BuildFlow — approve or
        ignore every item — then press <strong>Tender Take off</strong> on the TOQ tab. The
        packages appear here within a few seconds of that.
      </p>
      <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>
        Which packages are required is decided by the work packages the take-off resolved and
        the tender&rsquo;s scope, against the NRM1 work-package configuration.
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
      only those receive an ITT at Step 2. Set how long each package is tendered for (1–5
      working days, or 1–8 weeks); the return date is worked out from the day its ITT
      actually goes out, and never moves afterwards.
    </p>
    <div className="table-scroll">
      <table className="data-table launch-table">
        <thead>
          <tr>
            <th style={{ width: '3rem' }}>#</th>
            <th style={{ width: '16rem' }}>Package</th>
            <th style={{ width: '11rem' }}>Route of Procurement</th>
            <th style={{ width: '8rem' }}>Tender return</th>
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
        <code>ITT-{String(t.tenderName ?? 'TENDER').toUpperCase()}-{pack.display_ref}</code></div>
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
      {pack.boq_summary.total} lines — {pack.boq_summary.priceable} with measured quantities,
      {' '}{pack.boq_summary.scope_only} carrying scope the take-off could not measure.
      {pack.attributed_by_work_package
        ? <> Taken straight from the take-off: {pack.boq_summary.by_work_package ?? 0} claimed by
            work package{(pack.boq_summary.by_nrm_code ?? 0) > 0
              ? <>, {pack.boq_summary.by_nrm_code} by NRM classification because the take-off
                  resolved no package for them</>
              : null}.</>
        : ' Attributed by NRM classification.'}
      {' '}Quantities are the reviewed ones. Rates are omitted deliberately: each tenderer
      prices independently.
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

    <h4>2c. Scope of works</h4>
    <p className="muted tiny">
      What the subcontractor carries around the measured bill — {pack.scope_summary.total} items
      across {pack.scope_summary.by_section.length} sections:
      {' '}{pack.scope_summary.package_specific} specific to this package, {pack.scope_summary.general} general.
      {' '}<strong>{pack.scope_summary.contract}</strong> are Contract items to be priced;
      {' '}<strong>{pack.scope_summary.profit_plan}</strong> are Profit Plan and must <em>not</em> be priced by the tenderer.
    </p>
    {pack.scope_items.length === 0
      ? <p className="muted tiny">
          No scope of works for this package. Every clause is assigned to a trade, and a
          package reaches its trade through its work package — so this reads empty until
          that trade carries this package&rsquo;s code in Configuration &rarr; Tenders.
          It is deliberately empty rather than partial: a tenderer prices what they are
          sent, and a half-issued scope reads exactly like a complete one.
        </p>
      : <details className="doc-group">
          <summary><strong>Show {pack.scope_items.length} scope items</strong></summary>
          <div className="table-scroll">
            <table className="data-table itt-boq">
              <thead><tr><th>No.</th><th>Item</th><th>Applies to</th><th>Cost basis</th><th>Ignore for ITT</th></tr></thead>
              {/* Grouped and numbered exactly as renderIttEmail does, so the reviewer is
                  reading the document the tenderer will receive rather than a different
                  view of the same rows. */}
              <tbody>{pack.scope_items.map((s, index) => <Fragment key={s.id}>
                {(index === 0 || pack.scope_items[index - 1].section !== s.section) &&
                  <tr className="scope-section"><th colSpan={5}>{s.section}</th></tr>}
                <tr className={s.procurement_stage === 'Profit Plan' ? 'scope-only' : ''}>
                  <td className="tiny num">{index + 1}</td>
                  <td className="tiny">{s.description}</td>
                  <td className="tiny">{s.applies_to_all_trades ? 'All trades' : 'This trade'}</td>
                  <td className="tiny">{s.procurement_stage
                    ? <span className={`badge badge-${s.procurement_stage === 'Contract' ? 'blue' : 'amber'}`}>{s.procurement_stage}</span>
                    : '—'}</td>
                  <td><IgnoreToggle workflowId={workflowId} packageName={packageName} section="scope_item" itemId={s.id} ignored={s.ignored} label="" /></td>
                </tr>
              </Fragment>)}</tbody>
            </table>
          </div>
        </details>}

    <h4>3. Documents issued</h4>
    <p className="muted tiny">
      All {pack.documents.length} tender documents are issued with every package — an Employer's
      Requirement binds the subcontractor whether or not its filename mentions their trade.
    </p>
    <DocSchedule docs={pack.documents} workflowId={workflowId} packageName={packageName} />

    {/* Which of those the take-off actually measured against. Section 3 still issues
        everything — this narrows nothing, it just says where these quantities came from,
        which is the first thing a tenderer pricing one trade wants to open. */}
    <h4>3b. Specification referenced by this package</h4>
    {pack.spec_summary?.available === false
      ? <p className="muted tiny">
          This package is not derived from a take-off, so which specification its lines came
          from is not recorded.
        </p>
      : <>
          <p className="muted tiny">
            {pack.spec_summary?.cited_lines ?? 0} of {pack.spec_summary?.total_lines ?? 0} lines
            cite a specification.
            {(pack.spec_summary?.unresolved ?? 0) > 0 && <>
              {' '}<strong>Cited but not in the tender pack:</strong>{' '}
              {pack.spec_summary?.unresolved_names.join(', ')}.
            </>}
          </p>
          {(pack.spec_documents?.length ?? 0) === 0
            ? <p className="muted tiny">No line in this package cites a specification document.</p>
            : <table className="data-table">
                <thead><tr><th>Document</th><th>Type</th><th>Pages</th><th>Ignore for ITT</th></tr></thead>
                <tbody>{pack.spec_documents!.map((d) => <tr key={d.id} className={d.ignored ? 'scope-only' : ''}>
                  <td className="tiny">{d.filename}</td>
                  <td className="tiny muted">{d.doc_type.replace(/_/g, ' ')}</td>
                  <td className="tiny">{d.page_count > 0 ? d.page_count : '—'}</td>
                  <td><IgnoreToggle workflowId={workflowId} packageName={packageName} section="document" itemId={d.id} ignored={d.ignored} label="" /></td>
                </tr>)}</tbody>
              </table>}
        </>}

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

/**
 * "Open draft Email" — one package's ITT, composed and sent from inside the app.
 *
 * An earlier version handed the message off to Outlook. It could not: a web page cannot launch
 * a desktop application, and the one thing that opens a mail client (`mailto:`) carries neither
 * HTML nor attachments. So the message never leaves the app — the modal shows exactly what will
 * be sent, takes the addresses, and the server sends it.
 *
 * THE BODY IS READ-ONLY. To, Cc and Subject are all that cross the wire on Send; the server
 * rebuilds the scope, bill, links and attachments from its own assembly. A tenderer's
 * obligations are not editable in a browser on their way out.
 */
function AddressField({ label, hint, value, onChange }: {
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return <div className="compose-field">
    <label htmlFor={`compose-${label}`}>{label}</label>
    <div style={{ flex: 1 }}>
      <input
        id={`compose-${label}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="name@example.com, another@example.com"
      />
      {hint && <div className="tiny muted" style={{ marginTop: 3 }}>{hint}</div>}
    </div>
  </div>;
}

/** Split a typed address line. Commas and semicolons both, since people paste both. */
const splitAddresses = (value: string): string[] =>
  value.split(/[,;]/).map((a) => a.trim()).filter(Boolean);

const looksLikeEmail = (address: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);

function IttComposeModal({ workflowId, packageName, onClose, onSent }: {
  workflowId: string;
  packageName: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [result, setResult] = useState<SendIttDraftResult | null>(null);

  const draft = useQuery({
    queryKey: ['itt-draft', workflowId, packageName],
    queryFn: () => api.getIttDraft(workflowId, packageName)
  });

  // Pre-filled once, from the firms the tender launch meeting selected. Only once: re-running
  // this on every render would undo the sender's edits as they typed.
  useEffect(() => {
    if (!draft.data || prefilled) return;
    // TEMPORARY (testing the pricing-portal link) — revert to joining draft.data.recipients.
    setTo('vipvyas@novamerx.ai');
    setSubject(draft.data.subject);
    setPrefilled(true);
  }, [draft.data, prefilled]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = useMutation({
    mutationFn: () => api.sendIttDraft(workflowId, packageName, {
      to: splitAddresses(to), cc: splitAddresses(cc), subject: subject.trim()
    }),
    onSuccess: (sent) => { setResult(sent); onSent(); }
  });

  const toAddresses = splitAddresses(to);
  const ccAddresses = splitAddresses(cc);
  const invalid = [...toAddresses, ...ccAddresses].filter((a) => !looksLikeEmail(a));
  const canSend = toAddresses.length > 0 && invalid.length === 0 && subject.trim().length > 0;
  const unreachable = (draft.data?.recipients ?? []).filter((r) => !r.email);

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h3>Send the {packageName} ITT</h3>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="modal-body">
        {draft.isLoading ? <Busy>Building the email…</Busy>
          : draft.error ? <ErrorMessage error={draft.error} />
          : draft.data ? <>
            {result ? <div className="alert alert-green">
              Sent to {result.recipients} address{result.recipients === 1 ? '' : 'es'} with {result.attachments} attachment
              {result.attachments === 1 ? '' : 's'}. Recorded against {result.recorded} shortlisted firm
              {result.recorded === 1 ? '' : 's'}
              {result.not_recorded > 0 && `; ${result.not_recorded} address${result.not_recorded === 1 ? '' : 'es'} matched no shortlisted firm and left no dispatch record`}.
            </div> : <>
              <AddressField label="To" value={to} onChange={setTo} hint={
                unreachable.length > 0
                  ? `No contact email on file for ${unreachable.map((r) => r.name ?? 'an unnamed firm').join(', ')} — add an address by hand or they will not be invited.`
                  : undefined
              } />
              <AddressField label="Cc" value={cc} onChange={setCc} />
              <div className="compose-field">
                <label htmlFor="compose-subject">Subject</label>
                <input id="compose-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              {invalid.length > 0 && <p className="error">Not a valid address: {invalid.join(', ')}</p>}
            </>}

            <div className="tiny muted" style={{ margin: '12px 0 6px' }}>
              Attachments: {draft.data.attachments.length > 0
                ? draft.data.attachments.map((a) => `${a.filename} (${Math.max(1, Math.round(a.bytes / 1024))} KB)`).join(', ')
                : draft.data.attachmentsOmittedOversize
                  ? 'none — the generated files exceed what one email can carry'
                  : 'none were generated for this package'}
            </div>

            {!draft.data.bundleUrl && <div className="alert alert-amber" style={{ marginBottom: 10 }}>
              <strong>No document pack for this package.</strong>{' '}
              {draft.data.completeBundleUrl
                ? 'The email points the tenderer at the complete tender document set instead. Re-release the take-off to produce per-package packs.'
                : 'The email says the documents will be issued separately, because neither a package pack nor a complete set has been built. Re-release the take-off first if the tenderer should receive documents with this invitation.'}
            </div>}

            {/* The preview below is sandboxed (no allow-downloads), so its embedded "Download…"
                link cannot be clicked from inside the frame. Offer a working one here instead. */}
            {draft.data.bundleUrl
              ? <p style={{ margin: '0 0 10px' }}>
                  <a href={draft.data.bundleUrl} target="_blank" rel="noreferrer" className="button-link">
                    Download the {packageName} document pack →
                  </a>
                </p>
              : draft.data.completeBundleUrl && <p style={{ margin: '0 0 10px' }}>
                  <a href={draft.data.completeBundleUrl} target="_blank" rel="noreferrer" className="button-link">
                    Download the complete tender document set →
                  </a>
                </p>}

            {draft.data.portalUrl && <p style={{ margin: '0 0 10px' }}>
              <a href={draft.data.portalUrl} target="_blank" rel="noreferrer" className="button-link">
                Price and submit this package's bill online →
              </a>
            </p>}

            {/* Sandboxed: the ITT carries its own inline styles and must neither inherit the
                app's nor leak into it. srcDoc keeps it entirely local — nothing is fetched. */}
            <iframe
              className="compose-preview"
              title={`${packageName} ITT preview`}
              sandbox=""
              srcDoc={draft.data.html}
            />
            <p className="tiny muted" style={{ marginTop: 6, marginBottom: 0 }}>
              This is exactly what will be sent. The body is not editable — it is rebuilt on the
              server when you send, so the scope and return requirements cannot be altered here.
            </p>
          </> : null}
        <ErrorMessage error={send.error} />
      </div>

      <div className="modal-footer">
        <button className="small secondary" onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        {!result && <button
          className="small"
          disabled={!canSend || send.isPending || !draft.data}
          onClick={() => send.mutate()}
        >
          {send.isPending ? 'Sending…' : `Send${toAddresses.length > 0 ? ` to ${toAddresses.length}` : ''}`}
        </button>}
      </div>
    </div>
  </div>;
}

/**
 * Site address, deadlines, site-visit and the estimator's own details — the facts
 * the cover letter and Form 1A need that nothing else in the workflow captures.
 * Estimator name/email arrive pre-filled from the confirming user's own account
 * (server-side default) and are editable here before the first ITT goes out.
 */
function IttLetterDetailsPanel({ workflowId, anyDispatched }: { workflowId: string; anyDispatched: boolean }) {
  const queryClient = useQueryClient();
  const details = useQuery({ queryKey: ['itt-letter-details', workflowId], queryFn: () => api.getIttLetterDetails(workflowId) });
  const [draft, setDraft] = useState<IttLetterDetailsInput | null>(null);
  const current: IttLetterDetailsInput = draft ?? {
    siteAddress: details.data?.site_address ?? '',
    tenderReturnDeadline: details.data?.tender_return_deadline ?? '',
    clarificationsCloseDate: details.data?.clarifications_close_date ?? '',
    siteVisitPermitted: details.data?.site_visit_permitted ?? null,
    estimatorName: details.data?.estimator_name ?? '',
    estimatorEmail: details.data?.estimator_email ?? ''
  };
  const save = useMutation({
    mutationFn: () => api.saveIttLetterDetails(workflowId, current),
    onSuccess: () => { setDraft(null); void queryClient.invalidateQueries({ queryKey: ['itt-letter-details', workflowId] }); }
  });

  if (details.isLoading) return null;

  return <details className="panel" style={{ marginBottom: 12 }}>
    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>ITT letter details</summary>
    <p className="muted tiny">Used on the cover letter and Form 1A — site address, return deadline and who to contact.</p>
    <div className="stack" style={{ marginTop: 8 }}>
      <label className="field"><span>Site address</span>
        <input value={current.siteAddress ?? ''} onChange={(e) => setDraft({ ...current, siteAddress: e.target.value })} />
      </label>
      <div className="two-column">
        <label className="field"><span>Tender return deadline</span>
          <input type="date" value={current.tenderReturnDeadline ?? ''} onChange={(e) => setDraft({ ...current, tenderReturnDeadline: e.target.value })} />
          {/* Leave it blank and each package's own return period decides its date, counted
              from the day its ITT goes out. Set here, it overrides every one of them. */}
          <span className="muted tiny">
            Blank means each package uses the return period set at the Tender Launch Pack step.
            A date here overrides all of them.
          </span>
          {anyDispatched && <span className="muted tiny">
            ITTs have already gone out. Changing this changes the date the pricing portal shows
            those firms, but not the letters already in their inbox.
          </span>}
        </label>
        <label className="field"><span>Clarifications close</span>
          <input type="date" value={current.clarificationsCloseDate ?? ''} onChange={(e) => setDraft({ ...current, clarificationsCloseDate: e.target.value })} />
        </label>
      </div>
      <label className="field"><span>Site visit permitted</span>
        <select value={current.siteVisitPermitted === null || current.siteVisitPermitted === undefined ? '' : String(current.siteVisitPermitted)}
          onChange={(e) => setDraft({ ...current, siteVisitPermitted: e.target.value === '' ? null : e.target.value === 'true' })}>
          <option value="">Not stated</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </label>
      <div className="two-column">
        <label className="field"><span>Estimator name</span>
          <input value={current.estimatorName ?? ''} onChange={(e) => setDraft({ ...current, estimatorName: e.target.value })} />
        </label>
        <label className="field"><span>Estimator email</span>
          <input value={current.estimatorEmail ?? ''} onChange={(e) => setDraft({ ...current, estimatorEmail: e.target.value })} />
        </label>
      </div>
      <div>
        <button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        {save.isError && <span className="tiny" style={{ color: '#c0392b', marginLeft: 8 }}>{(save.error as Error).message}</span>}
      </div>
    </div>
  </details>;
}

function Step2IttDispatch({ workflowId, initialThreadId, openRfi }: {
  workflowId: string;
  /** Set when a notification sent the reader here. Opens Communications on that firm. */
  initialThreadId?: string | null;
  /** Set when the tender dashboard's "drafts waiting" badge sent the reader here. Opens
   *  Communications straight onto the RFI review tab (issue #48). */
  openRfi?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState<string | null>(null);
  const [responsesOpen, setResponsesOpen] = useState<string | null>(null);
  // Per TENDER, not per package: a firm's queries are one conversation whichever package
  // they are invited to, and an email carries no package at all. So the control sits in
  // the header beside "Send all ITTs" rather than on a package row.
  const [commsOpen, setCommsOpen] = useState(Boolean(initialThreadId) || Boolean(openRfi));
  const [lastResult, setLastResult] = useState<ConfirmIttResult | null>(null);
  const [sendAllResult, setSendAllResult] = useState<SendAllIttsResult | null>(null);
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
  const sendAll = useMutation({
    mutationFn: () => api.sendAllItts(workflowId),
    onSuccess: (result) => {
      setSendAllResult(result);
      setLastResult(null);
      void queryClient.invalidateQueries({ queryKey: ['itts', workflowId] });
    }
  });

  if (itts.isLoading) return <Busy />;
  if (itts.error) return <ErrorMessage error={itts.error} />;
  const rows = itts.data ?? [];
  const confirmedPackages = rows.filter((r) => r.confirmed_at && Number(r.recipients) > 0).length;

  if (rows.length === 0) {
    return <div className="panel">
      <h3>No ITTs yet</h3>
      <p className="muted">
        A package appears here once the tender launch meeting has confirmed it. Go back to the
        Tender Launch Pack, tick the subcontractors for a package and confirm it.
      </p>
    </div>;
  }

  return <div className="panel">
    <IttLetterDetailsPanel workflowId={workflowId} anyDispatched={rows.some((r) => Number(r.dispatched) > 0)} />
    <div className="shortlist-header">
      <h3>Invitations to Tender</h3>
      <span className="muted">{rows.length} package{rows.length === 1 ? '' : 's'} · {rows.reduce((n, r) => n + Number(r.recipients), 0)} recipients</span>
    </div>
    <p className="muted" style={{ marginBottom: 12 }}>
      Built from the live take-off, package configuration and document set. Review below —
      untick anything that should not go out under "Ignore for ITT" — then confirm to email
      the selected subcontractors. Each email is a cover letter addressed to that firm, with the
      configured attachments for its trade — forms, scope of works, schedule of attendances and
      a blank pricing schedule — plus a link to that firm's document pack. Which attachments a
      trade receives, and their wording, is set in Configuration → ITT attachment templates.
    </p>

    <div className="alert" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 260 }}>
        <strong>Send one ITT per subcontractor</strong>
        <div className="tiny muted">
          {confirmedPackages === 0
            ? 'No packages are confirmed yet — confirm them at the Tender Launch Pack step first.'
            : `A firm invited to several of the ${confirmedPackages} confirmed package${confirmedPackages === 1 ? '' : 's'} receives a single email covering all of them, rather than one per package.`}
        </div>
      </div>
      <span className="inline-form">
        <button className="small secondary" onClick={() => setCommsOpen(true)}>
          Communications
        </button>
        <button className="small" disabled={confirmedPackages === 0 || sendAll.isPending} onClick={() => sendAll.mutate()}>
          {sendAll.isPending ? 'Sending…' : 'Send all ITTs'}
        </button>
      </span>
    </div>

    {sendAll.error && <ErrorMessage error={sendAll.error} />}

    {sendAllResult && <div className={`alert ${sendAllResult.failed > 0 ? 'alert-red' : 'alert-green'}`} style={{ marginBottom: 12 }}>
      <div>
        Sent {sendAllResult.sent} email{sendAllResult.sent === 1 ? '' : 's'} to {sendAllResult.subcontractors} subcontractor
        {sendAllResult.subcontractors === 1 ? '' : 's'} across {sendAllResult.packages} package
        {sendAllResult.packages === 1 ? '' : 's'} — failed {sendAllResult.failed}, no email on file {sendAllResult.skipped_no_email}.
      </div>
      {sendAllResult.unassembled_packages.length > 0 && <div className="tiny" style={{ marginTop: 6 }}>
        Not sent — could not be built: {sendAllResult.unassembled_packages.map((p) => p.packageName).join(', ')}.
      </div>}
      <ul className="tiny" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
        {sendAllResult.recipients.map((r) => <li key={r.subcontractorId}>
          {r.status === 'sent' ? '✓' : '✗'} {r.packages.join(', ')}
          {r.status !== 'sent' && ` — ${r.error ?? r.status.replace(/_/g, ' ')}`}
        </li>)}
      </ul>
    </div>}
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>#</th><th>Package</th><th>Route of Procurement</th><th>Recipients</th><th>Status</th><th></th><th></th></tr></thead>
        <tbody>{rows.map((r) => <>
          <tr key={r.package_name}>
            <td>{r.package_seq ?? '—'}</td>
            <td><strong>{r.package_name}</strong></td>
            <td className="tiny">{r.route_of_procurement ?? '—'}</td>
            <td>
              {r.recipients}
              {Number(r.recipients) === 0 && <div className="tiny" style={{ color: '#d97706', marginTop: 4 }}>
                {Number(r.candidates) === 0
                  ? 'no firm in the register carries this trade — build the supply chain'
                  : 'confirmed without inviting anyone — reopen the package and pick'}
              </div>}
            </td>
            <td>
              {Number(r.sent) > 0 && <span className="badge badge-green">sent {r.sent}</span>}
              {' '}{Number(r.failed) > 0 && <span className="badge badge-red">failed {r.failed}</span>}
              {' '}{Number(r.skipped_no_email) > 0 && <span className="badge badge-amber">no email {r.skipped_no_email}</span>}
              {Number(r.sent) === 0 && Number(r.failed) === 0 && Number(r.skipped_no_email) === 0 &&
                <span className="badge badge-grey">not sent</span>}
              {' '}{Number(r.responses_received) > 0 && <span className="badge badge-blue">response received {r.responses_received}</span>}
              {Number(r.portal_denials) > 0 && <div className="tiny" style={{ color: '#d97706', marginTop: 4 }}>
                ⚠ a viewer's sign-in did not match the recipient on {r.portal_denials} link{Number(r.portal_denials) === 1 ? '' : 's'}
              </div>}
            </td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button className="small secondary" onClick={() => setOpen(open === r.package_name ? null : r.package_name)}>
                {open === r.package_name ? 'Close' : 'View ITT'}
              </button>
              {' '}
              <button className="small secondary" onClick={() => setDraftOpen(r.package_name)}>
                Open draft Email
              </button>
              {Number(r.responses_received) > 0 && <>
                {' '}
                <button className="small secondary" onClick={() => setResponsesOpen(r.package_name)}>
                  Open responses
                </button>
              </>}
            </td>
            <td>
              <button
                className="small"
                disabled={!r.confirmed_at || Number(r.recipients) === 0 || (confirm.isPending && confirm.variables === r.package_name)}
                title={!r.confirmed_at ? 'Confirm the package at Step 1 first'
                  : Number(r.recipients) === 0 ? 'Nobody is invited to this package, so there is no ITT to send'
                  : undefined}
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

    {draftOpen && <IttComposeModal
      workflowId={workflowId}
      packageName={draftOpen}
      onClose={() => setDraftOpen(null)}
      onSent={() => void queryClient.invalidateQueries({ queryKey: ['itts', workflowId] })}
    />}

    {responsesOpen && <PortalResponsesModal
      workflowId={workflowId}
      packageName={responsesOpen}
      onClose={() => setResponsesOpen(null)}
    />}

    {commsOpen && <CommsModal
      workflowId={workflowId} initialThreadId={initialThreadId}
      initialTab={openRfi ? 'rfi' : undefined}
      onClose={() => setCommsOpen(false)} />}
  </div>;
}

/**
 * "Open responses" — every firm this package's ITT went to, their portal status, and a
 * way into each one's priced bill. Structured the same way as IttComposeModal: a list
 * view that, on picking a firm, swaps in a detail view within the same modal rather than
 * stacking a second one.
 */
function PortalResponsesModal({ workflowId, packageName, onClose }: {
  workflowId: string; packageName: string; onClose: () => void;
}) {
  const [openLinkId, setOpenLinkId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const responses = useQuery({
    queryKey: ['portal-responses', workflowId, packageName],
    queryFn: () => api.listPortalResponses(workflowId, packageName)
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const blockedLabel = (reason: PortalResponseSummary['blocked_reason']) => {
    if (reason === 'public_email_domain') return "no link — recipient's email domain is a public/free provider";
    if (reason === 'access_unconfigured') return 'no link — online pricing is not configured on this deployment';
    return null;
  };

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h3>{openLinkId ? 'Response' : 'Responses'} — {packageName}</h3>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="modal-body">
        {openLinkId
          ? <PortalResponseDetailView
              workflowId={workflowId} linkId={openLinkId}
              onBack={() => setOpenLinkId(null)}
              onReopened={() => {
                void queryClient.invalidateQueries({ queryKey: ['portal-responses', workflowId, packageName] });
                void queryClient.invalidateQueries({ queryKey: ['itts', workflowId] });
              }}
            />
          : responses.isLoading ? <Busy />
          : responses.error ? <ErrorMessage error={responses.error} />
          : <table className="data-table">
              <thead><tr><th>Firm</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {(responses.data ?? []).map((r) => <tr key={r.id}>
                  <td>{r.firm_name}</td>
                  <td>
                    {r.submitted_at
                      ? <span className="badge badge-green">submitted {new Date(r.submitted_at).toLocaleDateString()}</span>
                      : r.draft_saved_at
                        ? <span className="badge badge-amber">draft in progress</span>
                        : r.token
                          ? <span className="badge badge-grey">link sent, not opened</span>
                          : <span className="badge badge-grey">{blockedLabel(r.blocked_reason)}</span>}
                    {r.denied_attempts > 0 && <div className="tiny" style={{ color: '#d97706' }}>
                      ⚠ {r.denied_attempts} sign-in attempt{r.denied_attempts === 1 ? '' : 's'} from a non-matching address
                    </div>}
                  </td>
                  <td>
                    {(r.submitted_at || r.draft_saved_at) &&
                      <button className="small secondary" onClick={() => setOpenLinkId(r.id)}>Open response</button>}
                  </td>
                </tr>)}
              </tbody>
            </table>}
      </div>
    </div>
  </div>;
}

function PortalResponseDetailView({ workflowId, linkId, onBack, onReopened }: {
  workflowId: string; linkId: string; onBack: () => void; onReopened: () => void;
}) {
  const detail = useQuery({
    queryKey: ['portal-response', workflowId, linkId],
    queryFn: () => api.getPortalResponse(workflowId, linkId)
  });
  const reopen = useMutation({
    mutationFn: () => api.reopenPortalResponse(workflowId, linkId),
    onSuccess: onReopened
  });

  if (detail.isLoading) return <Busy />;
  if (detail.error) return <ErrorMessage error={detail.error} />;
  if (!detail.data) return null;
  const r = detail.data;

  const total = r.lines.reduce((sum, line) => {
    if (line.status !== 'priced' || line.total == null) return sum;
    return sum + Number(line.total);
  }, 0);

  return <div>
    <button className="small secondary" onClick={onBack} style={{ marginBottom: 12 }}>← Back to responses</button>
    <div className="info-row" style={{ marginBottom: 12 }}>
      <div className="info-item"><span className="info-label">Firm</span>{r.firm_name}</div>
      <div className="info-item"><span className="info-label">Programme</span>{r.programme_weeks ?? '—'} weeks</div>
      <div className="info-item"><span className="info-label">Total (priced)</span>
        {total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
    </div>
    {r.qualifications && <p className="tiny" style={{ marginBottom: 8 }}><strong>Qualifications:</strong> {r.qualifications}</p>}
    {r.exclusions && <p className="tiny" style={{ marginBottom: 8 }}><strong>Exclusions:</strong> {r.exclusions}</p>}
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Total</th><th>Status</th><th>Note</th></tr></thead>
        <tbody>
          {r.lines.map((line) => <tr key={line.id}>
            <td>{line.description}</td>
            <td>{line.quantity ?? '—'}</td>
            <td>{line.unit ?? '—'}</td>
            <td>{line.rate ?? '—'}</td>
            <td>{line.total ?? '—'}</td>
            <td className="tiny">{line.status.replace(/_/g, ' ')}</td>
            <td className="tiny">{line.note ?? ''}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {r.submitted_at && <div className="button-row" style={{ marginTop: 12 }}>
      <button className="secondary" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
        {reopen.isPending ? 'Reopening…' : 'Reopen for editing'}
      </button>
    </div>}
    {reopen.error && <ErrorMessage error={reopen.error} />}
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
