import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RfiCitation, RfiQuestion } from '../../src/api';
import { Citations, RfiQuestionCard } from '../../src/comms';

// Vitest's globals are off (see vite.config.ts), so Testing Library's own auto-cleanup
// never registers — without this, DOM from a previous test accumulates and every
// getByRole/getByText query in a later test sees duplicates.
afterEach(cleanup);

function question(over: Partial<RfiQuestion> = {}): RfiQuestion {
  return {
    id: 'q1', message_id: 'm1', thread_id: 't1', seq: 1,
    source_kind: 'body', source_ref: null,
    question_text: 'Is the ceiling grid included?',
    asked_by_name: 'Sam Colleague', asked_by_email: 'sam@acme.test',
    raised_at: '2026-09-10T09:00:00Z',
    status: 'drafted',
    canonical_question_id: null,
    estimator_answer_text: null,
    package_name: null,
    draft: null,
    sent: null,
    forwarded_to_client: false,
    ...over
  };
}

function noopActions(over: Partial<{
  approve: (id: string, answerText: string | null) => void;
  askClient: (id: string) => void;
  dismiss: (id: string) => void;
  pending: boolean;
}> = {}) {
  return {
    approve: vi.fn(), askClient: vi.fn(), dismiss: vi.fn(), pending: false,
    ...over
  };
}

describe('Citations', () => {
  it('renders nothing when there are no citations', () => {
    const { container } = render(<Citations citations={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links a citation that has a live shareUrl', () => {
    const citations: RfiCitation[] = [{
      passageId: 'p1', documentId: 'd1', filename: 'Spec.pdf',
      headingPath: '2E Walls', pageHint: 12, quotedText: 'Boarded both sides.',
      shareUrl: 'https://example.test/doc'
    }];
    render(<Citations citations={citations} />);
    const link = screen.getByRole('link', { name: /Spec\.pdf/ });
    expect(link).toHaveAttribute('href', 'https://example.test/doc?disposition=inline');
    expect(screen.getByText('Boarded both sides.')).toBeTruthy();
  });

  it('shows "(link unavailable)" rather than a dead anchor when shareUrl is null', () => {
    const citations: RfiCitation[] = [{
      passageId: 'p1', documentId: 'd1', filename: 'Spec.pdf',
      headingPath: null, pageHint: null, quotedText: 'Boarded both sides.',
      shareUrl: null
    }];
    render(<Citations citations={citations} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/Spec\.pdf/)).toBeTruthy();
    expect(screen.getByText(/link unavailable/)).toBeTruthy();
  });
});

describe('RfiQuestionCard', () => {
  it('disables Approve when there is neither a usable draft nor any typed text', () => {
    render(<RfiQuestionCard
      question={question({ draft: { id: 'd1', status: 'insufficient_evidence', answer_text: null, confidence: null, needs_client: false, citations: [], reject_reason: null, drafted_at: '2026-09-10T09:00:00Z' } })}
      actions={noopActions()}
      selectedForSend={false} onToggleSend={vi.fn()}
      selectedForClient={false} onToggleClient={vi.fn()}
    />);
    expect(screen.getByText(/The app could not answer this/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('enables Approve, and sends null answerText, when a usable draft exists and nothing was edited', async () => {
    const actions = noopActions();
    render(<RfiQuestionCard
      question={question({ draft: { id: 'd1', status: 'proposed', answer_text: 'Yes, per clause 2E.310.', confidence: 0.9, needs_client: false, citations: [], reject_reason: null, drafted_at: '2026-09-10T09:00:00Z' } })}
      actions={actions}
      selectedForSend={false} onToggleSend={vi.fn()}
      selectedForClient={false} onToggleClient={vi.fn()}
    />);
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).not.toBeDisabled();
    await userEvent.click(approve);
    expect(actions.approve).toHaveBeenCalledWith('q1', null);
  });

  it('enables Approve once the estimator types an answer, and sends the edited text', async () => {
    const actions = noopActions();
    render(<RfiQuestionCard
      question={question({ draft: null })}
      actions={actions}
      selectedForSend={false} onToggleSend={vi.fn()}
      selectedForClient={false} onToggleClient={vi.fn()}
    />);
    // No usable draft and no prior estimator text: opens straight into the textarea.
    const textarea = screen.getByPlaceholderText('Write the answer to send.');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await userEvent.type(textarea, 'Yes, that is correct.');
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).not.toBeDisabled();
    await userEvent.click(approve);
    expect(actions.approve).toHaveBeenCalledWith('q1', 'Yes, that is correct.');
  });

  it('calls askClient and dismiss with the question id', async () => {
    const actions = noopActions();
    render(<RfiQuestionCard
      question={question({ draft: { id: 'd1', status: 'proposed', answer_text: 'An answer.', confidence: 0.9, needs_client: false, citations: [], reject_reason: null, drafted_at: '2026-09-10T09:00:00Z' } })}
      actions={actions}
      selectedForSend={false} onToggleSend={vi.fn()}
      selectedForClient={false} onToggleClient={vi.fn()}
    />);
    await userEvent.click(screen.getByRole('button', { name: 'Ask the client' }));
    expect(actions.askClient).toHaveBeenCalledWith('q1');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(actions.dismiss).toHaveBeenCalledWith('q1');
  });

  it('renders a sent question read-only, with no action buttons', () => {
    render(<RfiQuestionCard
      question={question({ status: 'sent' })}
      actions={noopActions()}
      selectedForSend={false} onToggleSend={vi.fn()}
      selectedForClient={false} onToggleClient={vi.fn()}
    />);
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('offers the send checkbox only once approved', () => {
    const { rerender } = render(<RfiQuestionCard
      question={question({ status: 'drafted' })}
      actions={noopActions()}
      selectedForSend={false} onToggleSend={vi.fn()}
      selectedForClient={false} onToggleClient={vi.fn()}
    />);
    expect(screen.queryByText('Include in send')).toBeNull();

    rerender(<RfiQuestionCard
      question={question({ status: 'approved', estimator_answer_text: 'An answer.' })}
      actions={noopActions()}
      selectedForSend={false} onToggleSend={vi.fn()}
      selectedForClient={false} onToggleClient={vi.fn()}
    />);
    expect(screen.getByText('Include in send')).toBeTruthy();
  });
});
