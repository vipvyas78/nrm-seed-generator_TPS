import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api, type QuoteComparisonCell, type QuoteComparisonReturn, type QuoteComparisonRow, type QuoteLineStatus, type QuoteQuery,
  type QuoteQueryResponseSource
} from './api';
import { Busy, ErrorMessage } from './pages';
import {
  formatMoney, isOpenQueriesRefusal, isQueryOpen, isReadyToApprove, openQueryCountByReturn, priceCellDisplay,
  readinessBadgeClass, readinessLabel, sortComparisonSummaries
} from './quoteComparison';

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
  const comparisonId = detail.data?.comparison.id ?? null;
  const queriesKey = ['quote-queries', workflowId, comparisonId];
  const queries = useQuery({
    queryKey: queriesKey,
    queryFn: () => api.listQuoteQueries(workflowId, comparisonId!),
    enabled: Boolean(comparisonId)
  });
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: detailKey });
    void queryClient.invalidateQueries({ queryKey: ['quote-comparisons', workflowId] });
    void queryClient.invalidateQueries({ queryKey: queriesKey });
  };

  const open = useMutation({ mutationFn: () => api.openQuoteComparison(workflowId, packageName), onSuccess: invalidateAll });
  const approve = useMutation({
    mutationFn: (acknowledgeOpenQueries: boolean) => api.approveQuoteComparison(workflowId, packageName, {
      awardedReturnId: awardReturnId, notes: approvalNotes || null, acknowledgeOpenQueries
    }),
    onSuccess: invalidateAll
  });
  // A query still open against the AWARDED tenderer only warns (see
  // tenderPrepDb.ts's own approveQuoteComparison) — the second click sends the SAME
  // award again, this time saying the estimator has seen and accepted that.
  const openQueriesWarning = isOpenQueriesRefusal(approve.error?.message);
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

  const { comparison, returns, rows, totals, scopeNotes } = detail.data;
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
            {returns.map((ret) => {
              const openCount = openQueryCountByReturn(queries.data ?? [])[ret.id] ?? 0;
              return <th key={ret.id} colSpan={2}>
                {ret.tenderer_name}{ret.is_fabricated ? ' (test)' : ''}
                {openCount > 0 && <span className="badge badge-amber" style={{ marginLeft: 6 }} title="Open queries">{openCount} quer{openCount === 1 ? 'y' : 'ies'}</span>}
              </th>;
            })}
            <th>Lowest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <ComparisonRow
            key={row.id} row={row} returns={returns} workflowId={workflowId} comparisonId={comparison.id}
            onNote={(cellId, note) => noteMutation.mutate({ cellId, estimatorNote: note })} onAdjusted={invalidateAll}
          />)}
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
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Every subcontractor's own qualifications and exclusions, and every line on the bill
        they specifically marked included or excluded — for a complete comparison, not just
        the headline figures above.
      </p>
      <table className="data-table">
        <thead><tr><th>Tenderer</th><th>Qualifications</th><th>Exclusions</th><th>Programme</th><th>Items stated included</th><th>Items stated excluded</th></tr></thead>
        <tbody>{returns.map((ret) => {
          const notes = scopeNotes.find((s) => s.returnId === ret.id);
          return <tr key={ret.id}>
            <td><strong>{ret.tenderer_name}</strong></td>
            <td>{notes?.qualifications ?? '—'}</td>
            <td>{notes?.exclusions ?? '—'}</td>
            <td>{notes?.programmeWeeks != null ? `${notes.programmeWeeks} weeks` : '—'}</td>
            <td>{notes && notes.includedItems.length > 0
              ? <ul style={{ margin: 0, paddingLeft: 16 }}>{notes.includedItems.map((it) => <li key={it.seq}>{it.description}</li>)}</ul>
              : '—'}</td>
            <td>{notes && notes.excludedItems.length > 0
              ? <ul style={{ margin: 0, paddingLeft: 16 }}>{notes.excludedItems.map((it) => <li key={it.seq}>{it.description}</li>)}</ul>
              : '—'}</td>
          </tr>;
        })}</tbody>
      </table>
    </>}

    {returns.length > 0 && comparisonId && <QueriesSection
      workflowId={workflowId} comparisonId={comparisonId} returns={returns}
      queries={queries.data ?? []} queriesLoading={queries.isLoading}
      onChanged={() => void queryClient.invalidateQueries({ queryKey: queriesKey })}
    />}

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
        <button disabled={!awardReturnId || !readyToApprove || approve.isPending} onClick={() => approve.mutate(false)}>
          {approve.isPending ? 'Awarding…' : 'Award package'}
        </button>
      </div>
      <ErrorMessage error={openQueriesWarning ? undefined : approve.error} />
      {openQueriesWarning && <div className="panel" style={{ marginTop: 8, background: '#fef3c7' }}>
        <p>{approve.error?.message}</p>
        <button className="secondary small" onClick={() => approve.mutate(true)} disabled={approve.isPending}>
          {approve.isPending ? 'Awarding…' : 'Award anyway'}
        </button>
      </div>}
    </div>}
  </div>;
}

function ComparisonRow({ row, returns, workflowId, comparisonId, onNote, onAdjusted }: {
  row: QuoteComparisonRow; returns: QuoteComparisonReturn[]; workflowId: string; comparisonId: string;
  onNote: (cellId: string, note: string | null) => void; onAdjusted: () => void;
}) {
  const isVariant = row.origin === 'tenderer_variant';
  return <tr>
    <td style={isVariant ? { paddingLeft: 24 } : undefined}>
      {row.description}
      {row.unit && <span className="muted"> ({row.quantity ?? '—'} {row.unit})</span>}
      {row.origin === 'tenderer_added' && <span className="badge badge-blue" style={{ marginLeft: 6 }}>added by tenderer</span>}
      {isVariant && <span className="badge badge-blue" style={{ marginLeft: 6 }}>their own wording</span>}
      {row.origin === 'estimator_added' && <span className="badge badge-grey" style={{ marginLeft: 6 }}>added by estimator</span>}
    </td>
    {returns.map((ret) => {
      const cell = row.cells.find((c) => c.returnId === ret.id);
      return cell
        ? <ComparisonCell key={ret.id} cell={cell} unit={row.unit} workflowId={workflowId} comparisonId={comparisonId} onNote={onNote} onAdjusted={onAdjusted} />
        : <><td /><td /></>;
    })}
    <td>{!isVariant && row.lowest ? `${formatMoney(row.lowest.total)} (${row.lowest.tendererName})` : '—'}</td>
  </tr>;
}

function ComparisonCell({ cell, unit, workflowId, comparisonId, onNote, onAdjusted }: {
  cell: QuoteComparisonCell; unit: string | null; workflowId: string; comparisonId: string;
  onNote: (cellId: string, note: string | null) => void; onAdjusted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cell.estimatorNote ?? '');
  const display = priceCellDisplay(cell, unit);
  const toneClass = display.tone === 'variant' ? 'qc-variant' : display.tone === 'override' ? 'qc-override'
    : display.tone === 'assumed' ? 'qc-assumed' : undefined;
  const canAdjust = cell.cellId && cell.status !== 'priced_as_variant';

  return <>
    <td className={toneClass}>
      {display.primary}
      {display.strikethrough && <div className="muted" style={{ fontSize: '0.7rem', textDecoration: 'line-through' }}>{display.strikethrough}</div>}
      {display.secondary && <div className="muted" style={{ fontSize: '0.7rem' }}>{display.secondary}</div>}
    </td>
    <td className={toneClass} style={{ minWidth: 180 }}>
      {cell.isAssumed && cell.assumptionBasis && <div className="text-red" style={{ fontSize: '0.72rem', marginBottom: 4 }}>{cell.assumptionBasis}</div>}
      {cell.hasOverride && cell.adjustmentReason && <div style={{ fontSize: '0.72rem', marginBottom: 4, color: '#7c3aed' }}>Adjusted: {cell.adjustmentReason}</div>}
      {cell.overrideStale && <div className="text-red" style={{ fontSize: '0.72rem', marginBottom: 4 }}>The quote has changed since this was set — review it.</div>}
      {cell.tendererDescription && <div className="muted" style={{ fontSize: '0.72rem', marginBottom: 4 }}>their wording: “{cell.tendererDescription}”</div>}
      {cell.tendererNote && <div className="muted" style={{ fontSize: '0.72rem', marginBottom: 4 }}>“{cell.tendererNote}”</div>}
      {cell.cellId && (editing
        ? <div className="inline-form">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Estimator note" style={{ fontSize: '0.75rem' }} />
            <button className="secondary small" onClick={() => { onNote(cell.cellId!, draft.trim() || null); setEditing(false); }}>Save</button>
          </div>
        : <button className="secondary small" onClick={() => setEditing(true)}>{cell.estimatorNote ? cell.estimatorNote : '+ Note'}</button>
      )}
      {canAdjust && <AdjustmentControls
        cell={cell} workflowId={workflowId} comparisonId={comparisonId} onAdjusted={onAdjusted}
      />}
    </td>
  </>;
}

/**
 * The estimator's own final figure for a cell — "subject to the response from the
 * subcontractor, he can make the final adjustments" (BuildFlow #100). Sits beside the
 * note control rather than replacing it: a note is a comment, an adjustment changes what
 * this comparison actually carries, and the two stay visually and functionally distinct.
 */
function AdjustmentControls({ cell, workflowId, comparisonId, onAdjusted }: {
  cell: QuoteComparisonCell; workflowId: string; comparisonId: string; onAdjusted: () => void;
}) {
  const [mode, setMode] = useState<'closed' | 'set' | 'clear' | 'history'>('closed');
  const [rate, setRate] = useState('');
  const [total, setTotal] = useState('');
  const [reason, setReason] = useState('');
  const history = useQuery({
    queryKey: ['quote-comparison-adjustments', workflowId, comparisonId, cell.cellId],
    queryFn: () => api.quoteComparisonAdjustmentHistory(workflowId, comparisonId, cell.cellId!),
    enabled: mode === 'history'
  });

  const set = useMutation({
    mutationFn: () => api.setQuoteComparisonAdjustment(workflowId, comparisonId, cell.cellId!, {
      rate: rate ? Number(rate) : null, total: total ? Number(total) : null, reason: reason.trim()
    }),
    onSuccess: () => { setMode('closed'); setRate(''); setTotal(''); setReason(''); onAdjusted(); }
  });
  const clear = useMutation({
    mutationFn: () => api.clearQuoteComparisonAdjustment(workflowId, comparisonId, cell.cellId!, reason.trim()),
    onSuccess: () => { setMode('closed'); setReason(''); onAdjusted(); }
  });

  if (mode === 'closed') {
    return <div className="button-row" style={{ marginTop: 4 }}>
      <button className="secondary small" onClick={() => setMode('set')}>{cell.hasOverride ? 'Re-adjust' : 'Adjust'}</button>
      {cell.hasOverride && <button className="secondary small" onClick={() => setMode('clear')}>Clear adjustment</button>}
      <button className="secondary small" onClick={() => setMode('history')}>History</button>
    </div>;
  }

  if (mode === 'set') {
    return <div className="inline-form" style={{ marginTop: 4, flexWrap: 'wrap' }}>
      <input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="Rate" type="number" style={{ width: 90 }} />
      <input value={total} onChange={(e) => setTotal(e.target.value)} placeholder="Total (optional if rate given)" type="number" style={{ width: 150 }} />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" style={{ flex: 1, minWidth: 160 }} />
      <button disabled={(!rate && !total) || !reason.trim() || set.isPending} onClick={() => set.mutate()}>{set.isPending ? 'Saving…' : 'Save'}</button>
      <button className="secondary small" onClick={() => setMode('closed')}>Cancel</button>
      <ErrorMessage error={set.error} />
    </div>;
  }

  if (mode === 'clear') {
    return <div className="inline-form" style={{ marginTop: 4 }}>
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for clearing (required)" style={{ flex: 1 }} />
      <button disabled={!reason.trim() || clear.isPending} onClick={() => clear.mutate()}>{clear.isPending ? 'Clearing…' : 'Clear'}</button>
      <button className="secondary small" onClick={() => setMode('closed')}>Cancel</button>
      <ErrorMessage error={clear.error} />
    </div>;
  }

  return <div style={{ marginTop: 4 }}>
    {history.isLoading ? <Busy /> : (history.data?.length ?? 0) === 0
      ? <p className="muted" style={{ fontSize: '0.72rem' }}>No adjustments have been made to this cell.</p>
      : <ul style={{ margin: 0, paddingLeft: 16, fontSize: '0.72rem' }}>
          {history.data!.map((h) => <li key={h.id}>
            {h.action === 'set' ? `Set to ${formatMoney(h.new_total)}` : 'Cleared'} — {h.reason} ({new Date(h.occurred_at).toLocaleDateString()})
          </li>)}
        </ul>}
    <button className="secondary small" style={{ marginTop: 4 }} onClick={() => setMode('closed')}>Close</button>
  </div>;
}

/**
 * Queries to subcontractors about their quote — the issue's own closing step: "the
 * estimator should ... get in touch with the respective subcontractors to raise any
 * queries he may have on the quotes or on the pricing." One group per return, each with
 * its own drafts, a bundled send, and the estimator's own record of what came back.
 */
function QueriesSection({ workflowId, comparisonId, returns, queries, queriesLoading, onChanged }: {
  workflowId: string; comparisonId: string; returns: QuoteComparisonReturn[]; queries: QuoteQuery[]; queriesLoading: boolean;
  onChanged: () => void;
}) {
  const [askingFor, setAskingFor] = useState<string | null>(null);
  const [questionDraft, setQuestionDraft] = useState('');

  const create = useMutation({
    mutationFn: (returnId: string) => api.createQuoteQuery(workflowId, comparisonId, { returnId, question: questionDraft.trim() }),
    onSuccess: () => { setQuestionDraft(''); setAskingFor(null); onChanged(); }
  });
  const send = useMutation({
    mutationFn: (returnId: string) => api.sendQuoteQueries(workflowId, comparisonId, returnId),
    onSuccess: onChanged
  });
  const withdraw = useMutation({
    mutationFn: (queryId: string) => api.withdrawQuoteQuery(workflowId, comparisonId, queryId),
    onSuccess: onChanged
  });

  return <>
    <h4 style={{ marginTop: 16 }}>Queries to subcontractors</h4>
    <p className="muted" style={{ fontSize: '0.8rem' }}>
      Once the comparison is done, get in touch with a subcontractor about anything in their
      quote before making the final adjustments.
    </p>
    {queriesLoading ? <Busy /> : returns.map((ret) => {
      const mine = queries.filter((q) => q.return_id === ret.id);
      const drafts = mine.filter((q) => q.email_status === 'draft');
      return <div key={ret.id} className="panel" style={{ marginTop: 8, background: '#f9fafb' }}>
        <div className="button-row" style={{ justifyContent: 'space-between' }}>
          <strong>{ret.tenderer_name}</strong>
          <div className="button-row">
            {drafts.length > 0 && <button className="secondary small" disabled={send.isPending} onClick={() => send.mutate(ret.id)}>
              {send.isPending ? 'Sending…' : `Send ${drafts.length} draft quer${drafts.length === 1 ? 'y' : 'ies'}`}
            </button>}
            <button className="secondary small" onClick={() => setAskingFor(askingFor === ret.id ? null : ret.id)}>
              {askingFor === ret.id ? 'Cancel' : '+ Ask a question'}
            </button>
          </div>
        </div>
        {askingFor === ret.id && <div className="inline-form" style={{ marginTop: 8 }}>
          <input value={questionDraft} onChange={(e) => setQuestionDraft(e.target.value)} placeholder="Your question" style={{ flex: 1 }} />
          <button disabled={!questionDraft.trim() || create.isPending} onClick={() => create.mutate(ret.id)}>
            {create.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>}
        <ErrorMessage error={create.error ?? send.error} />
        {mine.length === 0
          ? <p className="muted" style={{ fontSize: '0.8rem', marginTop: 8 }}>No queries raised yet.</p>
          : <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {mine.map((q) => <QueryItem
                key={q.id} query={q} workflowId={workflowId} comparisonId={comparisonId}
                onChanged={onChanged} onWithdraw={() => withdraw.mutate(q.id)}
              />)}
            </ul>}
      </div>;
    })}
  </>;
}

function QueryItem({ query, workflowId, comparisonId, onChanged, onWithdraw }: {
  query: QuoteQuery; workflowId: string; comparisonId: string; onChanged: () => void; onWithdraw: () => void;
}) {
  const [logging, setLogging] = useState(false);
  const [response, setResponse] = useState('');
  const [source, setSource] = useState<QuoteQueryResponseSource>('phone');

  const logResponse = useMutation({
    mutationFn: () => api.logQuoteQueryResponse(workflowId, comparisonId, query.id, { response: response.trim(), responseSource: source }),
    onSuccess: () => { setLogging(false); setResponse(''); onChanged(); }
  });

  const open = isQueryOpen(query);
  return <li style={{ marginBottom: 8 }}>
    <div>{query.question}</div>
    <div className="muted" style={{ fontSize: '0.72rem' }}>
      {query.withdrawn_at
        ? 'Withdrawn'
        : query.email_status === 'draft' ? 'Not yet sent'
        : query.email_status === 'sent' ? 'Sent'
        : query.email_status === 'failed' ? `Send failed${query.email_error ? `: ${query.email_error}` : ''}`
        : query.email_status === 'skipped_no_email' ? 'No email on file for this firm'
        : query.email_status}
    </div>
    {query.response && <div className="text-green" style={{ fontSize: '0.78rem', marginTop: 2 }}>“{query.response}” ({query.response_source})</div>}
    {open && <div className="button-row" style={{ marginTop: 4 }}>
      <button className="secondary small" onClick={() => setLogging((v) => !v)}>{logging ? 'Cancel' : 'Log response'}</button>
      <button className="secondary small" onClick={onWithdraw}>Withdraw</button>
    </div>}
    {logging && <div className="inline-form" style={{ marginTop: 4 }}>
      <input value={response} onChange={(e) => setResponse(e.target.value)} placeholder="What did they say?" style={{ flex: 1 }} />
      <select value={source} onChange={(e) => setSource(e.target.value as QuoteQueryResponseSource)}>
        <option value="phone">Phone</option>
        <option value="email">Email</option>
        <option value="meeting">Meeting</option>
        <option value="other">Other</option>
      </select>
      <button disabled={!response.trim() || logResponse.isPending} onClick={() => logResponse.mutate()}>
        {logResponse.isPending ? 'Saving…' : 'Save'}
      </button>
    </div>}
    <ErrorMessage error={logResponse.error} />
  </li>;
}

const STATUS_OPTIONS: QuoteLineStatus[] = ['priced', 'included', 'excluded', 'not_addressed'];

/** A return that arrived as an emailed spreadsheet, keyed straight against the spine rows
 *  already on screen — see recordManualReturn's doc comment for why that needs no fuzzy
 *  matching. */
type ExtraLineDraft = { description: string; unit: string; quantity: string; rate: string; status: QuoteLineStatus; note: string };
const BLANK_EXTRA_LINE: ExtraLineDraft = { description: '', unit: '', quantity: '', rate: '', status: 'priced', note: '' };

function ManualReturnForm({ workflowId, packageName, rows, onDone }: {
  workflowId: string; packageName: string; rows: QuoteComparisonRow[]; onDone: () => void;
}) {
  const [tendererName, setTendererName] = useState('');
  const [programmeWeeks, setProgrammeWeeks] = useState('');
  const [qualifications, setQualifications] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [cells, setCells] = useState<Record<string, { rate: string; status: QuoteLineStatus; note: string }>>({});
  const [extraLines, setExtraLines] = useState<ExtraLineDraft[]>([]);

  const setCell = (rowId: string, patch: Partial<{ rate: string; status: QuoteLineStatus; note: string }>) => {
    setCells((current) => {
      const existing = current[rowId] ?? { rate: '', status: 'priced' as QuoteLineStatus, note: '' };
      return { ...current, [rowId]: { ...existing, ...patch } };
    });
  };
  const setExtraLine = (index: number, patch: Partial<ExtraLineDraft>) => {
    setExtraLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };
  const removeExtraLine = (index: number) => setExtraLines((current) => current.filter((_, i) => i !== index));

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
        }),
      extraLines: extraLines
        .filter((line) => line.description.trim())
        .map((line) => ({
          description: line.description.trim(), unit: line.unit || null,
          quantity: line.quantity ? Number(line.quantity) : null, rate: line.rate ? Number(line.rate) : null,
          status: line.status, note: line.note || null
        }))
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
      <tbody>{rows.filter((row) => row.origin !== 'tenderer_added' && row.origin !== 'tenderer_variant').map((row) => {
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

    <h4 style={{ marginTop: 16 }}>Extra lines</h4>
    <p className="muted" style={{ fontSize: '0.8rem' }}>This tenderer's own addition — not on the ITT bill, so it has no row of its own yet.</p>
    <table className="data-table">
      <thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Status</th><th>Note</th><th /></tr></thead>
      <tbody>{extraLines.map((line, i) => <tr key={i}>
        <td><input value={line.description} onChange={(e) => setExtraLine(i, { description: e.target.value })} placeholder="Description" /></td>
        <td><input type="number" value={line.quantity} onChange={(e) => setExtraLine(i, { quantity: e.target.value })} style={{ width: 80 }} /></td>
        <td><input value={line.unit} onChange={(e) => setExtraLine(i, { unit: e.target.value })} style={{ width: 70 }} /></td>
        <td><input type="number" value={line.rate} onChange={(e) => setExtraLine(i, { rate: e.target.value })} style={{ width: 100 }} /></td>
        <td>
          <select value={line.status} onChange={(e) => setExtraLine(i, { status: e.target.value as QuoteLineStatus })}>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </td>
        <td><input value={line.note} onChange={(e) => setExtraLine(i, { note: e.target.value })} placeholder="Optional" /></td>
        <td><button className="secondary small" onClick={() => removeExtraLine(i)}>Remove</button></td>
      </tr>)}</tbody>
    </table>
    <button className="secondary small" style={{ marginTop: 8 }} onClick={() => setExtraLines((current) => [...current, { ...BLANK_EXTRA_LINE }])}>
      + Add extra line
    </button>

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
