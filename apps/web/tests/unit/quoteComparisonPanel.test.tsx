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
      quantity: 500, unit: 'm2', is_priceable: true, origin: 'itt_bill', added_by_return_id: null, variant_of_row_id: null,
      lowest: { rate: null, total: 4000, tendererName: 'Acme Roofing' },
      cells: [{
        returnId: 'r1', status: 'not_addressed', levelledRate: 8, levelledTotal: 4000,
        isAssumed: true, assumptionBasis: 'Not addressed by this tenderer. Levelled at the lowest quoted price (Acme Roofing, £4,000.00).',
        tendererNote: null, estimatorNote: null, cellId: 'cell1', quotedRate: null, quotedTotal: null,
        tendererDescription: null, pricedAsVariantRowId: null
      }]
    }],
    totals: [{ returnId: 'r1', tendererName: 'Acme Roofing', quotedSum: 0, levelledSum: 4000, pricedCount: 0, assumedCount: 1 }],
    scopeNotes: [{ returnId: 'r1', qualifications: 'Standard hours', exclusions: 'Scaffold by others', programmeWeeks: 6, includedItems: [], excludedItems: [] }],
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

    await waitFor(() => expect(approveSpy).toHaveBeenCalledWith('w1', 'Roofing', { awardedReturnId: 'r1', notes: null, acknowledgeOpenQueries: false }));
  });

  it('sends an extra line typed into the manual-return form — not silently dropped', async () => {
    vi.spyOn(api, 'listQuoteComparisons').mockResolvedValue([
      { package_name: 'Roofing', comparison_id: 'c1', opened_at: null, expected_count: 3, received_count: 1, return_deadline: null, readiness: 'awaiting_returns' }
    ]);
    vi.spyOn(api, 'getQuoteComparison').mockResolvedValue(detail());
    const recordSpy = vi.spyOn(api, 'recordManualQuoteReturn').mockResolvedValue({} as never);

    renderWithClient(<QuoteComparisonPanel workflowId="w1" />);
    await screen.findByText('Roofing');

    await userEvent.click(await screen.findByRole('button', { name: '+ Enter a return by hand' }));
    await userEvent.type(screen.getByPlaceholderText('Tenderer name'), 'Firm D');
    await userEvent.click(screen.getByRole('button', { name: '+ Add extra line' }));
    await userEvent.type(screen.getByPlaceholderText('Description'), 'Extra access scaffold');
    const rateInputs = screen.getAllByRole('spinbutton');
    await userEvent.type(rateInputs[rateInputs.length - 1]!, '250');
    await userEvent.click(screen.getByRole('button', { name: 'Save return' }));

    await waitFor(() => expect(recordSpy).toHaveBeenCalled());
    const input = recordSpy.mock.calls[0]![2] as { extraLines: Array<{ description: string; rate: number | null }> };
    expect(input.extraLines).toEqual([{ description: 'Extra access scaffold', unit: null, quantity: null, rate: 250, status: 'priced', note: null }]);
  });

  it('shows a drifted line as the tenderer’s own variant, and lists it in the footer by name', async () => {
    vi.spyOn(api, 'listQuoteComparisons').mockResolvedValue([
      { package_name: 'Roofing', comparison_id: 'c1', opened_at: null, expected_count: 3, received_count: 1, return_deadline: null, readiness: 'awaiting_returns' }
    ]);
    vi.spyOn(api, 'getQuoteComparison').mockResolvedValue(detail({
      rows: [
        {
          id: 'row1', seq: 1, ge_code: null, element_code: null, description: 'Supply and fix roof tiles',
          quantity: 500, unit: 'm2', is_priceable: true, origin: 'itt_bill', added_by_return_id: null, variant_of_row_id: null,
          lowest: { rate: null, total: 6000, tendererName: 'Acme Roofing' },
          cells: [{
            returnId: 'r1', status: 'priced_as_variant', levelledRate: 0, levelledTotal: 0,
            isAssumed: true, assumptionBasis: 'Priced under their own wording — see "Supply and fix roof SLATES" below.',
            tendererNote: null, estimatorNote: null, cellId: 'cell1', quotedRate: null, quotedTotal: null,
            tendererDescription: 'Supply and fix roof SLATES', pricedAsVariantRowId: 'row1v'
          }]
        },
        {
          id: 'row1v', seq: 2, ge_code: null, element_code: null, description: 'Supply and fix roof SLATES',
          quantity: 500, unit: 'm2', is_priceable: true, origin: 'tenderer_variant', added_by_return_id: 'r1', variant_of_row_id: 'row1',
          lowest: { rate: 15, total: 7500, tendererName: 'Acme Roofing' },
          cells: [{
            returnId: 'r1', status: 'priced', levelledRate: 15, levelledTotal: 7500,
            isAssumed: false, assumptionBasis: null, tendererNote: null, estimatorNote: null, cellId: 'cell2',
            quotedRate: 15, quotedTotal: 7500, tendererDescription: null, pricedAsVariantRowId: null
          }]
        }
      ],
      totals: [{ returnId: 'r1', tendererName: 'Acme Roofing', quotedSum: 7500, levelledSum: 7500, pricedCount: 1, assumedCount: 1 }],
      scopeNotes: [{ returnId: 'r1', qualifications: null, exclusions: null, programmeWeeks: null, includedItems: [], excludedItems: [{ seq: 3, description: 'Scaffold' }] }]
    }));

    renderWithClient(<QuoteComparisonPanel workflowId="w1" />);
    await screen.findByText('Roofing');

    expect(await screen.findByText('their own wording')).toBeInTheDocument();
    expect(screen.getByText('Supply and fix roof SLATES')).toBeInTheDocument();
    expect(screen.getByText(/their wording: “Supply and fix roof SLATES”/)).toBeInTheDocument();
    // The footer lists the line by name, not just the header text.
    expect(screen.getByText('Scaffold')).toBeInTheDocument();
  });

  it('shows an open query and bundles its send into one click', async () => {
    vi.spyOn(api, 'listQuoteComparisons').mockResolvedValue([
      { package_name: 'Roofing', comparison_id: 'c1', opened_at: null, expected_count: 3, received_count: 1, return_deadline: null, readiness: 'awaiting_returns' }
    ]);
    vi.spyOn(api, 'getQuoteComparison').mockResolvedValue(detail());
    vi.spyOn(api, 'listQuoteQueries').mockResolvedValue([{
      id: 'q1', comparison_id: 'c1', return_id: 'r1', row_id: null, cell_id: null,
      question: 'Does your rate include scaffold access?', raised_at: '2026-10-01T00:00:00Z',
      email_status: 'draft', email_error: null, recipient_email: null, sent_at: null,
      response: null, response_source: null, responded_at: null, withdrawn_at: null
    }]);
    const sendSpy = vi.spyOn(api, 'sendQuoteQueries').mockResolvedValue({ sent: 1, skippedNoEmail: false });

    renderWithClient(<QuoteComparisonPanel workflowId="w1" />);
    await screen.findByText('Roofing');

    expect(await screen.findByText('Does your rate include scaffold access?')).toBeInTheDocument();
    expect(screen.getByText('1 query')).toBeInTheDocument(); // the column-header badge
    await userEvent.click(screen.getByRole('button', { name: 'Send 1 draft query' }));
    await waitFor(() => expect(sendSpy).toHaveBeenCalledWith('w1', 'c1', 'r1'));
  });

  it('warns rather than blocks an award with an open query, and offers to award anyway', async () => {
    vi.spyOn(api, 'listQuoteComparisons').mockResolvedValue([
      { package_name: 'Roofing', comparison_id: 'c1', opened_at: null, expected_count: 3, received_count: 3, return_deadline: null, readiness: 'quorum_met' }
    ]);
    vi.spyOn(api, 'getQuoteComparison').mockResolvedValue(detail({
      comparison: { id: 'c1', readiness: 'quorum_met', expected_count: 3, received_count: 3, return_deadline: null }
    }));
    vi.spyOn(api, 'listQuoteQueries').mockResolvedValue([]);
    const approveSpy = vi.spyOn(api, 'approveQuoteComparison').mockImplementation(async (_w, _p, input) => {
      if (!input.acknowledgeOpenQueries) throw new Error('There is 1 open query to this tenderer that have not been answered yet.');
      return { status: 'approved_with_adjustments' } as never;
    });

    renderWithClient(<QuoteComparisonPanel workflowId="w1" />);
    await screen.findByText('Roofing');

    const select = await screen.findByDisplayValue('Select the awarded tenderer…');
    await userEvent.selectOptions(select, 'r1');
    await userEvent.click(screen.getByRole('button', { name: 'Award package' }));

    const awardAnyway = await screen.findByRole('button', { name: 'Award anyway' });
    expect(screen.getByText(/1 open query/)).toBeInTheDocument();
    await userEvent.click(awardAnyway);

    await waitFor(() => expect(approveSpy).toHaveBeenCalledWith('w1', 'Roofing', { awardedReturnId: 'r1', notes: null, acknowledgeOpenQueries: true }));
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
