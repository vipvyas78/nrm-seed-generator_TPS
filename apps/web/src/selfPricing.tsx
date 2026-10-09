import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type SelfPricing, type SelfPricingIndexRow, type SelfPricingState, type SelfPricingStatus } from './api';
import { ErrorMessage } from './pages';

const STATUSES: Array<{ value: SelfPricingStatus; label: string }> = [
  { value: 'priced', label: 'Priced' },
  { value: 'included', label: 'Included' },
  { value: 'excluded', label: 'Excluded' },
  { value: 'not_addressed', label: 'Not addressed' }
];

const STATE_LABEL: Record<SelfPricingState, { text: string; badge: string }> = {
  not_started: { text: 'Not started', badge: 'badge-grey' },
  in_progress: { text: 'In progress', badge: 'badge-amber' },
  complete: { text: 'Saved as draft', badge: 'badge-green' },
  changed_since_transfer: { text: 'Changed since last transfer', badge: 'badge-blue' }
};

const AUTOSAVE_MS = 1500;
const money = (n: number) => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const parseNumber = (text: string): number | null => {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** One row as the QS is editing it. Numbers are held as text so an empty box can mean "not decided". */
type Row = {
  key: string;
  seq: number | null;
  description: string;
  unit: string;
  quantity: string;
  measuredQuantity: number | null;
  rate: string;
  status: SelfPricingStatus;
  note: string;
  remarks: string;
  isPriceable: boolean;
  added: boolean;
};
type Filter = 'all' | 'unpriced' | 'adjusted' | 'own';

let keyCounter = 0;
const newKey = () => `new-${++keyCounter}`;
const text = (n: number | null) => (n == null ? '' : String(n));

const toRows = (data: SelfPricing): Row[] => data.lines.map((l) => ({
  key: `seq-${l.seq}`, seq: l.seq, description: l.description, unit: l.unit ?? '',
  quantity: text(l.quantity), measuredQuantity: l.measuredQuantity, rate: text(l.rate),
  status: l.status, note: l.note ?? '', remarks: l.remarks ?? '', isPriceable: l.isPriceable, added: l.added
}));

const isUnpriced = (r: Row) => (r.isPriceable || r.added) && r.status === 'priced' && parseNumber(r.rate) == null;
const isAdjusted = (r: Row) => !r.added && parseNumber(r.quantity) !== r.measuredQuantity;

// ── Step 4 ────────────────────────────────────────────────────────────────────

/**
 * Step 4, Self Pricing: every package routed "Self priced" at Step 1, how far through it the
 * QS is, and the BoQ itself. The BoQ is worked in batches, so the index is what a returning
 * QS lands on.
 */
export function Step4SelfPricing({ workflowId, initialPackage }: { workflowId: string; initialPackage?: string | null }) {
  const [open, setOpen] = useState<string | null>(initialPackage ?? null);
  const index = useQuery({ queryKey: ['self-pricing-index', workflowId], queryFn: () => api.listSelfPricing(workflowId) });

  if (open) {
    return <SelfPricingBoq workflowId={workflowId} packageName={open} onClose={() => setOpen(null)} />;
  }
  if (index.isLoading) return <p className="muted">Loading self-priced packages…</p>;
  if (index.isError) return <ErrorMessage error={index.error} />;
  const rows: SelfPricingIndexRow[] = index.data ?? [];
  if (rows.length === 0) {
    return <p className="muted">No packages are self priced. Choose the “Self priced” route for a package at Step 1 and confirm it.</p>;
  }
  return <div>
    <p className="muted tiny">
      These packages are priced in-house. Open one to price it; your work is saved as you go, and you can
      leave and pick it up where you stopped.
    </p>
    <table className="sub-table">
      <thead><tr><th>#</th><th>Package</th><th>Progress</th><th>Status</th><th>Last edited</th><th /></tr></thead>
      <tbody>
        {rows.map((r) => {
          const pct = r.priceable_count ? Math.round((r.addressed_count / r.priceable_count) * 100) : 0;
          const state = STATE_LABEL[r.state];
          return <tr key={r.package_name}>
            <td>{r.package_seq ?? '—'}</td>
            <td><strong>{r.package_name}</strong></td>
            <td>{r.state === 'not_started' ? '—' : `${r.addressed_count} of ${r.priceable_count} lines (${pct}%)`}</td>
            <td><span className={`badge ${state.badge}`}>{state.text}</span></td>
            <td className="tiny">{r.updated_at ? new Date(r.updated_at).toLocaleString('en-GB') : '—'}</td>
            <td><button className="small" onClick={() => setOpen(r.package_name)}>
              {r.state === 'not_started' ? 'Start pricing' : 'Open BoQ'}
            </button></td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

/** Deep link from Step 1's "Enter prices", outside the wizard. */
export function SelfPricingPage() {
  const { workflowId = '' } = useParams();
  const [search] = useSearchParams();
  const packageName = search.get('package');
  return <div className="self-pricing">
    <p><Link to="/">← Back</Link></p>
    <Step4SelfPricing workflowId={workflowId} initialPackage={packageName} />
  </div>;
}

// ── The BoQ ───────────────────────────────────────────────────────────────────

function SelfPricingBoq({ workflowId, packageName, onClose }: { workflowId: string; packageName: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['self-pricing', workflowId, packageName],
    queryFn: () => api.getSelfPricing(workflowId, packageName),
    retry: false, refetchOnWindowFocus: false
  });

  const [rows, setRows] = useState<Row[]>([]);
  const [header, setHeader] = useState({ programmeWeeks: '', qualifications: '', exclusions: '' });
  const [filter, setFilter] = useState<Filter>('all');
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error' | 'stale'>('saved');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ version: number; status: 'in_progress' | 'complete'; changed: boolean } | null>(null);

  // The latest of everything, readable from timers and unload handlers without stale closures.
  const latest = useRef({ rows, header, meta, saveState });
  latest.current = { rows, header, meta, saveState };
  const editVersion = useRef(0);       // bumped by every edit
  const inFlight = useRef(false);
  const timer = useRef<number | null>(null);
  const firstUnpriced = useRef<HTMLTableRowElement | null>(null);
  const scrolled = useRef(false);

  const hydrate = useCallback((data: SelfPricing) => {
    setRows(toRows(data));
    setHeader({
      programmeWeeks: text(data.programme_weeks),
      qualifications: data.qualifications ?? '',
      exclusions: data.exclusions ?? ''
    });
    setMeta({ version: data.version, status: data.status, changed: data.changed_since_transfer });
    setSaveState('saved');
    setSavedAt(new Date(data.updated_at));
  }, []);

  useEffect(() => { if (query.data) hydrate(query.data); }, [query.data, hydrate]);

  // Resume where the QS left off: scroll to the first line still needing a rate.
  useEffect(() => {
    if (scrolled.current || rows.length === 0) return;
    scrolled.current = true;
    if (rows.some((r) => parseNumber(r.rate) != null || r.status !== 'priced')) {
      firstUnpriced.current?.scrollIntoView({ block: 'center' });
    }
  }, [rows]);

  const payload = () => {
    const { rows: rs, header: h, meta: m } = latest.current;
    return {
      version: m!.version,
      programmeWeeks: h.programmeWeeks.trim() === '' ? null : Number(h.programmeWeeks),
      qualifications: h.qualifications.trim() || null,
      exclusions: h.exclusions.trim() || null,
      lines: rs.map((r) => ({
        seq: r.seq, description: r.description, unit: r.unit.trim() || null,
        quantity: parseNumber(r.quantity), rate: parseNumber(r.rate), status: r.status,
        note: r.note.trim() || null, remarks: r.remarks.trim() || null
      }))
    };
  };

  /** Saves now. Serialised: a second call while one is in flight waits for it and goes again. */
  const flush = useCallback(async (keepalive = false): Promise<boolean> => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    if (!latest.current.meta) return true;
    if (inFlight.current) { timer.current = window.setTimeout(() => void flush(), 250); return false; }
    inFlight.current = true;
    const sentAt = editVersion.current;
    const body = payload();
    const sentSeqs = new Set(body.lines.map((l) => l.seq).filter((s): s is number => s != null));
    const sentNewKeys = latest.current.rows.filter((r) => r.seq == null).map((r) => r.key);
    setSaveState('saving');
    try {
      const data = await api.saveSelfPricing(workflowId, packageName, body, keepalive);
      queryClient.setQueryData(['self-pricing', workflowId, packageName], data);
      if (editVersion.current === sentAt) {
        hydrate(data);
      } else {
        // The QS kept typing while this was in flight. Keep their text; only adopt what the
        // server minted — the new version, and a seq for each line that was just added.
        const minted = data.lines.filter((l) => l.added && !sentSeqs.has(l.seq)).map((l) => l.seq);
        setRows((rs) => rs.map((r) => {
          const i = sentNewKeys.indexOf(r.key);
          return i >= 0 && minted[i] != null ? { ...r, seq: minted[i], key: `seq-${minted[i]}` } : r;
        }));
        setMeta({ version: data.version, status: data.status, changed: data.changed_since_transfer });
        setSaveState('dirty');
        setSavedAt(new Date(data.updated_at));
        timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
      }
      setSaveError(null);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not save';
      setSaveError(message);
      setSaveState(/changed elsewhere/i.test(message) ? 'stale' : 'error');
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [workflowId, packageName, hydrate, queryClient]);

  const touch = () => {
    editVersion.current += 1;
    setSaveState((s) => (s === 'stale' ? s : 'dirty'));
    setCompleted(null);
    if (latest.current.saveState === 'stale') return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  // Nothing is lost by leaving: save on tab hide, on closing, and on leaving this screen.
  useEffect(() => {
    const dirty = () => latest.current.saveState === 'dirty' || latest.current.saveState === 'error';
    const onHide = () => { if (document.visibilityState === 'hidden' && dirty()) void flush(true); };
    const onUnload = () => { if (dirty()) void flush(true); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', onUnload);
      if (dirty()) void flush(true);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [flush]);

  const setRow = (key: string, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    touch();
  };
  const addRow = () => {
    setRows((rs) => [...rs, {
      key: newKey(), seq: null, description: '', unit: 'item', quantity: '1', measuredQuantity: null,
      rate: '', status: 'priced', note: '', remarks: '', isPriceable: true, added: true
    }]);
    touch();
  };
  const removeRow = (key: string) => { setRows((rs) => rs.filter((r) => r.key !== key)); touch(); };

  const complete = useMutation({
    mutationFn: async () => {
      if (!(await flush())) throw new Error(latest.current.saveState === 'stale'
        ? 'Reload first: this BoQ was changed elsewhere.' : 'Could not save your latest changes — try again.');
      return api.completeSelfPricing(workflowId, packageName);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['self-pricing', workflowId, packageName], data);
      queryClient.invalidateQueries({ queryKey: ['self-pricing-index', workflowId] });
      hydrate(data);
      setCompleted(`Saved as draft and transferred — total £${money(data.tendered_sum)}. You can keep editing; re-transfer after any change.`);
    }
  });

  const reload = async () => {
    const fresh = await query.refetch();
    if (fresh.data) { hydrate(fresh.data); setSaveError(null); }
  };

  const total = useMemo(() => rows.reduce((sum, r) => {
    const q = parseNumber(r.quantity); const rate = parseNumber(r.rate);
    return r.status === 'priced' && q != null && rate != null ? sum + q * rate : sum;
  }, 0), [rows]);
  const priceable = rows.filter((r) => r.isPriceable || r.added);
  const addressed = priceable.filter((r) => r.status !== 'priced' || parseNumber(r.rate) != null).length;
  const pct = priceable.length ? Math.round((addressed / priceable.length) * 100) : 0;
  const firstUnpricedKey = rows.find(isUnpriced)?.key;

  const visible = rows.filter((r) =>
    filter === 'unpriced' ? isUnpriced(r) : filter === 'adjusted' ? isAdjusted(r) : filter === 'own' ? r.added : true);

  if (query.isLoading) return <p className="muted">Loading the BoQ…</p>;
  if (query.isError || !meta) return <>
    <p><button className="small secondary" onClick={onClose}>← All self-priced packages</button></p>
    <ErrorMessage error={query.error ?? new Error('Could not load the BoQ.')} />
  </>;

  const statusText = saveState === 'saving' ? 'Saving…'
    : saveState === 'dirty' ? 'Unsaved changes…'
    : saveState === 'error' ? 'Not saved — will retry'
    : saveState === 'stale' ? 'Changed elsewhere'
    : savedAt ? `Saved · ${savedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Saved';

  return <div className="self-pricing">
    <p><button className="small secondary" onClick={onClose}>← All self-priced packages</button></p>
    <h3>{packageName}</h3>
    <p className="muted tiny">
      Priced in-house by {query.data?.tenderer_name}. Change any quantity you disagree with (say why), add items the
      app missed, then save as a draft. Every change is saved as you go.
    </p>

    <div className="pkg-actions">
      <div style={{ flex: 1, minWidth: 160 }}>
        <div style={{ background: '#e5e7eb', borderRadius: 4, height: 8 }}>
          <div style={{ width: `${pct}%`, background: '#2563eb', height: 8, borderRadius: 4 }} />
        </div>
        <span className="tiny muted">{addressed} of {priceable.length} lines addressed ({pct}%)</span>
      </div>
      <span className={`tiny ${saveState === 'error' || saveState === 'stale' ? '' : 'muted'}`}
            style={saveState === 'error' || saveState === 'stale' ? { color: '#b91c1c' } : undefined}
            role="status" aria-live="polite">{statusText}</span>
      <button className="small secondary" disabled={!firstUnpricedKey}
              onClick={() => document.getElementById(`sp-${firstUnpricedKey}`)?.scrollIntoView({ block: 'center' })}>
        Jump to first unpriced
      </button>
    </div>

    {saveState === 'stale' && <div className="alert alert-red">
      {saveError} <button className="small" onClick={() => void reload()}>Reload latest</button>
    </div>}
    {saveState === 'error' && <div className="alert alert-red">
      {saveError} <button className="small" onClick={() => void flush()}>Retry now</button>
    </div>}
    {meta.status === 'complete' && (meta.changed
      ? <p className="alert alert-amber">Changed since the last transfer. Save as draft again to re-transfer.</p>
      : <p className="alert alert-green">Saved as draft and transferred. You can still make changes.</p>)}
    {completed && <p className="alert alert-green">{completed}</p>}
    <ErrorMessage error={complete.error} />

    <div className="pkg-actions">
      {(['all', 'unpriced', 'adjusted', 'own'] as Filter[]).map((f) =>
        <button key={f} className={`small ${filter === f ? '' : 'secondary'}`} onClick={() => setFilter(f)}>
          {{ all: 'All', unpriced: 'Unpriced', adjusted: 'Adjusted quantity', own: 'My items' }[f]}
        </button>)}
    </div>

    <table className="sub-table">
      <thead><tr>
        <th>Description</th><th>Qty</th><th>Unit</th><th>Rate £</th><th>Total £</th><th>Status</th><th>Note / remark</th><th />
      </tr></thead>
      <tbody>
        {visible.map((r) => {
          const q = parseNumber(r.quantity); const rate = parseNumber(r.rate);
          const adjusted = isAdjusted(r);
          return <tr key={r.key} id={`sp-${r.key}`} ref={r.key === firstUnpricedKey ? firstUnpriced : undefined}
                     className={isUnpriced(r) ? 'unpriced-row' : undefined}>
            <td>
              {r.added
                ? <input aria-label="Description of added item" value={r.description} placeholder="Describe the item…"
                         onChange={(e) => setRow(r.key, { description: e.target.value })} />
                : <>{r.description}{!r.isPriceable && <div className="muted tiny">scope only</div>}</>}
              {r.added && <div className="badge badge-blue">my item</div>}
              {adjusted && <div className="badge badge-amber">QS adjusted</div>}
            </td>
            <td>
              <input aria-label={`Quantity for ${r.description || 'new item'}`} style={{ width: 80 }} inputMode="decimal"
                     value={r.quantity} onChange={(e) => setRow(r.key, { quantity: e.target.value })} />
              {adjusted && <div className="muted tiny">app: {r.measuredQuantity ?? '—'}</div>}
            </td>
            <td>{r.added
              ? <input aria-label="Unit" style={{ width: 60 }} value={r.unit} onChange={(e) => setRow(r.key, { unit: e.target.value })} />
              : r.unit}</td>
            <td><input aria-label={`Rate for ${r.description || 'new item'}`} style={{ width: 90 }} inputMode="decimal"
                       value={r.rate} onChange={(e) => setRow(r.key, { rate: e.target.value })} /></td>
            <td>{r.status === 'priced' && q != null && rate != null ? money(q * rate) : ''}</td>
            <td><select aria-label={`Status for ${r.description || 'new item'}`} value={r.status}
                        onChange={(e) => setRow(r.key, { status: e.target.value as SelfPricingStatus })}>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select></td>
            <td>
              {adjusted && <input aria-label="Why the quantity differs" placeholder="Why the quantity differs (required)"
                                  value={r.remarks} onChange={(e) => setRow(r.key, { remarks: e.target.value })} />}
              <input aria-label="Note" placeholder={r.status === 'excluded' ? 'Why excluded (required)' : 'Note'}
                     value={r.note} onChange={(e) => setRow(r.key, { note: e.target.value })} />
            </td>
            <td>{r.added && <button className="small secondary" aria-label="Remove item" onClick={() => removeRow(r.key)}>✕</button>}</td>
          </tr>;
        })}
        {visible.length === 0 && <tr><td colSpan={8} className="muted">Nothing matches this filter.</td></tr>}
      </tbody>
      <tfoot><tr>
        <td colSpan={4}><strong>Tendered sum</strong></td><td><strong>{money(total)}</strong></td><td colSpan={3} />
      </tr></tfoot>
    </table>
    <p><button className="small secondary" onClick={addRow}>+ Add an item</button></p>

    <div style={{ marginTop: 12 }}>
      <label>Programme (weeks) <input value={header.programmeWeeks} inputMode="numeric"
        onChange={(e) => { setHeader((h) => ({ ...h, programmeWeeks: e.target.value.replace(/\D/g, '') })); touch(); }} /></label>
      <label style={{ display: 'block' }}>Qualifications
        <textarea value={header.qualifications}
          onChange={(e) => { setHeader((h) => ({ ...h, qualifications: e.target.value })); touch(); }} /></label>
      <label style={{ display: 'block' }}>Exclusions
        <textarea value={header.exclusions}
          onChange={(e) => { setHeader((h) => ({ ...h, exclusions: e.target.value })); touch(); }} /></label>
    </div>

    <div style={{ marginTop: 12 }}>
      <button type="button" className="primary" disabled={complete.isPending || saveState === 'stale'}
              onClick={() => complete.mutate()}>
        {complete.isPending ? 'Saving…' : meta.status === 'complete' ? 'Save as draft again (re-transfer)' : 'Save as draft'}
      </button>
    </div>
  </div>;
}
