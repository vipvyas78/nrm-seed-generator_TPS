import { describe, expect, it } from 'vitest';
import type { QuoteComparisonSummary } from '../../src/api';
import {
  formatMoney, isReadyToApprove, readinessBadgeClass, readinessLabel, sortComparisonSummaries
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
