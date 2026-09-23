import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Addendum, type AddendumDelta, type AddendumPackageRow, type IssueAddendumResult } from '../../src/api';
import { AddendumDetail } from '../../src/addendum';

afterEach(cleanup);

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function delta(over: Partial<AddendumDelta> = {}): AddendumDelta {
  return {
    baseline_takeoff_id: 'TOQ-baseline',
    baseline_resolution: 'tendered',
    items_added: 2, items_removed: 0, items_changed: 1, items_unchanged: 40,
    packages: [
      { work_package: 'WP-CONCRETE', unattributed: false, added: 2, removed: 0, changed: 0 },
      { work_package: null, unattributed: true, added: 0, removed: 0, changed: 1 },
    ],
    delta: { added: [], removed: [], changed: [] },
    conflicts: { new: [], recurring: [], resolved: [], available: true },
    documents: { added: [], changed: [], removed: [], available: true },
    rung_mix: { clause_ref: 3, component_key: 0, classification: 0, wording: 0 },
    ...over,
  };
}

function pkgRow(over: Partial<AddendumPackageRow> = {}): AddendumPackageRow {
  return {
    addendum_id: 'a1', package_name: 'WP-CONCRETE', wp_code: 'WP-CONCRETE',
    proposed: true, included: true,
    items_added: 2, items_removed: 0, items_changed: 0,
    unattributed: false, revised_return_deadline: null,
    ...over,
  };
}

function addendum(over: Partial<Addendum> = {}): Addendum {
  return {
    id: 'a1', workflow_id: 'w1', seq: 1,
    takeoff_id: 'TOQ-current', baseline_takeoff_id: 'TOQ-baseline', package_version_id: 'pv-1',
    status: 'awaiting_approval',
    delta: delta(),
    created_by: null, created_at: '2026-01-01T00:00:00.000Z',
    approved_by: null, approved_at: null, issued_at: null, cancelled_at: null,
    packages: [
      pkgRow({ package_name: 'WP-CONCRETE' }),
      pkgRow({ package_name: 'Unattributed', wp_code: null, unattributed: true, included: true, items_added: 0, items_changed: 1 }),
    ],
    ...over,
  };
}

describe('AddendumDetail', () => {
  it('shows counts and the unattributed bucket as a thing to decide, not a thing to skip', () => {
    renderWithClient(<AddendumDetail addendum={addendum()} onApproved={vi.fn()} onIssued={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText('Added', { selector: '.stat-label' })).toBeInTheDocument();
    expect(screen.getByText('WP-CONCRETE')).toBeInTheDocument();
    expect(screen.getByText('unattributed')).toBeInTheDocument();
    // The unattributed bucket is a real row, not skipped — its Include checkbox exists.
    expect(screen.getByLabelText('Include unattributed')).toBeInTheDocument();
  });

  it('renders "not compared" rather than "nothing changed" when the baseline was never tendered', () => {
    const a = addendum({ delta: delta({ baseline_resolution: 'none', items_added: 0, items_removed: 0, items_changed: 0, items_unchanged: 0 }) });
    renderWithClient(<AddendumDetail addendum={a} onApproved={vi.fn()} onIssued={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText(/not compared/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing changed/i)).not.toBeInTheDocument();
  });

  it('renders "nothing changed" only when a real comparison found no changes', () => {
    const a = addendum({ delta: delta({ items_added: 0, items_removed: 0, items_changed: 0, items_unchanged: 40 }) });
    renderWithClient(<AddendumDetail addendum={a} onApproved={vi.fn()} onIssued={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText(/nothing changed/i)).toBeInTheDocument();
  });

  it('un-ticking a package and approving sends every package row, with the un-ticked one carrying no date', async () => {
    const user = userEvent.setup();
    const approveSpy = vi.spyOn(api, 'approveAddendum').mockResolvedValue({ ...addendum(), status: 'approved' } as never);
    const onApproved = vi.fn();
    renderWithClient(<AddendumDetail addendum={addendum()} onApproved={onApproved} onIssued={vi.fn()} onBack={vi.fn()} />);

    const includeConcrete = screen.getByLabelText('Include WP-CONCRETE');
    await user.click(includeConcrete);
    await user.click(screen.getByRole('button', { name: /approve addendum/i }));

    expect(approveSpy).toHaveBeenCalledWith('a1', {
      packages: [
        { packageName: 'WP-CONCRETE', included: false, revisedReturnDeadline: null },
        { packageName: 'Unattributed', included: true, revisedReturnDeadline: null },
      ]
    });
    approveSpy.mockRestore();
  });

  it('does not let an approved or issued addendum be re-ticked', () => {
    const a = addendum({ status: 'approved', approved_at: '2026-01-02T00:00:00.000Z' });
    renderWithClient(<AddendumDetail addendum={a} onApproved={vi.fn()} onIssued={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByLabelText('Include WP-CONCRETE')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /approve addendum/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /issue to subcontractors/i })).toBeInTheDocument();
  });

  it('issuing renders the send/fail/skip summary, including a partial failure', async () => {
    const user = userEvent.setup();
    const result: IssueAddendumResult = {
      ...addendum({ status: 'issued' }), sent: 3, failed: 1, skippedNoEmail: 0,
      detail: [{ shortlistEntryId: 's1', packageName: 'WP-CONCRETE', status: 'failed', error: 'boom' }],
    };
    const issueSpy = vi.spyOn(api, 'issueAddendum').mockResolvedValue(result);
    const a = addendum({ status: 'approved' });
    renderWithClient(<AddendumDetail addendum={a} onApproved={vi.fn()} onIssued={vi.fn()} onBack={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /issue to subcontractors/i }));

    expect(await screen.findByText(/Sent 3, failed 1/i)).toBeInTheDocument();
    issueSpy.mockRestore();
  });

  it('reports the conflict comparison as not made, distinctly from zero conflicts', () => {
    const a = addendum({ delta: delta({ conflicts: { new: [], recurring: [], resolved: [], available: false } }) });
    renderWithClient(<AddendumDetail addendum={a} onApproved={vi.fn()} onIssued={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText(/conflict comparison was not made/i)).toBeInTheDocument();
  });

  it('going back invokes onBack', () => {
    const onBack = vi.fn();
    renderWithClient(<AddendumDetail addendum={addendum()} onApproved={vi.fn()} onIssued={vi.fn()} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: /all addenda/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
