import type { AddendumDelta, AddendumDeltaChange, AddendumPackageRow } from './api';

/**
 * Pure presentation helpers over an addendum's snapshotted BuildFlow delta (issue #78).
 * Kept out of addendum.tsx so the one thing that must never be gotten wrong here —
 * available:false is NOT "nothing changed" — is unit-tested without a DOM. See
 * CLAUDE.md, "What changed since the last tendered take-off" / "The tender addendum".
 */

/** A message for the two non-ordinary baseline_resolution states. 'tendered' returns
 *  null — that is the ordinary case where a real comparison exists and needs no banner. */
export function baselineResolutionMessage(resolution: AddendumDelta['baseline_resolution']): string | null {
  if (resolution === 'none') {
    return 'Nothing has ever been tendered for this package, so there is nothing to compare against yet.';
  }
  if (resolution === 'unavailable') {
    return 'The comparison was not computed for this run.';
  }
  return null;
}

/** True only when a comparison was made and it found nothing changed. Never conflate
 *  this with available === false ("never compared"). */
export function deltaIsUnchanged(delta: AddendumDelta): boolean {
  return delta.items_added === 0 && delta.items_removed === 0 && delta.items_changed === 0;
}

/** Unattributed (no work package, or one work_package_config no longer holds) sorts
 *  last — a thing for the estimator to decide, never a thing to silently drop. */
export function sortDeltaPackages<T extends { unattributed: boolean; work_package?: string | null; package_name?: string }>(
  packages: T[]
): T[] {
  return [...packages].sort((a, b) => {
    if (a.unattributed !== b.unattributed) return a.unattributed ? 1 : -1;
    const an = a.work_package ?? a.package_name ?? '';
    const bn = b.work_package ?? b.package_name ?? '';
    return an.localeCompare(bn);
  });
}

function formatDeltaQuantity(value: number | null): string {
  return value === null ? 'unmeasured' : String(Math.round(value * 100) / 100);
}

/** One line per changed pair, covering the three shapes
 *  agents/takeoff_diff/tools/pair.py (BuildFlow) can emit. now_measured /
 *  no_longer_measured are named rather than scored as a quantity change, because
 *  neither is a percentage of anything — an unmeasured line is not a line measured
 *  as zero. */
export function describeDeltaChange(change: AddendumDeltaChange): string {
  if (change.kind === 'now_measured') return `now measured — ${formatDeltaQuantity(change.after_quantity)}`;
  if (change.kind === 'no_longer_measured') return `no longer measured — was ${formatDeltaQuantity(change.before_quantity)}`;
  if (change.kind === 'unit') return `unit changed: ${change.before ?? '—'} → ${change.after ?? '—'}`;
  // change.delta is a FRACTION (0.173 = +17.3%), and null when the baseline was 0.
  const pct = change.delta === null ? '' : ` (${change.delta >= 0 ? '+' : ''}${Math.round(change.delta * 1000) / 10}%)`;
  return `${formatDeltaQuantity(change.before_quantity)} → ${formatDeltaQuantity(change.after_quantity)}${pct}`;
}

/** A delta whose pairings are mostly 'wording' is a delta that is guessing — flagged at
 *  >50% rather than "any wording at all", since the last rung firing occasionally is
 *  expected, not a defect. */
export function deltaIsWordingDominated(rungMix: Record<string, number>): boolean {
  const total = Object.values(rungMix).reduce((sum, n) => sum + n, 0);
  if (total === 0) return false;
  return (rungMix.wording ?? 0) / total > 0.5;
}

/** The approve payload MUST carry every package row, ticked or not — an omitted row
 *  keeps its current server-side value rather than being un-ticked (tenderPrepDb.ts's
 *  approveAddendum), so a partial payload silently under-approves. This is the single
 *  function that builds that payload, so the "send every row" rule lives in one place
 *  and is asserted by a test rather than left to be remembered at every call site. */
export function buildApprovePayload(
  packages: AddendumPackageRow[],
  edits: Record<string, { included: boolean; revisedReturnDeadline: string }>
): Array<{ packageName: string; included: boolean; revisedReturnDeadline: string | null }> {
  return packages.map((pkg) => {
    const edit = edits[pkg.package_name];
    const included = edit?.included ?? pkg.included;
    const revisedReturnDeadline = included ? (edit?.revisedReturnDeadline || null) : null;
    return { packageName: pkg.package_name, included, revisedReturnDeadline };
  });
}
