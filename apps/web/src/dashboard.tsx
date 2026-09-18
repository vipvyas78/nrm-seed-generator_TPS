import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type DashboardCandidate, type DashboardRow } from './api';
import { Busy, ErrorMessage, PackageRow } from './pages';

/**
 * The tender dashboard: every trade package on one page, with who it went to and what came
 * back — the view BuildFlow's projects page links into once a take-off has been tendered.
 *
 * Addressed by BuildFlow's PACKAGE id, because that is the only identifier the two modules
 * share. The workflow is resolved from it the same way TenderPrepPage does, including the
 * poll: a take-off released seconds ago has a workflow on the way but not yet arrived, and
 * neither "not started" nor "starting" should look like an error.
 */
export function TenderDashboardPage() {
  const [params] = useSearchParams();
  const packageId = params.get('packageId') ?? '';

  const workflow = useQuery({
    queryKey: ['workflow-by-package', packageId],
    queryFn: () => api.getWorkflowByPackage(packageId),
    enabled: Boolean(packageId),
    refetchInterval: (query) => (query.state.data ? false : 15_000)
  });
  const workflowId = workflow.data?.id ?? null;

  const dashboard = useQuery({
    // Keyed UNDER the launch table on purpose. PackageRow invalidates ['launch-table',
    // workflowId] when a package is confirmed and React Query matches keys by prefix, so
    // confirming in the modal below refreshes this page with no extra wiring — and the two
    // can never drift into giving different answers for the same package.
    queryKey: ['launch-table', workflowId, 'dashboard'],
    queryFn: () => api.getDashboard(String(workflowId)),
    enabled: Boolean(workflowId)
  });

  if (!packageId) return <WorkflowPicker />;
  if (workflow.isLoading) return <section className="page"><Busy /></section>;

  return <section className="page">
    <div className="shortlist-header">
      <h1>Tender Dashboard</h1>
      {workflowId && <Link className="button-link" to={`/packages/${packageId}/tender-prep`}>Open tender preparation →</Link>}
    </div>
    <ErrorMessage error={workflow.error} />
    <ErrorMessage error={dashboard.error} />
    {!workflowId
      ? <p className="muted">
          Tender preparation has not started for this package yet. It starts on its own within a
          few seconds of the take-off being tendered in BuildFlow.
        </p>
      : dashboard.isLoading ? <Busy />
      : <DashboardTable rows={dashboard.data ?? []} workflowId={workflowId} />}
  </section>;
}

/** No package in the URL is a legitimate way to arrive here — offer the workflows there are. */
function WorkflowPicker() {
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api.listWorkflows() });
  if (workflows.isLoading) return <section className="page"><Busy /></section>;
  const rows = workflows.data ?? [];
  return <section className="page">
    <h1>Tender Dashboard</h1>
    <ErrorMessage error={workflows.error} />
    {rows.length === 0
      ? <p className="muted">No packages yet. One appears here once a take-off is tendered in BuildFlow.</p>
      : <table className="data-table">
          <thead><tr><th>Package</th><th /></tr></thead>
          <tbody>{rows.map((wf) => <tr key={wf.id}>
            <td>{wf.step_data?.takeoff?.packageName ?? wf.package_id}</td>
            <td><Link className="button-link" to={`/dashboard?packageId=${wf.package_id}`}>Open →</Link></td>
          </tr>)}</tbody>
        </table>}
  </section>;
}

function DashboardTable({ rows, workflowId }: { rows: DashboardRow[]; workflowId: string }) {
  const [approving, setApproving] = useState<DashboardRow>();
  if (rows.length === 0) return <p className="muted">This workflow has no packages yet.</p>;
  const tenderable = rows.filter((row) => !row.is_heading);
  const confirmed = tenderable.filter((row) => row.confirmed_at).length;
  return <>
    <p className="muted">
      {confirmed} of {tenderable.length} packages confirmed. A pending package has not been
      through the tender launch meeting — approve it to choose its firms.
    </p>
    <div className="table-scroll">
      <table className="data-table dashboard-table">
        <thead><tr>
          <th style={{ width: '2.5rem' }} />
          <th>Trade package</th><th>Route of procurement</th><th>Status</th><th>Tender return</th>
          <th>Subcontractor</th><th>USP</th><th>Contact</th><th>Why</th>
          <th>Accepted</th><th>Declined</th><th>Return date</th><th className="num">Tender price</th>
        </tr></thead>
        <tbody>
          {rows.map((row) => <PackageDashboardRows key={row.display_ref} row={row} onApprove={() => setApproving(row)} />)}
        </tbody>
      </table>
    </div>
    {approving && <ApprovePackageModal
      workflowId={workflowId} packageConfigId={approving.package_config_id}
      packageName={approving.package_name} onClose={() => setApproving(undefined)} />}
  </>;
}

/**
 * One package, and a line per firm beneath it. A package with no firms still renders one
 * line — that is the pending state, and dropping the row would hide exactly the packages
 * this dashboard exists to chase.
 */
function PackageDashboardRows({ row, onApprove }: { row: DashboardRow; onApprove: () => void }) {
  const firms = row.subcontractors;
  const span = Math.max(firms.length, 1);
  const pending = !row.confirmed_at;
  return <>
    {(firms.length === 0 ? [undefined] : firms).map((firm, index) => <tr
      key={firm?.subcontractor_id ?? 'none'}
      className={`${row.is_heading ? 'pkg-heading' : ''} ${row.is_sub_package ? 'pkg-child' : ''}`}
    >
      {index === 0 && <>
        <td rowSpan={span}>
          {/* A heading is not tendered — its breakdown is — so it is never approvable. */}
          {pending && !row.is_heading && <button
            className="approve-icon" onClick={onApprove}
            title={`Approve ${row.package_name}`} aria-label={`Approve ${row.package_name}`}
          >✓</button>}
        </td>
        <td rowSpan={span}><strong>{row.display_ref}</strong> {row.package_name}</td>
        <td rowSpan={span}>{row.is_heading ? <span className="muted">—</span> : row.route_of_procurement}</td>
        <td rowSpan={span}>
          {/* A confirmed package with nobody invited must not read as plain green: it is signed
              off and un-tenderable at once, and Step 2 lists it flagged for the same reason. */}
          {row.is_heading ? <span className="muted">Heading</span>
            : pending ? <span className="badge">Pending</span>
            : firms.length === 0 ? <span className="badge badge-amber">Confirmed · nobody invited</span>
            : <span className="badge badge-green">Confirmed</span>}
        </td>
        <td rowSpan={span}>
          {row.tender_return_period_value
            ? `${row.tender_return_period_value} ${row.tender_return_period_unit}`
            : <span className="muted">—</span>}
        </td>
      </>}
      {firm
        ? <FirmCells firm={firm} deadline={row.tender_return_deadline} />
        : <td colSpan={8} className="muted">{row.is_heading ? 'Broken down below' : 'No firms selected yet'}</td>}
    </tr>)}
  </>;
}

function FirmCells({ firm, deadline }: { firm: DashboardCandidate; deadline: string | null }) {
  return <>
    <td>{firm.name}{firm.is_fabricated && <small className="muted"> · test data</small>}</td>
    <td className="tiny muted">{firm.usp}</td>
    <td className="tiny">
      {firm.contact_name ?? <span className="muted">No contact on file</span>}
      {firm.contact_email && <div className="muted">{firm.contact_email}</div>}
    </td>
    <td className="tiny muted">{firm.suggestion_reason}</td>
    {/* Accepted and declined are separate columns because neither is the negation of the
        other: a firm that has not answered, and one never sent an ITT, are both blank. */}
    <td>{firm.accepted ? '✓' : ''}</td>
    <td>{firm.declined ? '✓' : ''}</td>
    <td>{deadline ?? <span className="muted">—</span>}</td>
    <td className="num">{firm.tendered_sum ? Number(firm.tendered_sum).toLocaleString() : <span className="muted">—</span>}</td>
  </>;
}

/**
 * Approving one package, on the Step 1 controls rather than a second copy of them.
 *
 * It fetches the LAUNCH TABLE row, never the dashboard row it was opened from: the dashboard
 * carries only the firms already picked, and PackageRow saves every firm it was shown as the
 * record of who was considered. Handing it the dashboard's list would offer a pending package
 * no firms to choose from, and would quietly erase that record for a confirmed one.
 */
function ApprovePackageModal({ workflowId, packageConfigId, packageName, onClose }: {
  workflowId: string; packageConfigId: string; packageName: string; onClose: () => void;
}) {
  // Keyed under, but distinct from, Step 1's own ['launch-table', workflowId] — this response
  // holds ONE package, and writing it to that key would leave Step 1 showing a one-row table.
  // PackageRow's invalidation matches by prefix, so a confirm here still refreshes both.
  const table = useQuery({
    queryKey: ['launch-table', workflowId, 'package', packageConfigId],
    queryFn: () => api.getLaunchTable(workflowId, undefined, packageConfigId)
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const row = table.data?.find((candidate) => candidate.package_config_id === packageConfigId);
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-header">
        <h3>Approve {packageName}</h3>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="modal-body">
        {table.isLoading ? <Busy>Loading the package…</Busy>
          : table.error ? <ErrorMessage error={table.error} />
          : !row ? <p className="muted">This package is no longer in the tender launch list.</p>
          : <table className="data-table launch-table">
              <thead><tr>
                <th style={{ width: '3rem' }}>#</th>
                <th style={{ width: '16rem' }}>Package</th>
                <th style={{ width: '11rem' }}>Route of Procurement</th>
                <th style={{ width: '8rem' }}>Tender return</th>
                <th>Subcontractors · invite and why suggested</th>
              </tr></thead>
              <tbody><PackageRow row={row} workflowId={workflowId} /></tbody>
            </table>}
      </div>
    </div>
  </div>;
}
