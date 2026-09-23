import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type Addendum, type AddendumDelta } from './api';
import {
  baselineResolutionMessage, buildApprovePayload, deltaIsUnchanged, deltaIsWordingDominated,
  describeDeltaChange, sortDeltaPackages,
} from './addendumDelta';
import { Busy, ErrorMessage } from './pages';

/**
 * The tender addendum — raised on what a revised take-off changed, decided here
 * (BuildFlow issue #42/#68/#78). BuildFlow computes the delta this snapshots at
 * creation; every decision from here on — which packages, what the revised return date
 * is, whether it goes out — is TPS's.
 *
 * TWO BACKEND GUARANTEES THIS COMPONENT MUST NOT UNDO:
 *  1. The package set is RE-READ inside the approval transaction (tenderPrepDb.ts's
 *     `approveAddendum`) — a stale screen gets a named refusal, not a silent partial
 *     approve. The disabled button here is a courtesy, not the guard.
 *  2. `available: false` on the delta (or on its conflicts/documents sub-objects) means
 *     the comparison was NEVER MADE — it must never render as "nothing changed". See
 *     addendumDelta.ts, which is unit-tested precisely because conflating the two is the
 *     one failure mode that matters on this screen.
 */

const STATUS_TONE: Record<Addendum['status'], string> = {
  draft: 'badge-grey',
  awaiting_approval: 'badge-amber',
  approved: 'badge-blue',
  issued: 'badge-green',
  cancelled: 'badge-red',
};

/** The header control: a button carrying a badge for addenda awaiting approval, and the
 *  modal it opens. `initialAddendumId` is the `?addendum=` deep link a notification's
 *  `addendum_approval_required` sends here (tenderPrepDb.ts's `addendumDeepLink`). */
export function AddendaButton({ workflowId, initialAddendumId }: {
  workflowId: string; initialAddendumId?: string | null;
}) {
  const [open, setOpen] = useState(Boolean(initialAddendumId));
  const list = useQuery({ queryKey: ['addenda', workflowId], queryFn: () => api.listAddenda(workflowId) });
  const pending = (list.data ?? []).filter((a) => a.status === 'awaiting_approval').length;

  // A deep link arriving after the button has already mounted (e.g. the bell was
  // clicked from a page that was already open) still has to open the modal.
  useEffect(() => {
    if (initialAddendumId) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAddendumId]);

  return <>
    <button className="secondary small" onClick={() => setOpen(true)}>
      Addenda{pending > 0 && <span className="badge badge-amber" style={{ marginLeft: 6 }}>{pending}</span>}
    </button>
    {open && <AddendumModal workflowId={workflowId} initialAddendumId={initialAddendumId} onClose={() => setOpen(false)} />}
  </>;
}

function AddendumModal({ workflowId, initialAddendumId, onClose }: {
  workflowId: string; initialAddendumId?: string | null; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(initialAddendumId ?? null);
  const list = useQuery({ queryKey: ['addenda', workflowId], queryFn: () => api.listAddenda(workflowId) });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['addenda', workflowId] });

  const create = useMutation({
    mutationFn: () => api.createAddendum(workflowId),
    onSuccess: (result) => { invalidate(); setOpenId(result.id); }
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const addenda = list.data ?? [];
  const open = addenda.find((a) => a.id === openId);

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-header">
        <h3>{open ? `Addendum ${open.seq}` : 'Addenda'}</h3>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="modal-body">
        {!open && <>
          <div className="button-row" style={{ justifyContent: 'flex-start', marginBottom: 12 }}>
            <button className="small" onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? 'Checking…' : 'Check for a new addendum'}
            </button>
          </div>
          <ErrorMessage error={create.error} />
          {list.isLoading
            ? <Busy />
            : addenda.length === 0
              ? <p className="muted">No addenda have been raised for this tender yet.</p>
              : <table className="data-table">
                  <thead><tr><th>#</th><th>Status</th><th>Raised</th><th>Packages</th><th /></tr></thead>
                  <tbody>
                    {addenda.map((a) => <tr key={a.id}>
                      <td>{a.seq}</td>
                      <td><span className={`badge ${STATUS_TONE[a.status]}`}>{a.status.replace('_', ' ')}</span></td>
                      <td>{new Date(a.created_at).toLocaleString()}</td>
                      <td>{a.packages.length}</td>
                      <td><button className="small secondary" onClick={() => setOpenId(a.id)}>Open</button></td>
                    </tr>)}
                  </tbody>
                </table>}
        </>}
        {open && <AddendumDetail
          key={open.id}
          addendum={open}
          onApproved={invalidate}
          onIssued={invalidate}
          onBack={() => setOpenId(null)}
        />}
      </div>
    </div>
  </div>;
}

/**
 * The approval body: what changed, the tick per package (pre-ticked to what BuildFlow
 * proposed, editable, held locally until Approve is pressed), the revised return date
 * per package, and the unattributed bucket shown as a thing to decide rather than
 * scrolled past.
 *
 * Local state is seeded from what the SERVER holds (`addendum.packages`), not from the
 * proposal alone — re-opening an already-approved addendum must show its real state,
 * not the original proposal.
 */
export function AddendumDetail({ addendum, onApproved, onIssued, onBack }: {
  addendum: Addendum;
  onApproved: () => void;
  onIssued: () => void;
  onBack: () => void;
}) {
  const delta = addendum.delta;
  const editable = addendum.status === 'awaiting_approval';

  const [edits, setEdits] = useState<Record<string, { included: boolean; revisedReturnDeadline: string }>>(
    () => Object.fromEntries(addendum.packages.map((p) => [p.package_name, {
      included: p.included, revisedReturnDeadline: p.revised_return_deadline ?? ''
    }]))
  );

  const approve = useMutation({
    mutationFn: () => api.approveAddendum(addendum.id, { packages: buildApprovePayload(addendum.packages, edits) }),
    onSuccess: onApproved
  });
  const issue = useMutation({ mutationFn: () => api.issueAddendum(addendum.id), onSuccess: onIssued });

  const deltaPackageByWp = new Map(delta.packages.map((p) => [p.work_package ?? '\0unattributed', p]));
  const sortedPackages = sortDeltaPackages(addendum.packages);

  const notice = baselineResolutionMessage(delta.baseline_resolution);
  const nothingChanged = deltaIsUnchanged(delta);
  const wordingDominated = deltaIsWordingDominated(delta.rung_mix);

  return <div>
    <button className="small secondary" onClick={onBack} style={{ marginBottom: 12 }}>← All addenda</button>

    <div style={{ marginBottom: 8 }}>
      <span className={`badge ${STATUS_TONE[addendum.status]}`}>{addendum.status.replace('_', ' ')}</span>
      {' '}
      <span className="muted tiny">
        take-off {addendum.takeoff_id}{addendum.baseline_takeoff_id && <> vs baseline {addendum.baseline_takeoff_id}</>}
      </span>
    </div>

    {/* available:false is never allowed to read as "nothing changed" — see the module
        doc comment above and addendumDelta.ts's own tests. */}
    {notice
      ? <p className="alert alert-grey">Not compared — {notice}</p>
      : nothingChanged
        ? <p className="alert alert-grey">Nothing changed against the baseline take-off.</p>
        : <DeltaSummary delta={delta} />}

    {wordingDominated && <p className="alert alert-grey">
      Most of this delta was paired on wording alone — the last rung of the identity
      ladder. Treat it as a starting point for review, not a firm answer.
    </p>}

    <h4>Impacted work packages</h4>
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr><th>Package</th><th>Added</th><th>Removed</th><th>Changed</th><th>Include</th><th>Revised return date</th></tr>
        </thead>
        <tbody>
          {sortedPackages.map((pkg) => {
            const key = pkg.unattributed ? '\0unattributed' : pkg.package_name;
            const counts = deltaPackageByWp.get(key);
            const edit = edits[pkg.package_name] ?? { included: pkg.included, revisedReturnDeadline: pkg.revised_return_deadline ?? '' };
            return <tr key={pkg.package_name}>
              <td>
                {pkg.unattributed
                  ? <span className="badge badge-grey" title="No work package, or one work_package_config no longer holds — a decision for the estimator, not a package to skip">
                      unattributed
                    </span>
                  : pkg.package_name}
              </td>
              <td>{counts?.added ?? pkg.items_added}</td>
              <td>{counts?.removed ?? pkg.items_removed}</td>
              <td>{counts?.changed ?? pkg.items_changed}</td>
              <td>
                <input
                  type="checkbox"
                  checked={edit.included}
                  disabled={!editable}
                  aria-label={`Include ${pkg.unattributed ? 'unattributed' : pkg.package_name}`}
                  onChange={(event) => setEdits((prev) => ({
                    ...prev, [pkg.package_name]: { ...edit, included: event.target.checked }
                  }))}
                />
              </td>
              <td>
                <input
                  type="date"
                  value={edit.revisedReturnDeadline}
                  disabled={!editable || !edit.included}
                  aria-label={`Revised return date for ${pkg.unattributed ? 'unattributed' : pkg.package_name}`}
                  onChange={(event) => setEdits((prev) => ({
                    ...prev, [pkg.package_name]: { ...edit, revisedReturnDeadline: event.target.value }
                  }))}
                />
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>

    <ConflictsSummary conflicts={delta.conflicts} />
    <DocumentsSummary documents={delta.documents} />
    <ChangedLines changed={delta.delta.changed} />

    <p className="tiny muted" style={{ marginTop: 8 }}>
      Pairing rungs: {Object.entries(delta.rung_mix).map(([rung, n]) => `${rung}: ${n}`).join(' · ')}
    </p>

    <ErrorMessage error={approve.error} />
    <ErrorMessage error={issue.error} />

    <div className="button-row" style={{ marginTop: 16 }}>
      {editable && <button onClick={() => approve.mutate()} disabled={approve.isPending}>
        {approve.isPending ? 'Approving…' : 'Approve addendum'}
      </button>}
      {(addendum.status === 'approved' || addendum.status === 'issued') && <button onClick={() => issue.mutate()} disabled={issue.isPending}>
        {issue.isPending
          ? 'Issuing…'
          : addendum.status === 'issued' ? 'Issue again (retries failed sends only)' : 'Issue to subcontractors'}
      </button>}
    </div>

    {issue.data && <p className="alert alert-green">
      Sent {issue.data.sent}, failed {issue.data.failed}, skipped — no email on file {issue.data.skippedNoEmail}.
    </p>}
  </div>;
}

function DeltaSummary({ delta }: { delta: AddendumDelta }) {
  return <div className="stats-bar">
    <div className="stat"><span className="stat-value">{delta.items_added}</span><span className="stat-label">Added</span></div>
    <div className="stat"><span className="stat-value">{delta.items_removed}</span><span className="stat-label">Removed</span></div>
    <div className="stat"><span className="stat-value">{delta.items_changed}</span><span className="stat-label">Changed</span></div>
    <div className="stat"><span className="stat-value">{delta.items_unchanged}</span><span className="stat-label">Unchanged</span></div>
  </div>;
}

function ConflictsSummary({ conflicts }: { conflicts: AddendumDelta['conflicts'] }) {
  if (!conflicts.available) return <p className="muted">Conflict comparison was not made for this addendum.</p>;
  if (conflicts.new.length === 0 && conflicts.recurring.length === 0 && conflicts.resolved.length === 0) return null;
  return <>
    <h4>Conflicts</h4>
    <div className="badge-row">
      {conflicts.new.length > 0 && <span className="badge badge-amber">{conflicts.new.length} new</span>}
      {conflicts.recurring.length > 0 && <span className="badge badge-grey">{conflicts.recurring.length} recurring</span>}
      {conflicts.resolved.length > 0 && <span className="badge badge-green">{conflicts.resolved.length} resolved</span>}
    </div>
  </>;
}

function DocumentsSummary({ documents }: { documents: AddendumDelta['documents'] }) {
  if (!documents.available) return <p className="muted">Document comparison was not made for this addendum.</p>;
  if (documents.added.length === 0 && documents.changed.length === 0 && documents.removed.length === 0) return null;
  return <>
    <h4>Documents</h4>
    <div className="badge-row">
      {documents.added.length > 0 && <span className="badge badge-green">{documents.added.length} added</span>}
      {documents.changed.length > 0 && <span className="badge badge-amber">{documents.changed.length} changed</span>}
      {documents.removed.length > 0 && <span className="badge badge-red">{documents.removed.length} removed</span>}
    </div>
  </>;
}

function ChangedLines({ changed }: { changed: AddendumDelta['delta']['changed'] }) {
  if (changed.length === 0) return null;
  return <>
    <h4>Changed lines</h4>
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>Description</th><th>Package</th><th>Rung</th><th>Change</th></tr></thead>
        <tbody>
          {changed.map((pair) => <tr key={pair.item.id}>
            <td>{pair.item.description ?? pair.baseline.description ?? '—'}</td>
            <td>{pair.item.work_package ?? <span className="muted">unattributed</span>}</td>
            <td>
              <span className={`badge ${pair.rung === 'wording' ? 'badge-amber' : 'badge-grey'}`}
                title={pair.rung === 'wording' ? 'The last rung — this pairing is a guess, not an identity' : undefined}>
                {pair.rung}
              </span>
            </td>
            <td className="tiny">{describeDeltaChange(pair.change)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </>;
}
