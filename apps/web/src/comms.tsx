import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  api, type CommsAttachment, type CommsMessage, type CommsThreadSummary,
  type RfiBlockedMessage, type RfiCitation, type RfiFirmGroup, type RfiQuestion, type TenderPrepWorkflow
} from './api';
import { Busy, ErrorMessage } from './pages';

/**
 * Subcontractor queries (RFIs) — the timeline, and the buyer's way into it.
 *
 * `CommsTimeline` is shared by BOTH audiences on purpose: the buyer reading a firm's
 * history on ITT Dispatch, and the firm reading their own on the pricing portal. One
 * renderer means neither side can quietly grow a view of the conversation the other does
 * not have — which for a tender clarification is the thing that causes an argument later.
 */

const KIND_LABELS: Record<CommsMessage['kind'], string> = {
  subcontractor_rfi: 'Query',
  client_forward: 'Sent to client',
  client_reply: 'Client answer',
  relay_to_subcontractor: 'Answer relayed',
  note: 'Note',
  itt_reminder: 'Reminder',
  rfi_response: 'Answer sent'
};

const CHANNEL_LABELS: Record<CommsMessage['channel'], string> = {
  portal: 'in app', email: 'by email', app: 'in app'
};

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file on a message.
 *
 * The href is BuildFlow's own durable link, used EXACTLY as it was handed over — nothing
 * here reassembles it, because the only BuildFlow host this app knows is the internal one
 * and a link built from that opens for nobody outside the Docker network.
 *
 * `?disposition=inline` asks for a preview rather than a download. It is only a request:
 * BuildFlow honours it for a PDF or an image and silently falls back to a download for
 * anything that could execute script, whatever the sender claimed the file was. So asking
 * is always safe, and the worst outcome is that the file downloads.
 */
export function AttachmentLink({ attachment }: { attachment: CommsAttachment }) {
  const size = formatBytes(attachment.byte_size);
  if (!attachment.share_url) {
    // Named rather than hidden: a file that exists but has no live link is a different
    // fact from no attachment at all, and only one of them is worth chasing.
    return <span className="tiny muted" title="This file is stored but has no current link">
      📎 {attachment.filename}{size && ` · ${size}`} (link unavailable)
    </span>;
  }
  return <a
    className="tiny" href={`${attachment.share_url}?disposition=inline`}
    target="_blank" rel="noreferrer"
  >📎 {attachment.filename}{size && ` · ${size}`}</a>;
}

export function CommsTimeline({ messages }: { messages: CommsMessage[] }) {
  if (messages.length === 0) return <p className="muted">Nothing has been raised yet.</p>;
  return <div className="stack">
    {messages.map((message) => <div key={message.id} className="panel" style={{ marginBottom: 0 }}>
      <div className="inline-form" style={{ justifyContent: 'space-between' }}>
        <span>
          <span className={`badge ${message.direction === 'inbound' ? 'badge-blue' : 'badge-grey'}`}>
            {KIND_LABELS[message.kind]}
          </span>
          {' '}
          <strong>{message.author_name ?? message.author_email ?? 'Unknown sender'}</strong>
          {/* The address is shown beside the name because they can differ from the firm
              the ITT was addressed to, and knowing who actually asked is the point. */}
          {message.author_email && message.author_name &&
            <span className="tiny muted"> {message.author_email}</span>}
        </span>
        <span className="tiny muted">
          {new Date(message.occurred_at).toLocaleString()} · {CHANNEL_LABELS[message.channel]}
        </span>
      </div>
      {message.subject && <div style={{ marginTop: 6 }}><strong>{message.subject}</strong></div>}
      {/* pre-wrap, not a markdown or HTML render: this text came from outside the
          organisation and is shown to a person, so it stays text. */}
      {message.body_text && <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{message.body_text}</div>}
      {message.attachments.length > 0 && <div className="badge-row" style={{ marginTop: 8 }}>
        {message.attachments.map((attachment) =>
          <AttachmentLink key={attachment.id} attachment={attachment} />)}
      </div>}
    </div>)}
  </div>;
}

/** One thread's messages, fetched by id. Used by the buyer's modal. */
export function CommsThreadView({ threadId }: { threadId: string }) {
  const thread = useQuery({ queryKey: ['comms-thread', threadId], queryFn: () => api.getCommsThread(threadId) });
  if (thread.isLoading) return <Busy />;
  if (thread.error) return <ErrorMessage error={thread.error} />;
  if (!thread.data) return null;
  return <CommsTimeline messages={thread.data.messages} />;
}

/**
 * "Communications" on ITT Dispatch: every firm currently in conversation about this
 * tender, and one firm's history when picked.
 *
 * Structured like PortalResponsesModal — a list that swaps in a detail view within the
 * same modal rather than stacking a second one.
 *
 * THE FILTER HERE IS BY FIRM, NOT BY TENDER. This modal is already scoped to one tender,
 * so a tender filter would have exactly one option. The cross-tender timeline the issue
 * asks for is the one behind the notification bell, where a list spanning tenders actually
 * exists; this component takes its threads as a prop so that view can reuse it.
 */
export function CommsModal({ workflowId, initialThreadId, initialTab, onClose }: {
  workflowId: string; initialThreadId?: string | null;
  initialTab?: 'threads' | 'collate' | 'answers' | 'rfi'; onClose: () => void;
}) {
  const [openThreadId, setOpenThreadId] = useState<string | null>(initialThreadId ?? null);
  const [filter, setFilter] = useState('');
  const threads = useQuery({
    queryKey: ['comms-threads', workflowId], queryFn: () => api.listCommsThreads(workflowId)
  });
  // Read alone (?view=counts) so the tab's own badge does not drag every citation and
  // every blocked message body across the wire to render one integer.
  const rfiCounts = useQuery({
    queryKey: ['rfi-review', workflowId, 'counts'], queryFn: () => api.getRfiReviewCounts(workflowId)
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Four things happen in this modal and they are different jobs: reading one firm's
  // history, collating queries to put to the Client, passing an answer back, and — since
  // issue #48 — reviewing what the app drafted. Tabs rather than one long page, because
  // an estimator is doing one of them at a time.
  const [tab, setTab] = useState<'threads' | 'collate' | 'answers' | 'rfi'>(initialTab ?? 'threads');
  const rows = threads.data ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? rows.filter((thread) => threadLabel(thread).toLowerCase().includes(needle)
      || thread.counterparty_email.toLowerCase().includes(needle))
    : rows;
  const open = rows.find((thread) => thread.id === openThreadId);

  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={(event) => event.stopPropagation()}>
      <div className="modal-header">
        <h3>{open ? `Communications — ${threadLabel(open)}` : 'Communications'}</h3>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="modal-body">
        {!open && <div className="inline-form" style={{ marginBottom: 12 }}>
          <button className={`small ${tab === 'threads' ? '' : 'secondary'}`} onClick={() => setTab('threads')}>
            Conversations
          </button>
          <button className={`small ${tab === 'collate' ? '' : 'secondary'}`} onClick={() => setTab('collate')}>
            Put queries to the client
          </button>
          <button className={`small ${tab === 'answers' ? '' : 'secondary'}`} onClick={() => setTab('answers')}>
            Client responses
          </button>
          <button className={`small ${tab === 'rfi' ? '' : 'secondary'}`} onClick={() => setTab('rfi')}>
            Drafted answers
            {Boolean(rfiCounts.data?.blocked) && <span className="badge badge-red" style={{ marginLeft: 6 }}>{rfiCounts.data!.blocked}</span>}
          </button>
        </div>}

        {!open && tab === 'collate' && <CollateAndForward workflowId={workflowId} />}
        {!open && tab === 'answers' && <ClientAnswers workflowId={workflowId} />}
        {!open && tab === 'rfi' && <RfiReview workflowId={workflowId} />}

        {!open && tab !== 'threads' ? null
          : threads.isLoading ? <Busy /> : threads.error ? <ErrorMessage error={threads.error} />
          : open
            ? <>
                <button className="small secondary" onClick={() => setOpenThreadId(null)}>← All conversations</button>
                <div style={{ marginTop: 12 }}><CommsThreadView threadId={open.id} /></div>
              </>
            : rows.length === 0
              ? <p className="muted">
                  No subcontractor has raised a query on this tender yet. One appears here as
                  soon as they do, whether they use the link in their ITT or reply by email.
                </p>
              : <>
                  <div className="inline-form" style={{ marginBottom: 10 }}>
                    <input
                      type="search" placeholder="Filter by firm" value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      aria-label="Filter by firm"
                    />
                    <span className="tiny muted">{shown.length} of {rows.length}</span>
                  </div>
                  <table className="data-table">
                    <thead><tr>
                      <th>Firm</th><th>Messages</th><th>Files</th><th>Last activity</th><th />
                    </tr></thead>
                    <tbody>
                      {shown.map((thread) => <tr key={thread.id}>
                        <td>
                          {threadLabel(thread)}
                          <div className="tiny muted">{thread.counterparty_email}</div>
                        </td>
                        <td>
                          {thread.message_count}
                          {/* Inbound is called out separately because "three messages" of
                              which we sent two is a different state from three questions. */}
                          {Number(thread.inbound_count) > 0 &&
                            <span className="tiny muted"> ({thread.inbound_count} in)</span>}
                        </td>
                        <td>{Number(thread.attachment_count) > 0 ? thread.attachment_count : <span className="muted">—</span>}</td>
                        <td className="tiny">{new Date(thread.last_message_at).toLocaleString()}</td>
                        <td>
                          <button className="small secondary" onClick={() => setOpenThreadId(thread.id)}>Open</button>
                        </td>
                      </tr>)}
                    </tbody>
                  </table>
                </>}
      </div>
    </div>
  </div>;
}

/** A firm has a name on file, an address otherwise. Never blank. */
function threadLabel(thread: CommsThreadSummary): string {
  return thread.counterparty_name ?? thread.counterparty_email;
}

/**
 * Collating queries from several firms into ONE message to the Client.
 *
 * Tender-wide rather than per-firm, because that is the operation the issue describes: an
 * estimating manager gathers what has come in — from whichever subcontractors — and puts
 * it to the Client once. Six separate emails get one reply between them and nobody can
 * tell afterwards which question it answered.
 *
 * A query already forwarded is shown as such and starts unticked. The Client is a person,
 * and asking them the same question twice is how an estimator spends their goodwill.
 */
function CollateAndForward({ workflowId }: { workflowId: string }) {
  const queryClient = useQueryClient();
  const queries = useQuery({
    queryKey: ['comms-queries', workflowId], queryFn: () => api.listCommsQueries(workflowId)
  });
  const defaults = useQuery({
    queryKey: ['comms-defaults', workflowId], queryFn: () => api.commsDefaults(workflowId)
  });

  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [client, setClient] = useState({ email: '', name: '', note: '' });
  const [hydrated, setHydrated] = useState(false);

  // Hydrated once from the organisation's configured Client contact. A default, not a
  // rule: each tender can have a different employer, so the field stays editable.
  useEffect(() => {
    if (!defaults.data || hydrated) return;
    setClient((prev) => ({
      ...prev,
      email: defaults.data.client_contact_email ?? '',
      name: defaults.data.client_contact_name ?? ''
    }));
    setHydrated(true);
  }, [defaults.data, hydrated]);

  const forward = useMutation({
    mutationFn: () => api.forwardQueries(workflowId, {
      messageIds: Object.entries(selected).filter(([, on]) => on).map(([id]) => id),
      clientEmail: client.email.trim(),
      clientName: client.name.trim() || null,
      note: client.note.trim() || null
    }),
    onSuccess: () => {
      setSelected({});
      setClient((prev) => ({ ...prev, note: '' }));
      void queryClient.invalidateQueries({ queryKey: ['comms-queries', workflowId] });
      void queryClient.invalidateQueries({ queryKey: ['comms-threads', workflowId] });
    }
  });

  if (queries.isLoading) return <Busy />;
  const rows = queries.data ?? [];
  const chosen = Object.values(selected).filter(Boolean).length;

  if (rows.length === 0) {
    return <p className="muted">
      No queries have been raised on this tender yet, so there is nothing to put to the client.
    </p>;
  }

  return <>
    <ErrorMessage error={queries.error} />
    <ErrorMessage error={forward.error} />

    {forward.data && <div className={`alert ${forward.data.sent ? 'alert-green' : 'alert-red'}`}>
      {forward.data.sent
        ? `Sent ${forward.data.forwarded} ${forward.data.forwarded === 1 ? 'query' : 'queries'} to the client.`
        : `Recorded, but the email did not send: ${forward.data.error ?? 'unknown error'}`}
      {/* Named, not silent — the same rule the email body itself follows when it has no
          link to offer. */}
      {forward.data.link_blocked_reason && <div className="tiny" style={{ marginTop: 4 }}>
        No in-app reply link was issued ({forward.data.link_blocked_reason.replace(/_/g, ' ')}),
        so the client can only answer by replying to the email.
      </div>}
    </div>}

    <table className="data-table">
      <thead><tr>
        <th style={{ width: '2rem' }} /><th>Firm</th><th>Query</th><th>Raised</th><th>Status</th>
      </tr></thead>
      <tbody>
        {rows.map((row) => <tr key={row.id}>
          <td>
            <input
              type="checkbox"
              aria-label={`Select query from ${row.counterparty_name ?? row.counterparty_email}`}
              checked={Boolean(selected[row.id])}
              onChange={(event) => setSelected((prev) => ({ ...prev, [row.id]: event.target.checked }))}
            />
          </td>
          <td>
            {row.counterparty_name ?? row.counterparty_email}
            {row.author_name && <div className="tiny muted">asked by {row.author_name}</div>}
          </td>
          <td>
            {row.subject && <div><strong>{row.subject}</strong></div>}
            <div className="tiny" style={{ whiteSpace: 'pre-wrap' }}>{row.body_text}</div>
            {Number(row.attachment_count) > 0 &&
              <div className="tiny muted">{row.attachment_count} attachment(s)</div>}
          </td>
          <td className="tiny">{new Date(row.occurred_at).toLocaleDateString()}</td>
          <td>
            {row.forwarded_at
              ? <span className="badge badge-grey">sent {new Date(row.forwarded_at).toLocaleDateString()}</span>
              : <span className="badge badge-amber">not sent</span>}
          </td>
        </tr>)}
      </tbody>
    </table>

    <div className="panel" style={{ marginTop: 12 }}>
      <h3>Send to the client</h3>
      <div className="compose-field">
        <label htmlFor="client-email">To</label>
        <input
          id="client-email" type="email" value={client.email}
          onChange={(event) => setClient((prev) => ({ ...prev, email: event.target.value }))}
        />
      </div>
      <div className="compose-field">
        <label htmlFor="client-name">Name</label>
        <input
          id="client-name" type="text" value={client.name}
          onChange={(event) => setClient((prev) => ({ ...prev, name: event.target.value }))}
        />
      </div>
      <div className="compose-field">
        <label htmlFor="client-note">Note</label>
        <textarea
          id="client-note" rows={3} value={client.note}
          onChange={(event) => setClient((prev) => ({ ...prev, note: event.target.value }))}
          placeholder="Anything to say alongside the queries. The queries themselves are sent verbatim."
        />
      </div>
      <div className="button-row">
        <span className="tiny muted" style={{ marginRight: 'auto' }}>{chosen} selected</span>
        <button
          disabled={chosen === 0 || !client.email.trim() || forward.isPending}
          onClick={() => forward.mutate()}
        >
          {forward.isPending ? 'Sending…' : 'Send to client'}
        </button>
      </div>
    </div>
  </>;
}

/**
 * The Client's answers, and passing each back.
 *
 * The recipients are NOT chosen here. `relayClientAnswer` derives them server-side from
 * the queries the forward actually carried, because an answer belongs to the firms that
 * asked — letting this screen pick would let it reach a competitor pricing the same
 * package. The count is shown beforehand, since that is the only way the recipients are
 * visible in advance.
 */
function ClientAnswers({ workflowId }: { workflowId: string }) {
  const queryClient = useQueryClient();
  const answers = useQuery({
    queryKey: ['client-answers', workflowId], queryFn: () => api.listClientAnswers(workflowId)
  });
  const [note, setNote] = useState('');

  const relay = useMutation({
    mutationFn: (messageId: string) => api.relayClientAnswer(messageId, note.trim() || null),
    onSuccess: () => {
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['client-answers', workflowId] });
      void queryClient.invalidateQueries({ queryKey: ['comms-threads', workflowId] });
    }
  });

  if (answers.isLoading) return <Busy />;
  const rows = answers.data ?? [];
  if (rows.length === 0) {
    return <p className="muted">
      The client has not responded yet. Their answer appears here whether they use the link
      in the email or simply reply to it.
    </p>;
  }

  return <>
    <ErrorMessage error={answers.error} />
    <ErrorMessage error={relay.error} />
    {relay.data && <div className="alert alert-green">
      Passed back to {relay.data.relayed} {relay.data.relayed === 1 ? 'firm' : 'firms'}.
    </div>}

    <div className="compose-field">
      <label htmlFor="relay-note">Note</label>
      <textarea
        id="relay-note" rows={2} value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Optional, added beneath the client's answer."
      />
    </div>

    <div className="stack">
      {rows.map((answer) => <div key={answer.id} className="panel" style={{ marginBottom: 0 }}>
        <div className="inline-form" style={{ justifyContent: 'space-between' }}>
          <strong>{answer.counterparty_name ?? answer.counterparty_email}</strong>
          <span className="tiny muted">{new Date(answer.occurred_at).toLocaleString()}</span>
        </div>
        <div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{answer.body_text}</div>
        <div className="inline-form" style={{ marginTop: 10, justifyContent: 'space-between' }}>
          <span className="tiny muted">
            Covers {answer.covers} {Number(answer.covers) === 1 ? 'query' : 'queries'}
          </span>
          <button
            className="small"
            disabled={Number(answer.covers) === 0 || relay.isPending}
            title={Number(answer.covers) === 0
              ? 'This response is not linked to any query, so there is nobody to pass it back to'
              : undefined}
            onClick={() => relay.mutate(answer.id)}
          >
            {relay.isPending ? 'Sending…' : 'Pass back to the firms that asked'}
          </button>
        </div>
      </div>)}
    </div>
  </>;
}

/**
 * The estimator's review of what issue #41's pipeline drafted (issue #48): blocked
 * messages first, always, because filing them is the one thing that unblocks
 * everything else about that firm — then every question grouped by the firms own
 * thread, each with its live draft (or "the app could not answer this"), its citations,
 * and the three dispositions.
 *
 * No optimistic updates, the one rule this whole file follows: every mutation
 * invalidates and refetches, exactly as CollateAndForward and ClientAnswers above do.
 */
function RfiReview({ workflowId }: { workflowId: string }) {
  const queryClient = useQueryClient();
  const review = useQuery({
    queryKey: ['rfi-review', workflowId], queryFn: () => api.getRfiReview(workflowId)
  });
  // Only fetched for the blocked-message tender picker; ['workflows'] is the same key
  // the packages list and the dashboard already use, so this rarely costs its own round trip.
  const workflows = useQuery({ queryKey: ['workflows'], queryFn: () => api.listWorkflows() });

  const [sendSelected, setSendSelected] = useState<Record<string, boolean>>({});
  const [clientSelected, setClientSelected] = useState<Record<string, boolean>>({});

  // Prefix match invalidates rfi-review's own count query too; the dashboard badge is
  // under a different key and invalidated by name.
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['rfi-review', workflowId] });
    void queryClient.invalidateQueries({ queryKey: ['launch-table'] });
  };

  const approveMutation = useMutation({
    mutationFn: (input: { questionId: string; answerText: string | null }) =>
      api.approveRfiQuestion(workflowId, input.questionId, input.answerText),
    onSuccess: invalidateAll
  });
  const askClientMutation = useMutation({
    mutationFn: (questionId: string) => api.askClientRfiQuestion(workflowId, questionId),
    onSuccess: invalidateAll
  });
  const dismissMutation = useMutation({
    mutationFn: (questionId: string) => api.dismissRfiQuestion(workflowId, questionId),
    onSuccess: invalidateAll
  });
  // A single shared isPending across every cards buttons, the same pattern
  // ClientAnswers relay.isPending already uses above: every button disables while any
  // one disposition is in flight, rather than tracking which card started it.
  const actions = {
    approve: (questionId: string, answerText: string | null) => approveMutation.mutate({ questionId, answerText }),
    askClient: (questionId: string) => askClientMutation.mutate(questionId),
    dismiss: (questionId: string) => dismissMutation.mutate(questionId),
    pending: approveMutation.isPending || askClientMutation.isPending || dismissMutation.isPending
  };

  const sendMutation = useMutation({
    mutationFn: () => api.sendRfiResponses(
      workflowId, Object.entries(sendSelected).filter(([, on]) => on).map(([id]) => id)
    ),
    onSuccess: () => {
      setSendSelected({});
      invalidateAll();
      void queryClient.invalidateQueries({ queryKey: ['comms-threads', workflowId] });
    }
  });

  if (review.isLoading) return <Busy />;
  if (review.error) return <ErrorMessage error={review.error} />;
  const data = review.data;
  if (!data) return null;

  const sendChosen = Object.values(sendSelected).filter(Boolean).length;
  const clientChosenIds = Object.entries(clientSelected).filter(([, on]) => on).map(([id]) => id);
  const hasAnyApprovedQuestion = data.groups.some((group) => group.questions.some((q) => q.status === 'approved'));

  return <>
    {data.blocked.length > 0 && <BlockedPanel workflowId={workflowId} blocked={data.blocked} workflows={workflows.data ?? []} />}

    {data.groups.length === 0 && data.blocked.length === 0 && <p className="muted">
      No queries have been raised on this tender yet, so there is nothing drafted to review.
    </p>}

    <div className="stack">
      {data.groups.map((group) => <RfiFirmGroupCard
        key={group.thread_id} group={group} actions={actions}
        sendSelected={sendSelected} onToggleSend={(id, on) => setSendSelected((prev) => ({ ...prev, [id]: on }))}
        clientSelected={clientSelected} onToggleClient={(id, on) => setClientSelected((prev) => ({ ...prev, [id]: on }))}
      />)}
    </div>

    {hasAnyApprovedQuestion && <div className="panel" style={{ marginTop: 12 }}>
      <h3>Send</h3>
      <ErrorMessage error={sendMutation.error} />
      {sendMutation.data && <div className={`alert ${sendMutation.data.responses.every((r) => r.status === 'sent') ? 'alert-green' : 'alert-red'}`}>
        {sendMutation.data.responses.map((r) => <div key={r.thread_id} className="tiny">
          {r.to}: {r.status === 'sent' ? 'sent' : `failed — ${r.error ?? 'unknown error'}`}
        </div>)}
      </div>}
      <div className="button-row">
        <span className="tiny muted" style={{ marginRight: 'auto' }}>{sendChosen} selected</span>
        <button disabled={sendChosen === 0 || sendMutation.isPending} onClick={() => sendMutation.mutate()}>
          {sendMutation.isPending ? 'Sending…' : `Send ${sendChosen || ''} answer${sendChosen === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>}

    <ClientForwardPanel workflowId={workflowId} questionIds={clientChosenIds} onSuccess={() => setClientSelected({})} />
  </>;
}

/** A workflows own display name, for the tender picker — the same fallback ladder
 *  PackagesListPage already uses for its own table. */
function workflowLabel(workflow: TenderPrepWorkflow): string {
  const takeoff = workflow.step_data?.takeoff;
  const name = takeoff?.tenderName ?? workflow.package_id;
  return takeoff?.packageName ? `${name} — ${takeoff.packageName}` : String(name);
}

/**
 * Messages the eligibility gate could not file with confidence, rendered first, always,
 * because filing one is the one action that closes issue #41s no-tender-mixup loop.
 *
 * Two groups: attributed (the apps own guess, which is exactly what is under suspicion)
 * and unattributed ("no tender matched this sender at all" — belongs to no tenders
 * dashboard, and this tab is the only place it is reachable).
 */
function BlockedPanel({ workflowId, blocked, workflows }: {
  workflowId: string; blocked: RfiBlockedMessage[]; workflows: TenderPrepWorkflow[];
}) {
  const attributed = blocked.filter((message) => !message.unattributed);
  const unattributed = blocked.filter((message) => message.unattributed);
  return <div className="stack" style={{ marginBottom: 16 }}>
    <h3>Needs filing under a tender</h3>
    {attributed.map((message) => (
      <BlockedRow key={message.message_id} workflowId={workflowId} message={message} workflows={workflows} />
    ))}
    {unattributed.length > 0 && <>
      <h4 className="tiny muted" style={{ marginTop: 12 }}>Not filed under any tender</h4>
      {unattributed.map((message) => (
        <BlockedRow key={message.message_id} workflowId={workflowId} message={message} workflows={workflows} />
      ))}
    </>}
  </div>;
}

function BlockedRow({ workflowId, message, workflows }: {
  workflowId: string; message: RfiBlockedMessage; workflows: TenderPrepWorkflow[];
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState('');
  const attribute = useMutation({
    mutationFn: () => api.attributeCommsMessage(message.message_id, target),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rfi-review', workflowId] });
      void queryClient.invalidateQueries({ queryKey: ['launch-table'] });
    }
  });

  return <div className="panel" style={{ marginBottom: 0 }}>
    <div className="inline-form" style={{ justifyContent: 'space-between' }}>
      <span>
        <span className={`badge ${message.state === 'blocked_cross_tender_suspected' ? 'badge-red' : 'badge-amber'}`}>
          {message.state === 'blocked_cross_tender_suspected' ? 'Names a different tender' : 'Ambiguous sender'}
        </span>
        {' '}
        <strong>{message.firm_name ?? message.firm_email}</strong>
        {message.firm_name && <span className="tiny muted"> {message.firm_email}</span>}
      </span>
      <span className="tiny muted">{new Date(message.occurred_at).toLocaleString()}</span>
    </div>
    {message.subject && <div style={{ marginTop: 6 }}><strong>{message.subject}</strong></div>}
    {message.body_text && <div className="tiny" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{message.body_text}</div>}
    {message.state_reason && <div className="tiny muted" style={{ marginTop: 4 }}>{message.state_reason}</div>}
    <div className="inline-form" style={{ marginTop: 10 }}>
      <select value={target} onChange={(event) => setTarget(event.target.value)} aria-label={`File ${message.firm_name ?? message.firm_email} under tender`}>
        <option value="">Choose a tender…</option>
        {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflowLabel(workflow)}</option>)}
      </select>
      <button className="small" disabled={!target || attribute.isPending} onClick={() => attribute.mutate()}>
        {attribute.isPending ? 'Filing…' : 'File under this tender'}
      </button>
    </div>
    <ErrorMessage error={attribute.error} />
  </div>;
}

function RfiFirmGroupCard({ group, actions, sendSelected, onToggleSend, clientSelected, onToggleClient }: {
  group: RfiFirmGroup;
  actions: { approve: (id: string, answerText: string | null) => void; askClient: (id: string) => void; dismiss: (id: string) => void; pending: boolean };
  sendSelected: Record<string, boolean>; onToggleSend: (questionId: string, on: boolean) => void;
  clientSelected: Record<string, boolean>; onToggleClient: (questionId: string, on: boolean) => void;
}) {
  return <div className="panel" style={{ marginBottom: 0 }}>
    <h3>{group.firm_name}{group.package_name ? ` · ${group.package_name}` : ''}</h3>
    <div className="stack" style={{ marginTop: 8 }}>
      {group.questions.map((question) => <RfiQuestionCard
        key={question.id} question={question} actions={actions}
        selectedForSend={Boolean(sendSelected[question.id])} onToggleSend={(on) => onToggleSend(question.id, on)}
        selectedForClient={Boolean(clientSelected[question.id])} onToggleClient={(on) => onToggleClient(question.id, on)}
      />)}
    </div>
  </div>;
}

const TERMINAL_STATUS_LABEL: Record<string, string> = {
  sent: 'Sent', sent_to_client: 'Sent to client', answered_by_client: 'Client answered', dismissed: 'Dismissed'
};
const TERMINAL_STATUSES = new Set(['sent', 'sent_to_client', 'answered_by_client', 'dismissed']);

export function RfiQuestionCard({ question, actions, selectedForSend, onToggleSend, selectedForClient, onToggleClient }: {
  question: RfiQuestion;
  actions: { approve: (id: string, answerText: string | null) => void; askClient: (id: string) => void; dismiss: (id: string) => void; pending: boolean };
  selectedForSend: boolean; onToggleSend: (on: boolean) => void;
  selectedForClient: boolean; onToggleClient: (on: boolean) => void;
}) {
  // A live draft only counts as an answer to show when it actually PROPOSED one — every
  // other draft status means "the app could not answer this", the same rule
  // resolveAnswer (the servers own answer-crediting table) enforces before a send.
  const hasUsableDraft = question.draft?.status === 'proposed' && Boolean(question.draft.answer_text?.trim());
  const displayAnswer = question.estimator_answer_text ?? (hasUsableDraft ? (question.draft!.answer_text as string) : null);

  const [manualEditing, setManualEditing] = useState<boolean | null>(null);
  const [text, setText] = useState(displayAnswer ?? '');
  // No default until there is something to default away from: a question with nothing
  // to show opens straight into the textarea rather than a toggle nobody needs to click.
  const isEditing = manualEditing ?? displayAnswer == null;

  if (TERMINAL_STATUSES.has(question.status)) {
    return <div className="panel" style={{ marginBottom: 0 }}>
      <div className="inline-form" style={{ justifyContent: 'space-between' }}>
        <span>{question.question_text}</span>
        <span className="badge badge-grey">{TERMINAL_STATUS_LABEL[question.status]}</span>
      </div>
    </div>;
  }

  const currentText = (isEditing ? text : question.estimator_answer_text ?? '').trim();
  const canApprove = currentText.length > 0 || hasUsableDraft;
  const provenance = question.source_kind === 'attachment'
    ? (question.source_ref ?? 'from an attachment')
    : 'from their email';

  return <div className="panel" style={{ marginBottom: 0 }}>
    <div><strong>{question.question_text}</strong></div>
    <div className="tiny muted">
      {question.asked_by_name ?? question.asked_by_email ?? 'Unknown sender'} — {provenance}
      {' · '}{new Date(question.raised_at).toLocaleDateString()}
    </div>

    {!hasUsableDraft && !question.estimator_answer_text && <p className="tiny muted" style={{ marginTop: 8 }}>
      The app could not answer this — write the answer yourself.
      {question.draft?.reject_reason && ` (${question.draft.reject_reason})`}
    </p>}

    {!isEditing && displayAnswer != null && <div style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{displayAnswer}</div>}
    {!isEditing && <Citations citations={question.draft?.citations ?? []} />}

    {isEditing
      ? <textarea
          className="compose-field" rows={3} style={{ marginTop: 8, width: '100%' }}
          value={text} onChange={(event) => setText(event.target.value)}
          placeholder="Write the answer to send."
          aria-label={`Answer to ${question.question_text}`}
        />
      : <button className="small secondary" style={{ marginTop: 8 }} onClick={() => { setText(displayAnswer ?? ''); setManualEditing(true); }}>
          Edit
        </button>}

    <div className="button-row" style={{ marginTop: 10 }}>
      {question.status === 'approved' && <label className="tiny inline-form" style={{ marginRight: 'auto' }}>
        <input type="checkbox" checked={selectedForSend} onChange={(event) => onToggleSend(event.target.checked)} />
        Include in send
      </label>}
      {question.status === 'for_client' && <label className="tiny inline-form" style={{ marginRight: 'auto' }}>
        <input type="checkbox" checked={selectedForClient} onChange={(event) => onToggleClient(event.target.checked)} />
        Include in client email
      </label>}
      <button
        className="small" disabled={!canApprove || actions.pending}
        title={canApprove ? undefined : 'Write an answer before approving'}
        onClick={() => actions.approve(question.id, currentText || null)}
      >
        Approve
      </button>
      <button className="small secondary" disabled={actions.pending} onClick={() => actions.askClient(question.id)}>
        Ask the client
      </button>
      <button className="small secondary" disabled={actions.pending} onClick={() => actions.dismiss(question.id)}>
        Dismiss
      </button>
    </div>
  </div>;
}

/**
 * A drafted answers sources — the same null-link rule AttachmentLink above follows: a
 * document that exists but has no live link is a different fact from no source at all,
 * and only one of them is worth chasing. The quoted passage is rendered as text, never
 * markdown — it came out of a document and is shown to a person, the same rule
 * CommsTimelines body_text follows.
 */
export function Citations({ citations }: { citations: RfiCitation[] }) {
  if (citations.length === 0) return null;
  return <div className="stack" style={{ marginTop: 8 }}>
    {citations.map((citation) => <div key={citation.passageId || citation.filename}>
      {citation.shareUrl
        ? <a className="tiny" href={`${citation.shareUrl}?disposition=inline`} target="_blank" rel="noreferrer">
            📄 {citation.filename}{citation.headingPath && ` · ${citation.headingPath}`}{citation.pageHint != null && ` · p${citation.pageHint}`}
          </a>
        : <span className="tiny muted" title="This document is in the tender pack but has no current link">
            📄 {citation.filename}{citation.headingPath && ` · ${citation.headingPath}`} (link unavailable)
          </span>}
      <div className="tiny muted" style={{ whiteSpace: 'pre-wrap', borderLeft: '3px solid #e5e7eb', paddingLeft: 8, marginTop: 2 }}>
        {citation.quotedText}
      </div>
    </div>)}
  </div>;
}

/**
 * The unanswered questions put to the Client as ONE email — the same shape as
 * CollateAndForwards own compose panel, over the currently ticked for_client
 * questions rather than raw messages.
 */
function ClientForwardPanel({ workflowId, questionIds, onSuccess }: {
  workflowId: string; questionIds: string[]; onSuccess: () => void;
}) {
  const queryClient = useQueryClient();
  const defaults = useQuery({
    queryKey: ['comms-defaults', workflowId], queryFn: () => api.commsDefaults(workflowId)
  });
  const [client, setClient] = useState({ email: '', name: '', note: '' });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!defaults.data || hydrated) return;
    setClient((prev) => ({
      ...prev,
      email: defaults.data.client_contact_email ?? '',
      name: defaults.data.client_contact_name ?? ''
    }));
    setHydrated(true);
  }, [defaults.data, hydrated]);

  const forward = useMutation({
    mutationFn: () => api.forwardRfiQuestions(workflowId, {
      questionIds,
      clientEmail: client.email.trim(),
      clientName: client.name.trim() || null,
      note: client.note.trim() || null
    }),
    onSuccess: () => {
      setClient((prev) => ({ ...prev, note: '' }));
      onSuccess();
      void queryClient.invalidateQueries({ queryKey: ['rfi-review', workflowId] });
      void queryClient.invalidateQueries({ queryKey: ['comms-threads', workflowId] });
    }
  });

  // Kept mounted after a successful send even though the parent then clears the
  // selection (questionIds becomes []) — otherwise the very alert reporting what
  // happened disappears in the same tick it appears, which is worse than not showing
  // this panel at all.
  if (questionIds.length === 0 && !forward.data) return null;

  return <div className="panel" style={{ marginTop: 12 }}>
    <h3>Put to the client</h3>
    <ErrorMessage error={forward.error} />
    {forward.data && <div className={`alert ${forward.data.sent ? 'alert-green' : 'alert-red'}`}>
      {forward.data.sent
        ? `Sent ${forward.data.questions_forwarded} ${forward.data.questions_forwarded === 1 ? 'question' : 'questions'} to the client.`
        : `Recorded, but the email did not send: ${forward.data.error ?? 'unknown error'}`}
      {forward.data.link_blocked_reason && <div className="tiny" style={{ marginTop: 4 }}>
        No in-app reply link was issued ({forward.data.link_blocked_reason.replace(/_/g, ' ')}),
        so the client can only answer by replying to the email.
      </div>}
    </div>}
    <div className="compose-field">
      <label htmlFor="rfi-client-email">To</label>
      <input
        id="rfi-client-email" type="email" value={client.email}
        onChange={(event) => setClient((prev) => ({ ...prev, email: event.target.value }))}
      />
    </div>
    <div className="compose-field">
      <label htmlFor="rfi-client-name">Name</label>
      <input
        id="rfi-client-name" type="text" value={client.name}
        onChange={(event) => setClient((prev) => ({ ...prev, name: event.target.value }))}
      />
    </div>
    <div className="compose-field">
      <label htmlFor="rfi-client-note">Note</label>
      <textarea
        id="rfi-client-note" rows={3} value={client.note}
        onChange={(event) => setClient((prev) => ({ ...prev, note: event.target.value }))}
        placeholder="Anything to say alongside the questions. The questions themselves are sent verbatim."
      />
    </div>
    <div className="button-row">
      <span className="tiny muted" style={{ marginRight: 'auto' }}>
        {questionIds.length} {questionIds.length === 1 ? 'question' : 'questions'} selected
      </span>
      <button disabled={questionIds.length === 0 || !client.email.trim() || forward.isPending} onClick={() => forward.mutate()}>
        {forward.isPending ? 'Sending…' : 'Send to client'}
      </button>
    </div>
  </div>;
}
