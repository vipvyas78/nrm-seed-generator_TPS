import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api, type QuoteComparisonCell, type QuoteComparisonReturn, type QuoteComparisonRow, type QuoteLineStatus
} from './api';
import { Busy, ErrorMessage } from './pages';
import { formatMoney, isReadyToApprove, readinessBadgeClass, readinessLabel, sortComparisonSummaries } from './quoteComparison';

/**
 * Step 3: the levelled quote comparison (BuildFlow issue #100).
 *
 * Replaces the four-field tps.comparative screen — migration 008 built the table chain
 * behind this and it went unread until now (see CLAUDE.md, "The levelled quote
 * comparison"). Pure presentation logic lives in quoteComparison.ts and is unit-tested
 * there; this file is thin over it, the same split addendum.tsx keeps from
 * addendumDelta.ts.
 *
 * TWO BACKEND GUARANTEES THIS COMPONENT MUST NOT UNDO:
 *  1. `isReadyToApprove` only decides whether the Award control is OFFERED. The actual
 *     guard is `QuoteComparisonDatabase.approve` refusing while `awaiting_returns`,
 *     recomputed at approval time — a stale page here can never award early.
 *  2. `levelledRate`/`levelledTotal`/`isAssumed`/`assumptionBasis` are exactly what the
 *     server computed for THIS grid read; nothing here re-derives a "lowest" figure of
 *     its own, which would be a second opinion the server could disagree with.
 */

export function QuoteComparisonPanel({ workflowId }: { workflowId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const summaries = useQuery({ queryKey: ['quote-comparisons', workflowId], queryFn: () => api.listQuoteComparisons(workflowId) });

  const packages = sortComparisonSummaries(summaries.data ?? []);
  const active = selected ?? packages[0]?.package_name ?? null;

  return <div>
    <div className="panel">
      <h3>Packages</h3>
      <p className="muted">
        Once subcontractors have priced the ITT, this is where their quotes are brought to a
        like-for-like basis — every gap filled at the cheapest quoted price, and every
        assumption said so on the cell.
      </p>
      <ErrorMessage error={summaries.error} />
      {summaries.isLoading ? <Busy /> : <table className="data-table" style={{ marginTop: 12 }}>
        <thead><tr><th>Package</th><th>Returns</th><th>Status</th><th /></tr></thead>
        <tbody>
          {packages.map((pkg) => <tr key={pkg.package_name} className={active === pkg.package_name ? undefined : undefined}>
            <td><strong>{pkg.package_name}</strong></td>
            <td>{pkg.received_count} of {pkg.expected_count}</td>
            <td><span className={`badge ${readinessBadgeClass(pkg.readiness)}`}>{pkg.readiness.replace('_', ' ')}</span></td>
            <td>
              <button className="secondary small" onClick={() => setSelected(pkg.package_name)}>
                {pkg.comparison_id ? 'Open' : 'Compare'} →
              </button>
            </td>
          </tr>)}
          {packages.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: '1.5rem' }}>No packages have been shortlisted yet.</td></tr>}
        </tbody>
      </table>}
    </div>
    {active && <PackageComparison key={active} workflowId={workflowId} packageName={active} />}
  </div>;
}

function PackageComparison({ workflowId, packageName }: { workflowId: string; packageName: string }) {
  const queryClient = useQueryClient();
  const [showManualForm, setShowManualForm] = useState(false);
  const [addingRowFor, setAddingRowFor] = useState(false);
  const [awardReturnId, setAwardReturnId] = useState('');
  const [approvalNotes, setApprovalNotes] = useState('');

  const detailKey = ['quote-comparison', workflowId, packageName];
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => api.getQuoteComparison(workflowId, packageName),
    retry: false
  });
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: detailKey });
    void queryClient.invalidateQueries({ queryKey: ['quote-comparisons', workflowId] });
  };

  const open = useMutation({ mutationFn: () => api.openQuoteComparison(workflowId, packageName), onSuccess: invalidateAll });
  const approve = useMutation({
    mutationFn: () => api.approveQuoteComparison(workflowId, packageName, { awardedReturnId: awardReturnId, notes: approvalNotes || null }),
    onSuccess: invalidateAll
  });
  const noteMutation = useMutation({
    mutationFn: (input: { cellId: string; estimatorNote: string | null }) =>
      api.updateQuoteComparisonCellNote(workflowId, String(detail.data?.comparison.id), input.cellId, input.estimatorNote),
    onSuccess: invalidateAll
  });

  // Not opened yet — nothing to show but the invitation to build the comparison.
  if (detail.isError) {
    return <div className="panel">
      <h3>{packageName}</h3>
      <p className="muted">This package’s comparison has not been opened yet.</p>
      <ErrorMessage error={open.error} />
      <button onClick={() => open.mutate()} disabled={open.isPending}>{open.isPending ? 'Opening…' : 'Open comparison'}</button>
    </div>;
  }
  if (detail.isLoading || !detail.data) return <div className="panel"><Busy /></div>;

  const { comparison, returns, rows, totals } = detail.data;
  const readyToApprove = isReadyToApprove(comparison.readiness);

  return <div className="panel">
    <div className="button-row" style={{ justifyContent: 'space-between' }}>
      <h3>{packageName}</h3>
      <button className="secondary small" onClick={() => open.mutate()} disabled={open.isPending}>
        {open.isPending ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
    <p className={comparison.readiness === 'awaiting_returns' ? 'muted' : undefined}>
      {readinessLabel({
        readiness: comparison.readiness, expected_count: comparison.expected_count,
        received_count: comparison.received_count, return_deadline: comparison.return_deadline
      })}
    </p>
    <ErrorMessage error={open.error} />

    {returns.length === 0 && <p className="muted">No returns yet — nothing to compare until at least one comes in.</p>}

    {returns.length > 0 && <div style={{ overflowX: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Item</th>
            {returns.map((ret) => <th key={ret.id} colSpan={2}>{ret.tenderer_name}{ret.is_fabricated ? ' (test)' : ''}</th>)}
            <th>Lowest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <ComparisonRow key={row.id} row={row} returns={returns} onNote={(cellId, note) => noteMutation.mutate({ cellId, estimatorNote: note })} />)}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>Quoted total</strong></td>
            {returns.map((ret) => {
              const t = totals.find((x) => x.returnId === ret.id);
              return <td key={ret.id} colSpan={2}>{formatMoney(t?.quotedSum ?? 0)}</td>;
            })}
            <td />
          </tr>
          <tr>
            <td><strong>Levelled total</strong></td>
            {returns.map((ret) => {
              const t = totals.find((x) => x.returnId === ret.id);
              return <td key={ret.id} colSpan={2}>
                {formatMoney(t?.levelledSum ?? 0)}
                {t && t.assumedCount > 0 && <div className="muted" style={{ fontSize: '0.7rem' }}>{t.assumedCount} line{t.assumedCount === 1 ? '' : 's'} assumed</div>}
              </td>;
            })}
            <td />
          </tr>
        </tfoot>
      </table>
    </div>}

    {returns.length > 0 && <>
      <h4 style={{ marginTop: 16 }}>Inclusions and exclusions</h4>
      <table className="data-table">
        <thead><tr><th>Tenderer</th><th>Qualifications</th><th>Exclusions</th><th>Programme</th></tr></thead>
        <tbody>{returns.map((ret) => <tr key={ret.id}>
          <td><strong>{ret.tenderer_name}</strong></td>
          <td>{ret.qualifications ?? '—'}</td>
          <td>{ret.exclusions ?? '—'}</td>
          <td>{ret.programme_weeks != null ? `${ret.programme_weeks} weeks` : '—'}</td>
        </tr>)}</tbody>
      </table>
    </>}

    <div className="button-row" style={{ marginTop: 16, justifyContent: 'flex-start' }}>
      <button className="secondary small" onClick={() => setShowManualForm((v) => !v)}>
        {showManualForm ? 'Cancel' : '+ Enter a return by hand'}
      </button>
      <button className="secondary small" onClick={() => setAddingRowFor((v) => !v)}>
        {addingRowFor ? 'Cancel' : '+ Add a comparison item'}
      </button>
    </div>

    {showManualForm && <ManualReturnForm
      workflowId={workflowId} packageName={packageName} rows={rows}
      onDone={() => { setShowManualForm(false); invalidateAll(); }}
    />}

    {addingRowFor && <AddRowForm
      workflowId={workflowId} comparisonId={comparison.id}
      onDone={() => { setAddingRowFor(false); invalidateAll(); }}
    />}

    {returns.length > 0 && <div className="panel" style={{ marginTop: 16, background: '#f9fafb' }}>
      <h4>Award this package</h4>
      <p className="muted">
        Gated by the server, not by this screen: an award is refused while the comparison is
        still awaiting returns, whatever this page happens to show at the moment.
      </p>
      <div className="inline-form">
        <select value={awardReturnId} onChange={(e) => setAwardReturnId(e.target.value)}>
          <option value="">Select the awarded tenderer…</option>
          {returns.map((ret) => <option key={ret.id} value={ret.id}>{ret.tenderer_name}</option>)}
        </select>
        <input value={approvalNotes} onChange={(e) => setApprovalNotes(e.target.value)} placeholder="Notes (optional)" style={{ minWidth: 220 }} />
        <button disabled={!awardReturnId || !readyToApprove || approve.isPending} onClick={() => approve.mutate()}>
          {approve.isPending ? 'Awarding…' : 'Award package'}
        </button>
      </div>
      <ErrorMessage error={approve.error} />
    </div>}
  </div>;
}

function ComparisonRow({ row, returns, onNote }: {
  row: QuoteComparisonRow; returns: QuoteComparisonReturn[]; onNote: (cellId: string, note: string | null) => void;
}) {
  return <tr>
    <td>
      {row.description}
      {row.unit && <span className="muted"> ({row.quantity ?? '—'} {row.unit})</span>}
      {row.origin === 'tenderer_added' && <span className="badge badge-blue" style={{ marginLeft: 6 }}>added by tenderer</span>}
      {row.origin === 'estimator_added' && <span className="badge badge-grey" style={{ marginLeft: 6 }}>added by estimator</span>}
    </td>
    {returns.map((ret) => {
      const cell = row.cells.find((c) => c.returnId === ret.id);
      return cell ? <ComparisonCell key={ret.id} cell={cell} onNote={onNote} /> : <><td /><td /></>;
    })}
    <td>{row.lowest ? `${formatMoney(row.lowest.total)} (${row.lowest.tendererName})` : '—'}</td>
  </tr>;
}

function ComparisonCell({ cell, onNote }: { cell: QuoteComparisonCell; onNote: (cellId: string, note: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cell.estimatorNote ?? '');

  return <>
    <td className={cell.isAssumed ? 'qc-assumed' : undefined}>
      {formatMoney(cell.levelledTotal)}
      {cell.status === 'absent' && <div className="muted" style={{ fontSize: '0.7rem' }}>no return</div>}
    </td>
    <td className={cell.isAssumed ? 'qc-assumed' : undefined} style={{ minWidth: 180 }}>
      {cell.isAssumed && cell.assumptionBasis && <div className="text-red" style={{ fontSize: '0.72rem', marginBottom: 4 }}>{cell.assumptionBasis}</div>}
      {cell.tendererNote && <div className="muted" style={{ fontSize: '0.72rem', marginBottom: 4 }}>“{cell.tendererNote}”</div>}
      {cell.cellId && (editing
        ? <div className="inline-form">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Estimator note" style={{ fontSize: '0.75rem' }} />
            <button className="secondary small" onClick={() => { onNote(cell.cellId!, draft.trim() || null); setEditing(false); }}>Save</button>
          </div>
        : <button className="secondary small" onClick={() => setEditing(true)}>{cell.estimatorNote ? cell.estimatorNote : '+ Note'}</button>
      )}
    </td>
  </>;
}

const STATUS_OPTIONS: QuoteLineStatus[] = ['priced', 'included', 'excluded', 'not_addressed'];

/** A return that arrived as an emailed spreadsheet, keyed straight against the spine rows
 *  already on screen — see recordManualReturn's doc comment for why that needs no fuzzy
 *  matching. */
function ManualReturnForm({ workflowId, packageName, rows, onDone }: {
  workflowId: string; packageName: string; rows: QuoteComparisonRow[]; onDone: () => void;
}) {
  const [tendererName, setTendererName] = useState('');
  const [programmeWeeks, setProgrammeWeeks] = useState('');
  const [qualifications, setQualifications] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [cells, setCells] = useState<Record<string, { rate: string; status: QuoteLineStatus; note: string }>>({});

  const setCell = (rowId: string, patch: Partial<{ rate: string; status: QuoteLineStatus; note: string }>) => {
    setCells((current) => {
      const existing = current[rowId] ?? { rate: '', status: 'priced' as QuoteLineStatus, note: '' };
      return { ...current, [rowId]: { ...existing, ...patch } };
    });
  };

  const save = useMutation({
    mutationFn: () => api.recordManualQuoteReturn(workflowId, packageName, {
      tendererName,
      programmeWeeks: programmeWeeks ? Number(programmeWeeks) : null,
      qualifications: qualifications || null,
      exclusions: exclusions || null,
      cells: rows
        .filter((row) => cells[row.id])
        .map((row) => {
          const entry = cells[row.id]!;
          return { rowId: row.id, quantity: row.quantity, rate: entry.rate ? Number(entry.rate) : null, status: entry.status, note: entry.note || null };
        })
    }),
    onSuccess: onDone
  });

  return <div className="panel" style={{ background: '#f9fafb' }}>
    <h4>Enter a return by hand</h4>
    <div className="inline-form">
      <input value={tendererName} onChange={(e) => setTendererName(e.target.value)} placeholder="Tenderer name" required />
      <input value={programmeWeeks} onChange={(e) => setProgrammeWeeks(e.target.value)} placeholder="Programme (weeks)" type="number" style={{ width: 140 }} />
    </div>
    <div className="inline-form" style={{ marginTop: 8 }}>
      <input value={qualifications} onChange={(e) => setQualifications(e.target.value)} placeholder="Qualifications" style={{ flex: 1 }} />
      <input value={exclusions} onChange={(e) => setExclusions(e.target.value)} placeholder="Exclusions" style={{ flex: 1 }} />
    </div>
    <table className="data-table" style={{ marginTop: 12 }}>
      <thead><tr><th>Item</th><th>Rate</th><th>Status</th><th>Note</th></tr></thead>
      <tbody>{rows.filter((row) => row.origin !== 'tenderer_added').map((row) => {
        const entry = cells[row.id];
        return <tr key={row.id}>
          <td>{row.description}</td>
          <td><input type="number" value={entry?.rate ?? ''} onChange={(e) => setCell(row.id, { rate: e.target.value })} style={{ width: 100 }} /></td>
          <td>
            <select value={entry?.status ?? 'priced'} onChange={(e) => setCell(row.id, { status: e.target.value as QuoteLineStatus })}>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </td>
          <td><input value={entry?.note ?? ''} onChange={(e) => setCell(row.id, { note: e.target.value })} placeholder="Optional" /></td>
        </tr>;
      })}</tbody>
    </table>
    <ErrorMessage error={save.error} />
    <div className="button-row" style={{ marginTop: 12 }}>
      <button disabled={!tendererName.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save return'}</button>
    </div>
  </div>;
}

/** The issue's own example: a discrepancy in a tenderer's description, priced as a
 *  separate item so the comparison stays like for like. */
function AddRowForm({ workflowId, comparisonId, onDone }: { workflowId: string; comparisonId: string; onDone: () => void }) {
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState('');
  const [quantity, setQuantity] = useState('');

  const save = useMutation({
    mutationFn: () => api.addQuoteComparisonRow(workflowId, comparisonId, {
      description, unit: unit || null, quantity: quantity ? Number(quantity) : null
    }),
    onSuccess: onDone
  });

  return <div className="panel" style={{ background: '#f9fafb' }}>
    <h4>Add a comparison item</h4>
    <div className="inline-form">
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" style={{ flex: 1 }} />
      <input value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Quantity" type="number" style={{ width: 100 }} />
      <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="Unit" style={{ width: 80 }} />
      <button disabled={!description.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Adding…' : 'Add'}</button>
    </div>
    <ErrorMessage error={save.error} />
  </div>;
}
