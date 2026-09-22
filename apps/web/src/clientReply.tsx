import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { clientApi } from './api';
import { CommsTimeline } from './comms';

/**
 * The Client's reply page — the PUBLIC page an employer opens from the email putting a set
 * of subcontractor queries to them.
 *
 * Rendered outside `<AppShell/>` (see main.tsx), beside the pricing portal and for the
 * same reason: the viewer is not a BuildFlow user. What stands between this page and the
 * tender is Cloudflare Access at the edge plus the token-to-recipient binding the server
 * checks on every request (`resolveClientToken`); this component trusts the server's
 * answer and does no authorization of its own.
 *
 * IT NAMES NO SUBCONTRACTOR. The Client is answering a question about the works; which
 * firm asked it is commercially ours, and putting the shortlist in front of the employer
 * would leak it. The server does not send the names — this is not a display choice that
 * could be undone by a careless edit here.
 */
export function ClientReplyPage() {
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const page = useQuery({ queryKey: ['client-reply', token], queryFn: () => clientApi.get(token), retry: false });
  const [answer, setAnswer] = useState('');

  const reply = useMutation({
    mutationFn: () => clientApi.reply(token, answer.trim()),
    onSuccess: () => {
      setAnswer('');
      void queryClient.invalidateQueries({ queryKey: ['client-reply', token] });
    }
  });

  if (page.isLoading) return <Shell><p className="muted">Loading…</p></Shell>;
  if (page.error) return <Shell><Failure error={page.error} /></Shell>;
  if (!page.data) return null;

  const data = page.data;

  return <Shell>
    <div className="portal-header">
      <h1>Tender queries{data.tender_name ? ` — ${data.tender_name}` : ''}</h1>
      <p className="muted">
        {data.queries.length === 1
          ? 'One query has been raised by a subcontractor pricing this tender.'
          : `${data.queries.length} queries have been raised by subcontractors pricing this tender.`}
      </p>
    </div>

    {reply.isSuccess && !reply.isPending && <div className="alert alert-green">
      Thank you — your response has been recorded and will be passed back.
    </div>}
    {reply.error && <Failure error={reply.error} />}

    <div className="panel">
      <h3>The queries</h3>
      <ol style={{ paddingLeft: 20 }}>
        {data.queries.map((query) => <li key={query.id} style={{ marginBottom: 14 }}>
          {query.subject && <div><strong>{query.subject}</strong></div>}
          {/* pre-wrap, not markdown: this is what a subcontractor typed, shown as text. */}
          <div style={{ whiteSpace: 'pre-wrap' }}>{query.body_text}</div>
          <div className="tiny muted">Raised {new Date(query.raised_at).toLocaleDateString()}</div>
        </li>)}
      </ol>
    </div>

    {data.messages.length > 0 && <div className="panel">
      <h3>What has been said so far</h3>
      <CommsTimeline messages={data.messages} />
    </div>}

    <div className="panel">
      <h3>Your response</h3>
      <div className="compose-field">
        <label htmlFor="client-answer">Response</label>
        <textarea
          id="client-answer" rows={8} value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="Answer the queries above, numbering them if it helps."
        />
      </div>
      <p className="tiny muted">
        You can also simply reply to the email this link came from — either way your answer
        reaches the same place.
      </p>
      <div className="button-row">
        <button disabled={!answer.trim() || reply.isPending} onClick={() => reply.mutate()}>
          {reply.isPending ? 'Sending…' : 'Send response'}
        </button>
      </div>
    </div>
  </Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="portal-shell"><div className="portal-content">{children}</div></main>;
}

function Failure({ error }: { error: unknown }) {
  return <p className="error">{error instanceof Error ? error.message : 'Something went wrong'}</p>;
}
