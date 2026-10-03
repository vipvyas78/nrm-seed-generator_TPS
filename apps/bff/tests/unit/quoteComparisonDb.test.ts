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
  applyOverride, approvalStatusFor, boqStatusFor, collectScopeNotes, composeAdjustmentNote, computeReadiness,
  findLowestQuote, levelCell, moneyGBP, sameItem, sumTotals, QUOTE_QUORUM
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

describe('boqStatusFor', () => {
  it('translates absent to not_addressed — the one status tender_boq_lines never learned', () => {
    // A row a tenderer never had the chance to address (an estimator's own reconciliation
    // row, or a short return) is `absent` on the comparison, but 008's CHECK on
    // tender_boq_lines predates that status. Awarding it must not throw.
    expect(boqStatusFor('absent')).toBe('not_addressed');
  });

  it('carries every other status through unchanged', () => {
    for (const status of ['priced', 'included', 'excluded', 'not_addressed'] as const) {
      expect(boqStatusFor(status)).toBe(status);
    }
  });
});

describe('sameItem', () => {
  it('is true for an exact match', () => {
    expect(sameItem({ description: 'Supply and fix roof tiles', unit: 'm2' }, { description: 'Supply and fix roof tiles', unit: 'm2' })).toBe(true);
  });

  it('ignores case, leading/trailing space and doubled internal space', () => {
    expect(sameItem({ description: 'Supply and fix roof tiles', unit: 'm2' }, { description: '  SUPPLY  and FIX roof   tiles ', unit: 'm2' })).toBe(true);
  });

  it('treats common unit spellings as the same unit', () => {
    expect(sameItem({ description: 'Roof tiles', unit: 'm2' }, { description: 'Roof tiles', unit: 'sq m' })).toBe(true);
    expect(sameItem({ description: 'Roof tiles', unit: 'm²' }, { description: 'Roof tiles', unit: 'sqm' })).toBe(true);
    expect(sameItem({ description: 'Concrete', unit: 'm3' }, { description: 'Concrete', unit: 'cu m' })).toBe(true);
  });

  it('is false for a genuine discrepancy — the issue’s own example', () => {
    expect(sameItem({ description: 'Supply and fix roof tiles', unit: 'm2' }, { description: 'Supply and fix roof SLATES', unit: 'm2' })).toBe(false);
  });

  it('is false when only the unit disagrees and the two are not known synonyms', () => {
    expect(sameItem({ description: 'Fencing', unit: 'lm' }, { description: 'Fencing', unit: 'nr' })).toBe(false);
  });

  it('treats a missing unit on either side as its own thing, not a wildcard', () => {
    expect(sameItem({ description: 'Fencing', unit: null }, { description: 'Fencing', unit: 'lm' })).toBe(false);
    expect(sameItem({ description: 'Fencing', unit: null }, { description: 'Fencing', unit: null })).toBe(true);
  });
});

describe('collectScopeNotes', () => {
  const returns = [
    { id: 'r1', qualifications: 'Standard hours only', exclusions: 'Scaffold by others', programmeWeeks: 6 },
    { id: 'r2', qualifications: null, exclusions: null, programmeWeeks: null }
  ];

  it('carries each return’s own header text through verbatim', () => {
    const notes = collectScopeNotes(returns, []);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ returnId: 'r1', qualifications: 'Standard hours only', exclusions: 'Scaffold by others', programmeWeeks: 6 });
    expect(notes[1]).toMatchObject({ returnId: 'r2', qualifications: null, exclusions: null, programmeWeeks: null });
  });

  it('lists every line a tenderer marked included or excluded, by name — not just their header text', () => {
    const rows = [
      { seq: 1, description: 'Scaffold', cells: [{ returnId: 'r1', status: 'excluded' as const }, { returnId: 'r2', status: 'priced' as const }] },
      { seq: 2, description: 'Attendance on others', cells: [{ returnId: 'r1', status: 'included' as const }, { returnId: 'r2', status: 'not_addressed' as const }] }
    ];
    const notes = collectScopeNotes(returns, rows);
    expect(notes[0]!.excludedItems).toEqual([{ seq: 1, description: 'Scaffold' }]);
    expect(notes[0]!.includedItems).toEqual([{ seq: 2, description: 'Attendance on others' }]);
    expect(notes[1]!.excludedItems).toEqual([]);
    expect(notes[1]!.includedItems).toEqual([]);
  });

  it('skips a row with no cell at all for a return, rather than throwing', () => {
    const rows = [{ seq: 1, description: 'Added by someone else', cells: [{ returnId: 'r2', status: 'priced' as const }] }];
    expect(() => collectScopeNotes(returns, rows)).not.toThrow();
    expect(collectScopeNotes(returns, rows)[0]!.includedItems).toEqual([]);
  });
});

describe('applyOverride', () => {
  const LEVELLED = { status: 'excluded' as const, levelledRate: 10, levelledTotal: 500, isAssumed: true, assumptionBasis: 'Excluded by this tenderer. Levelled at the lowest quoted price (Acme Roofing, £500.00).' };

  it('carries the automatic figure through unchanged with no override on file', () => {
    const result = applyOverride(LEVELLED, null, 500);
    expect(result.finalRate).toBe(10);
    expect(result.finalTotal).toBe(500);
    expect(result.hasOverride).toBe(false);
    expect(result.overrideStale).toBe(false);
    expect(result.autoLevelledTotal).toBe(500); // preserved even though there is no override to contrast it with
  });

  it('replaces the final figure with the override, keeping the automatic one alongside it', () => {
    const override = { adjustedRate: 12, adjustedTotal: 600, adjustmentReason: 'Confirmed scaffold is excluded, quoted separately.', adjustedAgainstQuotedTotal: null };
    const result = applyOverride(LEVELLED, override, null);
    expect(result.finalRate).toBe(12);
    expect(result.finalTotal).toBe(600);
    expect(result.hasOverride).toBe(true);
    expect(result.adjustmentReason).toContain('scaffold');
    expect(result.autoLevelledTotal).toBe(500); // what it would have read without the override
  });

  it('is stale once the tenderer’s own quoted figure has moved since the override was set', () => {
    const override = { adjustedRate: 12, adjustedTotal: 600, adjustmentReason: 'x', adjustedAgainstQuotedTotal: 400 };
    expect(applyOverride(LEVELLED, override, 400).overrideStale).toBe(false); // unchanged
    expect(applyOverride(LEVELLED, override, 450).overrideStale).toBe(true); // a resubmission moved it
  });
});

describe('composeAdjustmentNote', () => {
  it('leads with the override’s own reason when there is one, over the automatic basis', () => {
    const note = composeAdjustmentNote({
      hasOverride: true, adjustmentReason: 'Confirmed by phone.', autoAssumptionBasis: 'Levelled at the lowest quoted price.', estimatorNote: null
    });
    expect(note).toBe('Adjusted: Confirmed by phone.');
  });

  it('falls back to the automatic basis with no override', () => {
    const note = composeAdjustmentNote({ hasOverride: false, adjustmentReason: null, autoAssumptionBasis: 'Not addressed by this tenderer.', estimatorNote: null });
    expect(note).toBe('Not addressed by this tenderer.');
  });

  it('appends the estimator’s own cell note either way', () => {
    const note = composeAdjustmentNote({ hasOverride: false, adjustmentReason: null, autoAssumptionBasis: 'Not addressed.', estimatorNote: 'Confirmed verbally they will match.' });
    expect(note).toBe('Not addressed. Estimator note: Confirmed verbally they will match.');
  });

  it('is null when there is nothing to say at all', () => {
    expect(composeAdjustmentNote({ hasOverride: false, adjustmentReason: null, autoAssumptionBasis: null, estimatorNote: null })).toBeNull();
  });
});

describe('approvalStatusFor', () => {
  it('is approved when automatic levelling alone filled every gap', () => {
    // The user's own call: a cheapest-price substitution is the comparison working as
    // designed, not a human adjustment — only an override earns the "_with_adjustments".
    expect(approvalStatusFor([{ hasOverride: false }, { hasOverride: false }])).toBe('approved');
  });

  it('is approved_with_adjustments the moment any line carries an estimator override', () => {
    expect(approvalStatusFor([{ hasOverride: false }, { hasOverride: true }])).toBe('approved_with_adjustments');
  });

  it('is approved for an award with no lines at all', () => {
    expect(approvalStatusFor([])).toBe('approved');
  });
});

describe('moneyGBP', () => {
  it('formats to two decimal places with a thousands separator', () => {
    expect(moneyGBP(500)).toBe('£500.00');
    expect(moneyGBP(1234.5)).toBe('£1,234.50');
  });
});
