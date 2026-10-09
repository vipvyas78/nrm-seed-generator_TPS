import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type SelfPricingStatus } from './api';

type Edit = { rate: string; status: SelfPricingStatus; note: string };

const STATUSES: Array<{ value: SelfPricingStatus; label: string }> = [
  { value: 'priced', label: 'Priced' },
  { value: 'included', label: 'Included' },
  { value: 'excluded', label: 'Excluded' },
  { value: 'not_addressed', label: 'Not addressed' }
];

const money = (n: number) => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const parseNumber = (text: string): number | null => {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * The main contractor's own pricing form for a package whose route of procurement is
 * "Self priced". It is an in-app form for the contractor's QS, not a portal: the viewer is
 * signed in, so there is no token, no email binding and nobody to invite. The server is
 * the authority on totals; the total shown here is a convenience while typing.
 */
export function SelfPricingPage() {
  const { workflowId = '' } = useParams();
  const [search] = useSearchParams();
  const packageName = search.get('package') ?? '';
  const queryClient = useQueryClient();
  const key = ['self-pricing', workflowId, packageName];
  const query = useQuery({ queryKey: key, queryFn: () => api.getSelfPricing(workflowId, packageName), retry: false });

  const [edits, setEdits] = useState<Record<number, Edit>>({});
  const [header, setHeader] = useState({ programmeWeeks: '', qualifications: '', exclusions: '' });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!query.data) return;
    setEdits(Object.fromEntries(query.data.lines.map((l) => [l.seq, {
      rate: l.rate != null ? String(l.rate) : '', status: l.status, note: l.note ?? ''
    }])));
    setHeader({
      programmeWeeks: query.data.programme_weeks != null ? String(query.data.programme_weeks) : '',
      qualifications: query.data.qualifications ?? '',
      exclusions: query.data.exclusions ?? ''
    });
    setHydrated(true);
  }, [query.data]);

  const submitted = Boolean(query.data?.submitted_at);

  const payload = () => ({
    programmeWeeks: header.programmeWeeks.trim() === '' ? null : Number(header.programmeWeeks),
    qualifications: header.qualifications.trim() || null,
    exclusions: header.exclusions.trim() || null,
    lines: (query.data?.lines ?? []).map((l) => {
      const e = edits[l.seq];
      return { seq: l.seq, quantity: l.quantity, rate: parseNumber(e?.rate ?? ''), status: e?.status ?? l.status, note: e?.note.trim() || null };
    })
  });

  const save = useMutation({
    mutationFn: () => api.saveSelfPricing(workflowId, packageName, payload()),
    onSuccess: (data) => queryClient.setQueryData(key, data)
  });
  const submit = useMutation({
    mutationFn: async () => { await api.saveSelfPricing(workflowId, packageName, payload()); return api.submitSelfPricing(workflowId, packageName); },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key })
  });

  const total = useMemo(() => (query.data?.lines ?? []).reduce((sum, l) => {
    const e = edits[l.seq];
    const rate = parseNumber(e?.rate ?? '');
    return (e?.status ?? l.status) === 'priced' && rate != null && l.quantity != null ? sum + rate * l.quantity : sum;
  }, 0), [query.data, edits]);

  if (!packageName) return <p className="alert alert-red">No package was named.</p>;
  if (query.isLoading) return <p className="muted">Loading the pricing form…</p>;
  if (query.isError || !query.data) {
    return <p className="alert alert-red">{(query.error as Error | null)?.message ?? 'Could not load the pricing form.'}</p>;
  }

  return <div className="self-pricing">
    <p><Link to="/">← Back</Link></p>
    <h2>Self priced: {query.data.package_name}</h2>
    <p className="muted">Priced in-house by {query.data.tenderer_name}. No subcontractors are invited to this package.</p>
    {submitted && <p className="alert alert-green">Submitted. This pricing is now in the quote comparison.</p>}

    <table className="sub-table">
      <thead><tr>
        <th>Description</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Total</th><th>Status</th><th>Note</th>
      </tr></thead>
      <tbody>
        {query.data.lines.map((l) => {
          const e = edits[l.seq] ?? { rate: '', status: l.status, note: '' };
          const rate = parseNumber(e.rate);
          const set = (patch: Partial<Edit>) => setEdits((p) => ({ ...p, [l.seq]: { ...e, ...patch } }));
          return <tr key={l.seq}>
            <td>{l.description}{!l.isPriceable && <div className="muted tiny">scope only</div>}</td>
            <td>{l.quantity ?? ''}</td>
            <td>{l.unit ?? ''}</td>
            <td><input aria-label={`Rate for line ${l.seq}`} value={e.rate} inputMode="decimal" disabled={submitted}
                       onChange={(ev) => set({ rate: ev.target.value })} /></td>
            <td>{e.status === 'priced' && rate != null && l.quantity != null ? money(rate * l.quantity) : ''}</td>
            <td><select aria-label={`Status for line ${l.seq}`} value={e.status} disabled={submitted}
                        onChange={(ev) => set({ status: ev.target.value as SelfPricingStatus })}>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select></td>
            <td><input aria-label={`Note for line ${l.seq}`} value={e.note} disabled={submitted}
                       onChange={(ev) => set({ note: ev.target.value })} /></td>
          </tr>;
        })}
      </tbody>
      <tfoot><tr><td colSpan={4}><strong>Tendered sum</strong></td><td><strong>{money(total)}</strong></td><td colSpan={2} /></tr></tfoot>
    </table>

    <div style={{ marginTop: 12 }}>
      <label>Programme (weeks) <input value={header.programmeWeeks} disabled={submitted} inputMode="numeric"
        onChange={(e) => setHeader((h) => ({ ...h, programmeWeeks: e.target.value.replace(/\D/g, '') }))} /></label>
      <label style={{ display: 'block' }}>Qualifications
        <textarea value={header.qualifications} disabled={submitted}
          onChange={(e) => setHeader((h) => ({ ...h, qualifications: e.target.value }))} /></label>
      <label style={{ display: 'block' }}>Exclusions
        <textarea value={header.exclusions} disabled={submitted}
          onChange={(e) => setHeader((h) => ({ ...h, exclusions: e.target.value }))} /></label>
    </div>

    {(save.isError || submit.isError) &&
      <p className="alert alert-red">{((save.error ?? submit.error) as Error).message}</p>}
    {!submitted && <div style={{ marginTop: 12 }}>
      <button type="button" disabled={!hydrated || save.isPending || submit.isPending} onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Save draft'}
      </button>{' '}
      <button type="button" className="primary" disabled={!hydrated || save.isPending || submit.isPending}
              onClick={() => submit.mutate()}>
        {submit.isPending ? 'Submitting…' : 'Submit pricing'}
      </button>
    </div>}
  </div>;
}
