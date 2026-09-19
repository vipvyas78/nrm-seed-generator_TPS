import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type CommsAttachment, type CommsMessage, type CommsThreadSummary } from './api';
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
  note: 'Note'
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
export function CommsModal({ workflowId, initialThreadId, onClose }: {
  workflowId: string; initialThreadId?: string | null; onClose: () => void;
}) {
  const [openThreadId, setOpenThreadId] = useState<string | null>(initialThreadId ?? null);
  const [filter, setFilter] = useState('');
  const threads = useQuery({
    queryKey: ['comms-threads', workflowId], queryFn: () => api.listCommsThreads(workflowId)
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
        {threads.isLoading ? <Busy /> : threads.error ? <ErrorMessage error={threads.error} />
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
