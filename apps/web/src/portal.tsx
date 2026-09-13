import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { portalApi, type PortalLineStatus } from './api';

type PortalLineEdit = { quantity: string; rate: string; status: PortalLineStatus; note: string };

/**
 * The subcontractor pricing portal — the PUBLIC page an invited tenderer opens from their
 * ITT email. Rendered outside `<AppShell/>` (see main.tsx): no BuildFlow branding, no sign-in
 * button, because the viewer is not a BuildFlow user. What stands between this page and a
 * competitor's rates is Cloudflare Access (an edge policy naming the invited domains) plus
 * the token-to-recipient-identity binding the server checks on every request
 * (`resolvePortalToken` in tenderPrepDb.ts) — this component trusts the server's answer and
 * does no authorization of its own.
 *
 * Local edit state is kept independent of the query cache so typing a rate does not fight
 * with the query's own refetches; a save/submit response simply replaces the server's copy
 * wholesale, the same "the server's answer wins" rule the rest of this app follows.
 */
export function PortalPage() {
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['portal', token], queryFn: () => portalApi.get(token), retry: false });

  const [lines, setLines] = useState<Record<string, PortalLineEdit>>({});
  const [header, setHeader] = useState({ programmeWeeks: '', qualifications: '', exclusions: '' });
  const [hydrated, setHydrated] = useState(false);
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);
  const [newLine, setNewLine] = useState({ description: '', quantity: '', unit: '' });

  // Hydrated ONCE from the first successful load — re-running this on every refetch would
  // overwrite whatever the tenderer has typed since. A resend/reopen invalidates the
  // query explicitly (see the save/submit mutations below), which is the only time this
  // should re-run. A line added later (see `addLine` below) is merged in at that point
  // instead, since by then this has already run once.
  useEffect(() => {
    if (!query.data || hydrated) return;
    const nextLines: typeof lines = {};
    for (const line of query.data.lines) {
      nextLines[line.id] = { quantity: line.quantity ?? '', rate: line.rate ?? '', status: line.status, note: line.note ?? '' };
    }
    setLines(nextLines);
    setHeader({
      programmeWeeks: query.data.programme_weeks != null ? String(query.data.programme_weeks) : '',
      qualifications: query.data.qualifications ?? '',
      exclusions: query.data.exclusions ?? ''
    });
    setHydrated(true);
  }, [query.data, hydrated]);

  const buildDraftInput = () => ({
    programmeWeeks: header.programmeWeeks.trim() ? Number(header.programmeWeeks) : null,
    qualifications: header.qualifications.trim() || null,
    exclusions: header.exclusions.trim() || null,
    lines: Object.entries(lines).map(([id, l]) => ({
      id, quantity: l.quantity.trim() ? Number(l.quantity) : null,
      rate: l.rate.trim() ? Number(l.rate) : null, status: l.status, note: l.note.trim() || null
    }))
  });

  const save = useMutation({
    mutationFn: () => portalApi.saveDraft(token, buildDraftInput()),
    onSuccess: (result) => queryClient.setQueryData(['portal', token], result)
  });
  const submit = useMutation({
    mutationFn: async () => { await portalApi.saveDraft(token, buildDraftInput()); return portalApi.submit(token); },
    onSuccess: (result) => { queryClient.setQueryData(['portal', token], result); setConfirmingSubmit(false); }
  });

  // The hydrate effect above only ever runs once, so a line minted by this mutation (an id
  // the browser has never seen) has to be merged into `lines` here too, or it would render
  // fine (the per-row fallback below covers that) but never make it into a save/submit.
  const addLine = useMutation({
    mutationFn: () => portalApi.addLine(token, {
      description: newLine.description.trim(),
      quantity: newLine.quantity.trim() ? Number(newLine.quantity) : null,
      unit: newLine.unit.trim() || null
    }),
    onSuccess: (result) => {
      queryClient.setQueryData(['portal', token], result);
      setLines((prev) => {
        const next = { ...prev };
        for (const line of result.lines) {
          if (!next[line.id]) next[line.id] = { quantity: line.quantity ?? '', rate: line.rate ?? '', status: line.status, note: line.note ?? '' };
        }
        return next;
      });
      setNewLine({ description: '', quantity: '', unit: '' });
    }
  });
  const deleteLine = useMutation({
    mutationFn: (lineId: string) => portalApi.deleteLine(token, lineId),
    onSuccess: (result, lineId) => {
      queryClient.setQueryData(['portal', token], result);
      setLines((prev) => {
        const { [lineId]: _removed, ...rest } = prev;
        return rest;
      });
    }
  });

  const total = useMemo(() => {
    if (!query.data) return 0;
    return query.data.lines.reduce((sum, line) => {
      const edit = lines[line.id];
      if (!edit || edit.status !== 'priced') return sum;
      const rate = Number(edit.rate);
      const quantity = edit.quantity.trim() ? Number(edit.quantity) : null;
      if (!Number.isFinite(rate) || quantity == null || !Number.isFinite(quantity)) return sum;
      return sum + rate * quantity;
    }, 0);
  }, [query.data, lines]);

  if (query.isLoading) return <PortalShell><p className="muted">Loading…</p></PortalShell>;
  if (query.error) return <PortalShell><PortalError error={query.error} /></PortalShell>;
  if (!query.data) return null;

  const pkg = query.data;
  const submitted = pkg.submitted_at !== null;
  const readOnly = submitted;

  return <PortalShell>
    <div className="portal-header">
      <h1>{pkg.package_name}</h1>
      <p className="muted">Pricing on behalf of {pkg.tenderer_name} ({pkg.recipient_email})</p>
      {pkg.tender_return_deadline && <p className="muted">Return by {pkg.tender_return_deadline}</p>}
    </div>

    {submitted && <div className="alert alert-green">
      Submitted{pkg.submitted_at ? ` on ${new Date(pkg.submitted_at).toLocaleString()}` : ''}. This return is now
      read-only. If you need to change it, ask whoever sent you this link to reopen it.
    </div>}

    {save.isSuccess && !save.isPending && <div className="alert alert-grey">Draft saved.</div>}
    {save.error && <PortalError error={save.error} />}
    {submit.error && <PortalError error={submit.error} />}
    {addLine.error && <PortalError error={addLine.error} />}
    {deleteLine.error && <PortalError error={deleteLine.error} />}

    <div className="table-scroll">
      <table className="data-table portal-lines">
        <thead>
          <tr>
            <th>Description</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Total</th><th>Status</th><th>Note</th><th></th>
          </tr>
        </thead>
        <tbody>
          {pkg.lines.map((line) => {
            const edit = lines[line.id] ?? { quantity: line.quantity ?? '', rate: '', status: line.status, note: '' };
            const rate = Number(edit.rate);
            const quantity = edit.quantity.trim() ? Number(edit.quantity) : null;
            const lineTotal = edit.status === 'priced' && Number.isFinite(rate) && quantity != null && Number.isFinite(quantity)
              ? rate * quantity : null;
            return <tr key={line.id}>
              <td>{line.description}{line.ge_code ? <span className="tiny muted"> ({line.ge_code})</span> : null}</td>
              <td>
                <input
                  type="number" min={0} step="0.001" disabled={readOnly || !line.is_priceable}
                  value={edit.quantity}
                  onChange={(e) => setLines((prev) => ({ ...prev, [line.id]: { ...edit, quantity: e.target.value } }))}
                />
              </td>
              <td>{line.unit ?? '—'}</td>
              <td>
                <input
                  type="number" min={0} step="0.01" disabled={readOnly || !line.is_priceable}
                  value={edit.rate}
                  onChange={(e) => setLines((prev) => ({ ...prev, [line.id]: { ...edit, rate: e.target.value } }))}
                />
              </td>
              <td className="tiny">{lineTotal != null ? lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
              <td>
                <select
                  className="small-select" disabled={readOnly}
                  value={edit.status}
                  onChange={(e) => setLines((prev) => ({ ...prev, [line.id]: { ...edit, status: e.target.value as PortalLineStatus } }))}
                >
                  <option value="not_addressed">Not addressed</option>
                  <option value="priced">Priced</option>
                  <option value="included">Included (no separate rate)</option>
                  <option value="excluded">Excluded</option>
                </select>
              </td>
              <td>
                <input
                  type="text" disabled={readOnly} value={edit.note}
                  onChange={(e) => setLines((prev) => ({ ...prev, [line.id]: { ...edit, note: e.target.value } }))}
                  placeholder={edit.status === 'excluded' ? 'Reason for exclusion' : ''}
                />
              </td>
              <td>
                {line.added_by_tenderer && <button
                  type="button" className="secondary tiny" disabled={readOnly || deleteLine.isPending}
                  onClick={() => deleteLine.mutate(line.id)}
                >Remove</button>}
              </td>
            </tr>;
          })}
          {!readOnly && <tr className="portal-add-line">
            <td>
              <input
                type="text" placeholder="Description of added item" value={newLine.description}
                onChange={(e) => setNewLine((prev) => ({ ...prev, description: e.target.value }))}
              />
            </td>
            <td>
              <input
                type="number" min={0} step="0.001" placeholder="Qty" value={newLine.quantity}
                onChange={(e) => setNewLine((prev) => ({ ...prev, quantity: e.target.value }))}
              />
            </td>
            <td>
              <input
                type="text" placeholder="Unit" value={newLine.unit}
                onChange={(e) => setNewLine((prev) => ({ ...prev, unit: e.target.value }))}
              />
            </td>
            <td colSpan={4}></td>
            <td>
              <button
                type="button" className="secondary tiny" disabled={!newLine.description.trim() || addLine.isPending}
                onClick={() => addLine.mutate()}
              >{addLine.isPending ? 'Adding…' : 'Add row'}</button>
            </td>
          </tr>}
        </tbody>
        <tfoot>
          <tr><td colSpan={4}><strong>Total (priced lines)</strong></td>
            <td colSpan={3}><strong>{total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
            <td></td></tr>
        </tfoot>
      </table>
    </div>

    <div className="panel">
      <h3>Your return</h3>
      <div className="compose-field">
        <label>Programme (weeks)</label>
        <input
          type="number" min={0} disabled={readOnly} value={header.programmeWeeks}
          onChange={(e) => setHeader((prev) => ({ ...prev, programmeWeeks: e.target.value }))}
        />
      </div>
      <div className="compose-field">
        <label>Qualifications</label>
        <textarea
          rows={3} disabled={readOnly} value={header.qualifications}
          onChange={(e) => setHeader((prev) => ({ ...prev, qualifications: e.target.value }))}
        />
      </div>
      <div className="compose-field">
        <label>Exclusions</label>
        <textarea
          rows={3} disabled={readOnly} value={header.exclusions}
          onChange={(e) => setHeader((prev) => ({ ...prev, exclusions: e.target.value }))}
        />
      </div>
    </div>

    {!readOnly && <div className="button-row">
      <button className="secondary" disabled={save.isPending || submit.isPending} onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Save draft'}
      </button>
      {!confirmingSubmit
        ? <button disabled={save.isPending || submit.isPending} onClick={() => setConfirmingSubmit(true)}>Submit</button>
        : <span className="inline-form">
            <span className="tiny">Submitting locks this return — you will need it reopened to change it. Continue?</span>
            <button disabled={submit.isPending} onClick={() => submit.mutate()}>{submit.isPending ? 'Submitting…' : 'Yes, submit'}</button>
            <button className="secondary" disabled={submit.isPending} onClick={() => setConfirmingSubmit(false)}>Cancel</button>
          </span>}
    </div>}
  </PortalShell>;
}

function PortalShell({ children }: { children: React.ReactNode }) {
  return <main className="portal-shell">
    <div className="portal-content">{children}</div>
  </main>;
}

function PortalError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return <p className="error">{message}</p>;
}
