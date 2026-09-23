import { describe, expect, it } from 'vitest';
import type { AddendumDelta, AddendumPackageRow } from '../../src/api';
import {
  baselineResolutionMessage, buildApprovePayload, deltaIsUnchanged, deltaIsWordingDominated,
  describeDeltaChange, sortDeltaPackages,
} from '../../src/addendumDelta';

function delta(over: Partial<AddendumDelta> = {}): AddendumDelta {
  return {
    baseline_takeoff_id: 'TOQ-baseline',
    baseline_resolution: 'tendered',
    items_added: 0, items_removed: 0, items_changed: 0, items_unchanged: 0,
    packages: [],
    delta: { added: [], removed: [], changed: [] },
    conflicts: { new: [], recurring: [], resolved: [], available: true },
    documents: { added: [], changed: [], removed: [], available: true },
    rung_mix: { clause_ref: 0, component_key: 0, classification: 0, wording: 0 },
    ...over,
  };
}

function pkgRow(over: Partial<AddendumPackageRow> = {}): AddendumPackageRow {
  return {
    addendum_id: 'a1', package_name: 'WP-CONCRETE', wp_code: 'WP-CONCRETE',
    proposed: true, included: true,
    items_added: 1, items_removed: 0, items_changed: 0,
    unattributed: false, revised_return_deadline: null,
    ...over,
  };
}

describe('baselineResolutionMessage', () => {
  it('has nothing to say for the ordinary tendered case', () => {
    expect(baselineResolutionMessage('tendered')).toBeNull();
  });

  it('names the reason for none and unavailable', () => {
    expect(baselineResolutionMessage('none')).toMatch(/nothing has ever been tendered/i);
    expect(baselineResolutionMessage('unavailable')).toMatch(/not computed/i);
  });
});

describe('deltaIsUnchanged', () => {
  it('is true only when every count is zero', () => {
    expect(deltaIsUnchanged(delta())).toBe(true);
    expect(deltaIsUnchanged(delta({ items_added: 1 }))).toBe(false);
    expect(deltaIsUnchanged(delta({ items_removed: 1 }))).toBe(false);
    expect(deltaIsUnchanged(delta({ items_changed: 1 }))).toBe(false);
  });
});

describe('sortDeltaPackages', () => {
  it('sorts the unattributed bucket last, then alphabetically', () => {
    const packages = [
      pkgRow({ package_name: 'WP-DRYLINE', unattributed: false }),
      pkgRow({ package_name: 'Unattributed', wp_code: null, unattributed: true }),
      pkgRow({ package_name: 'WP-CONCRETE', unattributed: false }),
    ];
    expect(sortDeltaPackages(packages).map((p) => p.package_name)).toEqual(['WP-CONCRETE', 'WP-DRYLINE', 'Unattributed']);
  });
});

describe('describeDeltaChange', () => {
  it('names an unmeasured line as unmeasured, never as zero', () => {
    expect(describeDeltaChange({ kind: 'now_measured', before_quantity: null, after_quantity: 12.5 }))
      .toBe('now measured — 12.5');
    expect(describeDeltaChange({ kind: 'no_longer_measured', before_quantity: 30, after_quantity: null }))
      .toBe('no longer measured — was 30');
  });

  it('reports a unit change', () => {
    expect(describeDeltaChange({ kind: 'unit', before: 'm2', after: 'm', before_quantity: 5, after_quantity: 5 }))
      .toBe('unit changed: m2 → m');
  });

  it('formats a quantity change with its percentage', () => {
    expect(describeDeltaChange({ kind: 'quantity', before_quantity: 100, after_quantity: 150, delta: 0.5 }))
      .toBe('100 → 150 (+50%)');
    expect(describeDeltaChange({ kind: 'quantity', before_quantity: 100, after_quantity: 80, delta: -0.2 }))
      .toBe('100 → 80 (-20%)');
  });

  it('omits a percentage it cannot compute (baseline of zero)', () => {
    expect(describeDeltaChange({ kind: 'quantity', before_quantity: 0, after_quantity: 40, delta: null }))
      .toBe('0 → 40');
  });
});

describe('deltaIsWordingDominated', () => {
  it('flags a delta paired mostly by wording as guessing', () => {
    expect(deltaIsWordingDominated({ clause_ref: 1, component_key: 0, classification: 0, wording: 5 })).toBe(true);
  });

  it('does not flag a delta where wording is a minority rung', () => {
    expect(deltaIsWordingDominated({ clause_ref: 8, component_key: 0, classification: 0, wording: 2 })).toBe(false);
  });

  it('is false with no pairings at all', () => {
    expect(deltaIsWordingDominated({ clause_ref: 0, component_key: 0, classification: 0, wording: 0 })).toBe(false);
  });
});

describe('buildApprovePayload', () => {
  it('carries every package row, not just the edited ones', () => {
    const packages = [pkgRow({ package_name: 'WP-CONCRETE' }), pkgRow({ package_name: 'WP-DRYLINE', included: false })];
    const payload = buildApprovePayload(packages, {});
    expect(payload).toEqual([
      { packageName: 'WP-CONCRETE', included: true, revisedReturnDeadline: null },
      { packageName: 'WP-DRYLINE', included: false, revisedReturnDeadline: null },
    ]);
  });

  it('applies a local edit over the server value', () => {
    const packages = [pkgRow({ package_name: 'WP-CONCRETE', included: true })];
    const payload = buildApprovePayload(packages, {
      'WP-CONCRETE': { included: false, revisedReturnDeadline: '2026-11-01' },
    });
    // Ticked off, so the date is dropped too — an excluded package carries no revised date.
    expect(payload).toEqual([{ packageName: 'WP-CONCRETE', included: false, revisedReturnDeadline: null }]);
  });

  it('sends the revised return date only for an included package', () => {
    const packages = [pkgRow({ package_name: 'WP-CONCRETE' })];
    const payload = buildApprovePayload(packages, {
      'WP-CONCRETE': { included: true, revisedReturnDeadline: '2026-11-01' },
    });
    expect(payload).toEqual([{ packageName: 'WP-CONCRETE', included: true, revisedReturnDeadline: '2026-11-01' }]);
  });

  it('treats an empty date string as null, not as an empty-string date', () => {
    const packages = [pkgRow({ package_name: 'WP-CONCRETE' })];
    const payload = buildApprovePayload(packages, { 'WP-CONCRETE': { included: true, revisedReturnDeadline: '' } });
    expect(payload[0]!.revisedReturnDeadline).toBeNull();
  });
});
