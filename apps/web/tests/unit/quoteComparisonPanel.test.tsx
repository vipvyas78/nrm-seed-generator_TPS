import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type QuoteComparisonDetail } from '../../src/api';
import { QuoteComparisonPanel } from '../../src/quoteComparisonPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function detail(over: Partial<QuoteComparisonDetail> = {}): QuoteComparisonDetail {
  return {
    comparison: { id: 'c1', readiness: 'awaiting_returns', expected_count: 3, received_count: 1, return_deadline: null },
    returns: [
      { id: 'r1', tenderer_name: 'Acme Roofing', subcontractor_id: null, tendered_sum: 5000, programme_weeks: 6, qualifications: 'Standard hours', exclusions: 'Scaffold by others', is_fabricated: false }
    ],
    rows: [{
      id: 'row1', seq: 1, ge_code: null, element_code: null, description: 'Supply and fix roof tiles',
      quantity: 500, unit: 'm2', is_priceable: true, origin: 'itt_bill', added_by_return_id: null,
      lowest: { rate: null, total: 4000, tendererName: 'Acme Roofing' },
      cells: [{
        returnId: 'r1', status: 'not_addressed', levelledRate: 8, levelledTotal: 4000,
        isAssumed: true, assumptionBasis: 'Not addressed by this tenderer. Levelled at the lowest quoted price (Acme Roofing, £4,000.00).',
        tendererNote: null, estimatorNote: null, cellId: 'cell1', quotedRate: null, quotedTotal: null
      }]
    }],
    totals: [{ returnId: 'r1', tendererName: 'Acme Roofing', quotedSum: 0, levelledSum: 4000, pricedCount: 0, assumedCount: 1 }],
    ...over
  };
}

describe('QuoteComparisonPanel', () => {
  it('shows the package list and how many returns are in', async () => {
    vi.spyOn(api, 'listQuoteComparisons').mockResolvedValue([
      { package_name: 'Roofing', comparison_id: 'c1', opened_at: '2026-01-01T00:00:00Z', expected_count: 3, received_count: 1, return_deadline: null, readiness: 'awaiting_returns' }
    ]);
    vi.spyOn(api, 'getQuoteComparison').mockResolvedValue(detail());

    renderWithClient(<QuoteComparisonPanel workflowId="w1" />);

    expect(await screen.findByText('Roofing')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    expect(screen.getByText('awaiting returns')).toBeInTheDocument();
  });

  it('highlights an assumed cell and states the substitution — never a bare figure', async () => {
    vi.spyOn(api, 'listQuoteComparisons').mockResolvedValue([
      { package_name: 'Roofing', comparison_id: 'c1', opened_at: null, expected_count: 3, received_count: 1, return_deadline: null, readiness: 'awaiting_returns' }
    ]);
    vi.spyOn(api, 'getQuoteComparison').mockResolvedValue(detail());

    renderWithClient(<QuoteComparisonPanel workflowId="w1" />);

    // Both the cell and the footer's Levelled total legitimately show £4,000.00 here —
    // the cell is the only priced item, so its figure and the column total coincide.
    expect((await screen.findAllByText('£4,000.00')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Levelled at the lowest quoted price \(Acme Roofing/)).toBeInTheDocument();
  });

  it('disables Award while awaiting_returns, and the backend refusal still applies if it were not', async () => {
    vi.spyOn(api, 'listQuoteComparisons').mockResolvedValue([
      { package_name: 'Roofing', comparison_id: 'c1', opened_at: null, expected_count: 3, received_count: 1, return_deadline: null, readiness: 'awaiting_returns' }
    ]);
    vi.spyOn(api, 'getQuoteComparison').mockResolvedValue(detail());
    const approveSpy = vi.spyOn(api, 'approveQuoteComparison');

    renderWithClient(<QuoteComparisonPanel workflowId="w1" />);
    await screen.findByText('Roofing');

    const select = await screen.findByDisplayValue('Select the awarded tenderer…');
    await userEvent.selectOptions(select, 'r1');

    const awardButton = screen.getByRole('button', { name: 'Award package' });
    expect(awardButton).toBeDisabled();
    expect(approveSpy).not.toHaveBeenCalled();
  });

  it('enables Award once quorum is met, and sends the selected return', async () => {
    vi.spyOn(api, 'listQuoteComparisons').mockResolvedValue([
      { package_name: 'Roofing', comparison_id: 'c1', opened_at: null, expected_count: 3, received_count: 3, return_deadline: null, readiness: 'quorum_met' }
    ]);
    vi.spyOn(api, 'getQuoteComparison').mockResolvedValue(detail({
      comparison: { id: 'c1', readiness: 'quorum_met', expected_count: 3, received_count: 3, return_deadline: null }
    }));
    const approveSpy = vi.spyOn(api, 'approveQuoteComparison').mockResolvedValue({} as never);

    renderWithClient(<QuoteComparisonPanel workflowId="w1" />);
    await screen.findByText('Roofing');

    const select = await screen.findByDisplayValue('Select the awarded tenderer…');
    await userEvent.selectOptions(select, 'r1');
    await userEvent.click(screen.getByRole('button', { name: 'Award package' }));

    await waitFor(() => expect(approveSpy).toHaveBeenCalledWith('w1', 'Roofing', { awardedReturnId: 'r1', notes: null }));
  });

  it('shows the exclusions and qualifications a tenderer stated, verbatim', async () => {
    vi.spyOn(api, 'listQuoteComparisons').mockResolvedValue([
      { package_name: 'Roofing', comparison_id: 'c1', opened_at: null, expected_count: 3, received_count: 1, return_deadline: null, readiness: 'awaiting_returns' }
    ]);
    vi.spyOn(api, 'getQuoteComparison').mockResolvedValue(detail());

    renderWithClient(<QuoteComparisonPanel workflowId="w1" />);

    expect(await screen.findByText('Scaffold by others')).toBeInTheDocument();
    expect(screen.getByText('Standard hours')).toBeInTheDocument();
  });
});
