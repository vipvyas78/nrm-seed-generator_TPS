import { describe, expect, it } from 'vitest';
import type { QuoteComparisonSummary, QuoteQuery } from '../../src/api';
import {
  formatMoney, isOpenQueriesRefusal, isQueryOpen, isReadyToApprove, openQueryCountByReturn,
  priceCellDisplay, readinessBadgeClass, readinessLabel, sortComparisonSummaries
} from '../../src/quoteComparison';

function summary(over: Partial<QuoteComparisonSummary> = {}): QuoteComparisonSummary {
  return {
    package_name: 'Roofing', comparison_id: null, opened_at: null,
    expected_count: 3, received_count: 0, return_deadline: null, readiness: 'awaiting_returns',
    ...over
  };
}

describe('readinessLabel', () => {
  it('always states the count, even when it is not ready', () => {
    expect(readinessLabel(summary({ received_count: 1 }))).toContain('1 of 3 returns in');
    expect(readinessLabel(summary({ received_count: 1 }))).toContain('waiting');
  });

  it('says ready once quorum is met, without waiting on the deadline', () => {
    expect(readinessLabel(summary({ received_count: 3, readiness: 'quorum_met' })))
      .toBe('3 of 3 returns in — ready to compare');
  });

  it('names the deadline explicitly once it has passed, with however few returns are in', () => {
    const label = readinessLabel(summary({ received_count: 1, readiness: 'deadline_passed' }));
    expect(label).toContain('1 of 3 returns in');
    expect(label).toContain('return date has passed');
  });

  it('shows the return date when one is known and the comparison is still waiting', () => {
    expect(readinessLabel(summary({ received_count: 0, return_deadline: '2026-10-14' })))
      .toContain('2026-10-14');
  });
});

describe('readinessBadgeClass', () => {
  it('is distinct for each readiness', () => {
    const classes = new Set([
      readinessBadgeClass('awaiting_returns'), readinessBadgeClass('quorum_met'), readinessBadgeClass('deadline_passed')
    ]);
    expect(classes.size).toBe(3);
  });
});

describe('isReadyToApprove', () => {
  it('is false only while awaiting returns', () => {
    expect(isReadyToApprove('awaiting_returns')).toBe(false);
    expect(isReadyToApprove('quorum_met')).toBe(true);
    expect(isReadyToApprove('deadline_passed')).toBe(true);
  });
});

describe('formatMoney', () => {
  it('formats a real figure and dashes a missing one', () => {
    expect(formatMoney(1234.5)).toBe('£1,234.50');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
  });
});

function cell(over: Partial<{
  status: string; levelledTotal: number | null; levelledRate: number | null; isAssumed: boolean;
  hasOverride: boolean; autoLevelledTotal: number | null;
}> = {}) {
  return {
    status: 'priced', levelledTotal: 0, levelledRate: 0, isAssumed: false,
    hasOverride: false, autoLevelledTotal: null,
    ...over
  } as never;
}

describe('priceCellDisplay', () => {
  it('shows the rate beside the total for a genuine quote', () => {
    const display = priceCellDisplay(cell({ status: 'priced', levelledTotal: 6000, levelledRate: 12 }), 'm2');
    expect(display.primary).toBe('£6,000.00');
    expect(display.secondary).toBe('£12.00/m2');
    expect(display.tone).toBe('priced');
  });

  it('omits the rate when there is none to show, without hiding the total', () => {
    const display = priceCellDisplay(cell({ status: 'included', levelledTotal: 0, levelledRate: 0, isAssumed: true }), null);
    expect(display.primary).toBe('£0.00');
  });

  it('marks a substituted figure as assumed', () => {
    const display = priceCellDisplay(cell({ status: 'excluded', levelledTotal: 500, levelledRate: 10, isAssumed: true }), 'nr');
    expect(display.tone).toBe('assumed');
  });

  it('points at the variant row rather than showing a real total for priced_as_variant', () => {
    const display = priceCellDisplay(cell({ status: 'priced_as_variant', levelledTotal: 0, levelledRate: 0, isAssumed: true }), 'm2');
    expect(display.primary).toBe('£0.00');
    expect(display.secondary).toContain('own wording');
    expect(display.tone).toBe('variant');
  });

  it('shows no return rather than a figure when nobody priced it and there is nothing to substitute', () => {
    const display = priceCellDisplay(cell({ status: 'absent', levelledTotal: null, levelledRate: null, isAssumed: true }), 'nr');
    expect(display.primary).toBe('—');
    expect(display.secondary).toBe('no return');
    expect(display.tone).toBe('absent');
  });

  it('shows the override as the headline figure, with the automatic one struck through alongside it', () => {
    const display = priceCellDisplay(cell({
      status: 'excluded', levelledTotal: 600, levelledRate: 12, isAssumed: true, hasOverride: true, autoLevelledTotal: 500
    }), 'm2');
    expect(display.primary).toBe('£600.00'); // the override
    expect(display.strikethrough).toBe('£500.00'); // what it would have read without it
    expect(display.tone).toBe('override');
  });
});

function query(over: Partial<QuoteQuery> = {}): QuoteQuery {
  return {
    id: 'q1', comparison_id: 'c1', return_id: 'r1', row_id: null, cell_id: null,
    question: 'A question', raised_at: '2026-10-01T00:00:00Z', email_status: 'draft',
    email_error: null, recipient_email: null, sent_at: null,
    response: null, response_source: null, responded_at: null, withdrawn_at: null,
    ...over
  };
}

describe('isQueryOpen', () => {
  it('is open with no response and not withdrawn', () => {
    expect(isQueryOpen(query())).toBe(true);
  });

  it('is closed once answered', () => {
    expect(isQueryOpen(query({ response: 'Yes', responded_at: '2026-10-02T00:00:00Z' }))).toBe(false);
  });

  it('is closed once withdrawn', () => {
    expect(isQueryOpen(query({ withdrawn_at: '2026-10-02T00:00:00Z' }))).toBe(false);
  });
});

describe('openQueryCountByReturn', () => {
  it('counts only open queries, grouped by return', () => {
    const counts = openQueryCountByReturn([
      query({ id: 'q1', return_id: 'r1' }),
      query({ id: 'q2', return_id: 'r1' }),
      query({ id: 'q3', return_id: 'r2', response: 'Answered' }),
      query({ id: 'q4', return_id: 'r3', withdrawn_at: '2026-10-02T00:00:00Z' })
    ]);
    expect(counts).toEqual({ r1: 2 });
  });

  it('is empty for no queries at all', () => {
    expect(openQueryCountByReturn([])).toEqual({});
  });
});

describe('isOpenQueriesRefusal', () => {
  it('recognises the server’s own wording', () => {
    expect(isOpenQueriesRefusal('There is 1 open query to this tenderer that have not been answered yet.')).toBe(true);
    expect(isOpenQueriesRefusal('There are 3 open queries to this tenderer that have not been answered yet.')).toBe(true);
  });

  it('is false for any other refusal, or none at all', () => {
    expect(isOpenQueriesRefusal('Only 1 of the expected 3 returns are in.')).toBe(false);
    expect(isOpenQueriesRefusal(null)).toBe(false);
    expect(isOpenQueriesRefusal(undefined)).toBe(false);
  });
});

describe('sortComparisonSummaries', () => {
  it('puts a package still awaiting returns after one there is work to do on today', () => {
    const sorted = sortComparisonSummaries([
      summary({ package_name: 'Zzz Package', readiness: 'awaiting_returns' }),
      summary({ package_name: 'Aaa Package', readiness: 'quorum_met' })
    ]);
    expect(sorted.map((s) => s.package_name)).toEqual(['Aaa Package', 'Zzz Package']);
  });

  it('is alphabetical within the same readiness', () => {
    const sorted = sortComparisonSummaries([
      summary({ package_name: 'Roofing', readiness: 'quorum_met' }),
      summary({ package_name: 'Cladding', readiness: 'quorum_met' })
    ]);
    expect(sorted.map((s) => s.package_name)).toEqual(['Cladding', 'Roofing']);
  });
});
