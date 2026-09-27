/**
 * The pure levelling rules behind the quote comparison (BuildFlow issue #100).
 *
 * These are the part of the feature that can be wrong in a way nobody notices: a cell
 * that should read as an assumption but does not, a total that quietly includes a
 * substitution as if it were a real quote. Each test below is one row of the levelling
 * table the design settled on, plus the two cases that are easy to get wrong — a row
 * nobody priced at all, and a status the tenderer chose but backed with no figure.
 */
import { describe, expect, it } from 'vitest';
import {
  computeReadiness, findLowestQuote, levelCell, moneyGBP, sumTotals, QUOTE_QUORUM
} from '../../src/quoteComparisonDb.js';

const LOWEST = { rate: 10, total: 500, tendererName: 'Acme Roofing' };

describe('levelCell', () => {
  it('carries a priced line through unchanged', () => {
    const cell = levelCell({ lineStatus: 'priced', quotedRate: 12, quotedTotal: 600, lowest: LOWEST });
    expect(cell).toEqual({ status: 'priced', levelledRate: 12, levelledTotal: 600, isAssumed: false, assumptionBasis: null });
  });

  it('levels an included line at zero, and says why', () => {
    const cell = levelCell({ lineStatus: 'included', quotedRate: null, quotedTotal: null, lowest: LOWEST });
    expect(cell.levelledRate).toBe(0);
    expect(cell.levelledTotal).toBe(0);
    expect(cell.isAssumed).toBe(true);
    expect(cell.assumptionBasis).toContain('included in the price');
  });

  it('substitutes the lowest quoted price for an excluded line, naming the firm and the figure', () => {
    const cell = levelCell({ lineStatus: 'excluded', quotedRate: null, quotedTotal: null, lowest: LOWEST });
    expect(cell.status).toBe('excluded');
    expect(cell.levelledRate).toBe(10);
    expect(cell.levelledTotal).toBe(500);
    expect(cell.isAssumed).toBe(true);
    expect(cell.assumptionBasis).toContain('Excluded by this tenderer');
    expect(cell.assumptionBasis).toContain('Acme Roofing');
    expect(cell.assumptionBasis).toContain('£500.00');
  });

  it('substitutes the lowest quoted price for a line not addressed', () => {
    const cell = levelCell({ lineStatus: 'not_addressed', quotedRate: null, quotedTotal: null, lowest: LOWEST });
    expect(cell.status).toBe('not_addressed');
    expect(cell.levelledTotal).toBe(500);
    expect(cell.isAssumed).toBe(true);
    expect(cell.assumptionBasis).toContain('Not addressed');
  });

  it('reads a return with no line at all as absent, not not_addressed — the tenderer never had the line to answer', () => {
    const cell = levelCell({ lineStatus: null, quotedRate: null, quotedTotal: null, lowest: LOWEST });
    expect(cell.status).toBe('absent');
    expect(cell.levelledTotal).toBe(500);
    expect(cell.assumptionBasis).toContain('Not in this tenderer’s return');
  });

  it('leaves a row nobody priced at null rather than inventing a figure', () => {
    const cell = levelCell({ lineStatus: 'excluded', quotedRate: null, quotedTotal: null, lowest: null });
    expect(cell.levelledRate).toBeNull();
    expect(cell.levelledTotal).toBeNull();
    expect(cell.isAssumed).toBe(true);
    expect(cell.assumptionBasis).toBe('Excluded by this tenderer. No tenderer priced this item.');
  });

  it('treats "priced" with no figure as an assumption, but still reports the status the tenderer chose', () => {
    // A status they picked is not evidence on its own — this is the case that is easy to
    // get wrong by trusting `status === 'priced'` at face value.
    const cell = levelCell({ lineStatus: 'priced', quotedRate: null, quotedTotal: null, lowest: LOWEST });
    expect(cell.status).toBe('priced');
    expect(cell.isAssumed).toBe(true);
    expect(cell.levelledTotal).toBe(500);
    expect(cell.assumptionBasis).toContain('Marked priced but no rate was given');
  });

  it('is never assumed without stating why', () => {
    // The database enforces this too (qcc_assumption_stated), but the levelling function
    // is where the guarantee actually has to be true.
    for (const status of ['priced', 'included', 'excluded', 'not_addressed', null] as const) {
      const cell = levelCell({ lineStatus: status, quotedRate: null, quotedTotal: null, lowest: LOWEST });
      if (cell.isAssumed) expect(cell.assumptionBasis).not.toBeNull();
    }
  });
});

describe('findLowestQuote', () => {
  it('picks the cheapest TOTAL, not the cheapest rate', () => {
    // A tenderer may price their own quantity on a line, so rate and total do not always
    // rank the same tenderer cheapest — total is the number that actually costs money.
    const lowest = findLowestQuote([
      { total: 800, rate: 4, tendererName: 'Cheap rate, big quantity' },
      { total: 500, rate: 10, tendererName: 'Acme Roofing' }
    ]);
    expect(lowest?.tendererName).toBe('Acme Roofing');
    expect(lowest?.total).toBe(500);
  });

  it('ignores a return with no total at all', () => {
    const lowest = findLowestQuote([{ total: null, rate: null, tendererName: 'Silent Ltd' }, { total: 500, rate: 10, tendererName: 'Acme Roofing' }]);
    expect(lowest?.tendererName).toBe('Acme Roofing');
  });

  it('is null when nobody priced the row at all', () => {
    expect(findLowestQuote([{ total: null, rate: null, tendererName: 'A' }])).toBeNull();
    expect(findLowestQuote([])).toBeNull();
  });
});

describe('sumTotals', () => {
  it('separates the quoted sum from the levelled sum', () => {
    const cells = [
      { status: 'priced' as const, quotedTotal: 600, levelledTotal: 600 },
      { status: 'excluded' as const, quotedTotal: null, levelledTotal: 500 }, // substituted
      { status: 'included' as const, quotedTotal: null, levelledTotal: 0 }
    ];
    const totals = sumTotals(cells);
    // Only the genuinely priced line counts toward what was actually quoted.
    expect(totals.quotedSum).toBe(600);
    // Every levelled figure counts toward the comparable total, substitutions included —
    // this is the number that would flatter a tenderer who omitted the most.
    expect(totals.levelledSum).toBe(1100);
    expect(totals.pricedCount).toBe(1);
    expect(totals.assumedCount).toBe(2);
  });

  it('treats a row nobody priced as contributing nothing to either total', () => {
    const totals = sumTotals([{ status: 'excluded' as const, quotedTotal: null, levelledTotal: null }]);
    expect(totals.quotedSum).toBe(0);
    expect(totals.levelledSum).toBe(0);
    expect(totals.assumedCount).toBe(1);
  });
});

describe('computeReadiness', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const future = new Date('2026-10-15T00:00:00Z');
  const past = new Date('2026-09-15T00:00:00Z');

  it('is awaiting_returns below quorum with no deadline passed', () => {
    expect(computeReadiness(1, future, now)).toBe('awaiting_returns');
    expect(computeReadiness(1, null, now)).toBe('awaiting_returns');
  });

  it('is quorum_met at the issue’s own number of returns, regardless of the deadline', () => {
    expect(QUOTE_QUORUM).toBe(3);
    expect(computeReadiness(3, future, now)).toBe('quorum_met');
    expect(computeReadiness(5, null, now)).toBe('quorum_met');
  });

  it('is deadline_passed below quorum once the date has gone — "consider whatever it has"', () => {
    expect(computeReadiness(1, past, now)).toBe('deadline_passed');
    expect(computeReadiness(0, past, now)).toBe('deadline_passed');
  });

  it('quorum outranks a passed deadline', () => {
    expect(computeReadiness(3, past, now)).toBe('quorum_met');
  });
});

describe('moneyGBP', () => {
  it('formats to two decimal places with a thousands separator', () => {
    expect(moneyGBP(500)).toBe('£500.00');
    expect(moneyGBP(1234.5)).toBe('£1,234.50');
  });
});
