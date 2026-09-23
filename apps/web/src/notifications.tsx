import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type AppNotification, type CommsTimeline as Timeline } from './api';
import { CommsThreadView } from './comms';
import { Busy, ErrorMessage } from './pages';

/**
 * The notification bell, and the cross-tender timeline behind it (BuildFlow issue #34).
 *
 * TWO THINGS, ONE CONTROL, AND THEY ARE DIFFERENT QUESTIONS. "What has happened that I
 * have not seen?" is the bell — events, newest first, per reader. "Show me everything
 * this firm and I have said to each other, on any tender" is the timeline — conversations,
 * filtered by tender. The issue asks for both and they share a modal, not a query: a
 * notification is consumed once and a conversation is read repeatedly.
 *
 * The bell lives in the shell, so it is on every page including pages that belong to no
 * tender. That is why nothing here takes a workflow id, and why every read degrades to
 * empty rather than throwing — a control on every page must not be able to break every
 * page.
 */

const KIND_LABELS: Record<AppNotification['kind'], string> = {
  subcontractor_rfi: 'Query',
  client_reply: 'Client answer',
  forward_failed: 'Not sent',
  unattributed_email: 'Unattributed',
  itt_response_detected: 'ITT response',
  rfi_review_required: 'Answer not sent',
  addendum_approval_required: 'Addendum'
};

/** Amber for a thing to do, red for a thing that went wrong. A failed forward or a failed
 *  RFI response is nobody's message — it is our own send that did not happen. */
const KIND_TONE: Record<AppNotification['kind'], string> = {
  subcontractor_rfi: 'badge-blue',
  client_reply: 'badge-green',
  forward_failed: 'badge-red',
  unattributed_email: 'badge-amber',
  itt_response_detected: 'badge-green',
  rfi_review_required: 'badge-red',
  // The app asking its own estimator a question — a thing to do, not a thing that failed.
  addendum_approval_required: 'badge-amber'
};

export function BellIcon({ unread }: { unread: number }) {
  return <span className="bell-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
    {unread > 0 && <span className="bell-dot">{unread > 99 ? '99+' : unread}</span>}
  </span>;
}

/**
 * The bell itself.
 *
 * Polls rather than subscribes. A query arriving is not a keystroke — a minute's latency
 * on a tender clarification costs nothing, and a WebSocket would be a second transport to
 * keep alive across two shells and a tunnel for that.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const feed = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.listNotifications({ limit: 50 }),
    refetchInterval: 60_000,
    // The shell renders on pages that are not signed in and on deployments with no comms
    // schema at all. Neither is worth an error banner across the top of the application.
    retry: false
  });
  const unread = feed.data?.unread ?? 0;

  return <>
    <button
      className="bell-button" onClick={() => setOpen(true)}
      aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
      title="Notifications"
    >
      <BellIcon unread={unread} />
    </button>
    {open && <NotificationsModal onClose={() => setOpen(false)} />}
  </>;
}

export function NotificationsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'unseen' | 'timeline'>('unseen');
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-header">
        <h3>Notifications</h3>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="modal-body">
        <div className="inline-form" style={{ marginBottom: 12 }}>
          <button className={`small ${tab === 'unseen' ? '' : 'secondary'}`} onClick={() => setTab('unseen')}>
            What's happened
          </button>
          <button className={`small ${tab === 'timeline' ? '' : 'secondary'}`} onClick={() => setTab('timeline')}>
            All conversations
          </button>
        </div>
        {tab === 'unseen'
          ? <NotificationList onNavigate={onClose} />
          : <CommsTimelineView />}
      </div>
    </div>
  </div>;
}

/** The events, and going to one. */
function NotificationList({ onNavigate }: { onNavigate: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const feed = useQuery({ queryKey: ['notifications'], queryFn: () => api.listNotifications({ limit: 50 }) });
  const markRead = useMutation({
    mutationFn: (ids: string[]) => api.markNotificationsRead(ids),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] })
  });

  if (feed.isLoading) return <Busy />;
  if (feed.error) return <ErrorMessage error={feed.error} />;
  const items = feed.data?.items ?? [];
  if (items.length === 0) {
    return <p className="muted">
      Nothing yet. A subcontractor's query, a client's answer and a forward that failed to
      send all appear here — whether they arrived through the app or by email.
    </p>;
  }

  // Marked read on the way OUT, not on open. A bell that clears itself the moment it is
  // opened loses exactly the item somebody opened it to find and then closed to go and
  // deal with.
  const go = (notification: AppNotification) => {
    markRead.mutate([notification.id]);
    onNavigate();
    navigate(notification.deep_link_path);
  };

  return <>
    <div className="inline-form" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
      <span className="tiny muted">{feed.data?.unread ?? 0} unread of {items.length}</span>
      <button
        className="small secondary" disabled={markRead.isPending || (feed.data?.unread ?? 0) === 0}
        onClick={() => markRead.mutate([])}
      >Mark all as read</button>
    </div>
    <ErrorMessage error={markRead.error} />
    <div className="stack">
      {items.map((notification) => <button
        key={notification.id}
        className={`notification-row ${notification.read_at ? 'is-read' : ''}`}
        onClick={() => go(notification)}
      >
        <span className="inline-form" style={{ justifyContent: 'space-between' }}>
          <span>
            <span className={`badge ${KIND_TONE[notification.kind]}`}>{KIND_LABELS[notification.kind]}</span>
            {' '}<strong>{notification.title}</strong>
          </span>
          <span className="tiny muted">{new Date(notification.created_at).toLocaleString()}</span>
        </span>
        {notification.body && <span className="tiny muted notification-body">{notification.body}</span>}
      </button>)}
    </div>
  </>;
}

/**
 * Every conversation, across tenders, filtered by tender.
 *
 * THIS is where a tender filter is a real question. The Communications modal on ITT
 * Dispatch is already scoped to one tender, so a filter there would have exactly one
 * option; here a firm can be pricing four packages on three tenders at once.
 *
 * "Not attributed to a tender" is an option rather than a hidden case: an email nobody
 * could place is the one most worth looking at, and it is unreachable anywhere else.
 */
export function CommsTimelineView({ initialThreadId }: { initialThreadId?: string | null }) {
  const [openThreadId, setOpenThreadId] = useState<string | null>(initialThreadId ?? null);
  const [tender, setTender] = useState<string>('all');
  const timeline = useQuery({ queryKey: ['comms-timeline'], queryFn: () => api.commsTimeline() });

  if (timeline.isLoading) return <Busy />;
  if (timeline.error) return <ErrorMessage error={timeline.error} />;
  const data: Timeline = timeline.data ?? { threads: [], tenders: [] };

  if (openThreadId) {
    const thread = data.threads.find((row) => row.id === openThreadId);
    return <>
      <button className="small secondary" onClick={() => setOpenThreadId(null)}>← All conversations</button>
      {thread && <p className="tiny muted" style={{ marginTop: 8 }}>
        {thread.counterparty_name ?? thread.counterparty_email}
        {' · '}{thread.tender_name ?? 'not attributed to a tender'}
      </p>}
      <div style={{ marginTop: 12 }}><CommsThreadView threadId={openThreadId} /></div>
    </>;
  }

  if (data.threads.length === 0) {
    return <p className="muted">No conversations yet, on any tender.</p>;
  }

  const shown = tender === 'all' ? data.threads
    : tender === 'none' ? data.threads.filter((row) => row.workflow_id == null)
    : data.threads.filter((row) => row.workflow_id === tender);

  return <>
    <div className="inline-form" style={{ marginBottom: 10 }}>
      <label htmlFor="timeline-tender" className="tiny muted">Tender</label>
      <select id="timeline-tender" value={tender} onChange={(event) => setTender(event.target.value)}>
        <option value="all">All tenders</option>
        {data.tenders.map((option) => <option key={option.workflow_id} value={option.workflow_id}>
          {option.name ?? option.package_id ?? option.workflow_id}
        </option>)}
        {data.threads.some((row) => row.workflow_id == null) &&
          <option value="none">Not attributed to a tender</option>}
      </select>
      <span className="tiny muted">{shown.length} of {data.threads.length}</span>
    </div>
    <table className="data-table">
      <thead><tr><th>Firm</th><th>Tender</th><th>Messages</th><th>Last activity</th><th /></tr></thead>
      <tbody>
        {shown.map((thread) => <tr key={thread.id}>
          <td>
            {thread.counterparty_name ?? thread.counterparty_email}
            <div className="tiny muted">{thread.counterparty_email}</div>
          </td>
          <td className="tiny">{thread.tender_name ?? <span className="muted">not attributed</span>}</td>
          <td>
            {thread.message_count}
            {Number(thread.inbound_count) > 0 && <span className="tiny muted"> ({thread.inbound_count} in)</span>}
          </td>
          <td className="tiny">{new Date(thread.last_message_at).toLocaleString()}</td>
          <td><button className="small secondary" onClick={() => setOpenThreadId(thread.id)}>Open</button></td>
        </tr>)}
      </tbody>
    </table>
  </>;
}

/**
 * The timeline as a page of its own, at `/communications`.
 *
 * It exists because a notification has to have somewhere to send you, and an untriaged
 * email has no tender page to open. Deep-linked as `?thread=<id>` — the same shape the
 * tender page uses — so one convention covers both destinations.
 */
export function CommunicationsPage() {
  const [params] = useSearchParams();
  const threadId = params.get('thread');
  return <section className="page">
    <div className="shortlist-header"><h1>Communications</h1></div>
    <p className="muted" style={{ marginBottom: 12 }}>
      Every conversation with a subcontractor or client, across every tender — including
      email that could not be attributed to one.
    </p>
    <CommsTimelineView key={threadId ?? 'all'} initialThreadId={threadId} />
  </section>;
}
