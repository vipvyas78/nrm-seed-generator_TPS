import type { QuoteCellStatus, QuoteComparisonReadiness, QuoteComparisonSummary } from './api';

/**
 * Pure presentation helpers for the levelled quote comparison (BuildFlow issue #100).
 * Kept out of quoteComparison.tsx for the same reason addendumDelta.ts is kept out of
 * addendum.tsx: the one thing worth getting exactly right here is unit-tested without a
 * DOM, rather than trusted to a component test that happens to render the right words.
 */

/** The banner text for a package's readiness — never hides HOW MANY are in, because "we
 *  are proceeding on 1 of 3" and "we are proceeding on 3 of 3" are different facts an
 *  estimator needs on screen even though both are technically "ready". */
export function readinessLabel(summary: {
  readiness: QuoteComparisonReadiness; expected_count: number; received_count: number; return_deadline: string | null;
}): string {
  const counts = `${summary.received_count} of ${summary.expected_count} returns in`;
  if (summary.readiness === 'quorum_met') return `${counts} — ready to compare`;
  if (summary.readiness === 'deadline_passed') {
    return `${counts} — the return date has passed, so proceeding with what has been received`;
  }
  const deadline = summary.return_deadline ? ` (return date ${summary.return_deadline})` : '';
  return `${counts} — waiting for at least 3, or for the return date${deadline}`;
}

export function readinessBadgeClass(readiness: QuoteComparisonReadiness): string {
  if (readiness === 'quorum_met') return 'badge-green';
  if (readiness === 'deadline_passed') return 'badge-amber';
  return 'badge-grey';
}

/** Whether the AWARD button should even be offered. The real guard is the server's — see
 *  quoteComparisonDb.ts's approve() — this only decides whether asking is worth showing. */
export function isReadyToApprove(readiness: QuoteComparisonReadiness): boolean {
  return readiness !== 'awaiting_returns';
}

export function formatMoney(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return `£${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface PriceCellDisplay {
  /** The headline figure — the levelled total this comparison actually carries. */
  primary: string;
  /** The per-unit rate behind that total, shown beside it — the issue's own three-column
   *  example asks for a price per quote, and a bare total hides whether a cheap-looking
   *  figure came from a cheap rate or a tenderer quietly priced their own smaller quantity. */
  secondary: string | null;
  tone: 'priced' | 'assumed' | 'variant' | 'absent';
}

/** How one cell's price column reads — never re-deriving a figure, only formatting
 *  exactly what the server already levelled (see quoteComparisonPanel.tsx's own doc
 *  comment on why that line is never crossed from this side). */
export function priceCellDisplay(
  cell: { status: QuoteCellStatus; levelledTotal: number | null; levelledRate: number | null; isAssumed: boolean },
  unit: string | null
): PriceCellDisplay {
  if (cell.status === 'priced_as_variant') {
    return { primary: formatMoney(0), secondary: 'priced under their own wording — see below', tone: 'variant' };
  }
  if (cell.levelledTotal == null) {
    return { primary: '—', secondary: cell.status === 'absent' ? 'no return' : null, tone: 'absent' };
  }
  const secondary = cell.levelledRate != null ? `${formatMoney(cell.levelledRate)}${unit ? `/${unit}` : ''}` : null;
  return { primary: formatMoney(cell.levelledTotal), secondary, tone: cell.isAssumed ? 'assumed' : 'priced' };
}

/** Packages worth the estimator's attention first: not yet opened, or open and ready. A
 *  package still awaiting returns is real work to come back to, not a decision pending
 *  now, so it sorts after the ones something can actually be done with today. */
export function sortComparisonSummaries(summaries: QuoteComparisonSummary[]): QuoteComparisonSummary[] {
  const rank = (s: QuoteComparisonSummary): number => (s.readiness === 'awaiting_returns' ? 1 : 0);
  return [...summaries].sort((a, b) => rank(a) - rank(b) || a.package_name.localeCompare(b.package_name));
}
