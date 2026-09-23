import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BuildflowAddendumDeltaClient, proposedPackages, type AddendumDelta
} from '../../src/buildflowAddendumDeltaClient.js';

/**
 * What changed between two take-offs, read from BuildFlow to raise an addendum.
 *
 * Two things are worth pinning, and both are deliberate departures from the four sibling
 * BuildFlow clients:
 *
 *   this client THROWS where they degrade — it decides which subcontractors get re-issued,
 *   and a silent empty answer would raise an addendum covering no packages, which reads
 *   exactly like "nothing changed";
 *
 *   `available: false` is passed through rather than flattened, because it means "the
 *   comparison was never made", which is NOT "nothing changed".
 */

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn(async (input: string | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function delta(over: Partial<AddendumDelta> = {}): AddendumDelta {
  return {
    baseline_takeoff_id: 'TOQ-old',
    baseline_resolution: 'tendered',
    items_added: 1, items_removed: 0, items_changed: 2, items_unchanged: 400,
    packages: [
      { work_package: 'WP-DRYLINE', unattributed: false, added: 1, removed: 0, changed: 2 }
    ],
    delta: { changed: [], added: [], removed: [] },
    conflicts: { new: [], recurring: [], resolved: [], available: true },
    documents: { added: [], changed: [], removed: [], available: true },
    rung_mix: { clause_ref: 400, component_key: 0, classification: 3, wording: 0 },
    ...over
  };
}

describe('reading the delta', () => {
  it('carries the bearer and returns what BuildFlow said', async () => {
    stubFetch((url, init) => {
      expect(url).toContain('/internal/takeoffs/TOQ-new/addendum-delta');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      return new Response(JSON.stringify({ takeoffId: 'TOQ-new', available: true, delta: delta() }), { status: 200 });
    });

    const result = await new BuildflowAddendumDeltaClient('http://bff:3000', 'tok').deltaFor('TOQ-new');
    expect(result.available).toBe(true);
    expect(result.delta?.items_changed).toBe(2);
  });

  it('passes "never compared" through instead of flattening it to an empty delta', async () => {
    // available:false is NOT "nothing changed" — it is a take-off predating BuildFlow's
    // migration 096, or a run that stopped before its last node. Conflating the two sends
    // a revision to nobody.
    stubFetch(() => new Response(
      JSON.stringify({ takeoffId: 'TOQ-new', available: false, delta: null }), { status: 200 }
    ));
    const result = await new BuildflowAddendumDeltaClient('http://bff:3000', 'tok').deltaFor('TOQ-new');
    expect(result.available).toBe(false);
    expect(result.delta).toBeNull();
  });

  it('THROWS when BuildFlow is unreachable, unlike the best-effort siblings', async () => {
    stubFetch(() => { throw new Error('ECONNREFUSED'); });
    await expect(new BuildflowAddendumDeltaClient('http://bff:3000', 'tok').deltaFor('TOQ-new'))
      .rejects.toThrow(/could not be reached/);
  });

  it('THROWS on a refusal rather than reporting no changes', async () => {
    stubFetch(() => new Response('nope', { status: 401 }));
    await expect(new BuildflowAddendumDeltaClient('http://bff:3000', 'tok').deltaFor('TOQ-new'))
      .rejects.toThrow(/refused the take-off comparison \(401\)/);
  });

  it('trims a trailing slash off the base URL', async () => {
    const spy = stubFetch(() => new Response(
      JSON.stringify({ takeoffId: 'T', available: true, delta: delta() }), { status: 200 }
    ));
    await new BuildflowAddendumDeltaClient('http://bff:3000/', 'tok').deltaFor('T');
    expect(String(spy.mock.calls[0][0])).toContain('http://bff:3000/internal/takeoffs/');
  });
});

describe('the packages an addendum proposes', () => {
  it('proposes each package the delta says moved', () => {
    const proposed = proposedPackages(delta());
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ packageName: 'WP-DRYLINE', wpCode: 'WP-DRYLINE', changed: 2 });
  });

  it('KEEPS the unattributed bucket rather than dropping it', () => {
    // Items whose work package is NULL or retired — BuildFlow records ~560 of them.
    // Dropping them here would quietly narrow the addendum to the packages that happened
    // to resolve, and a half-issued revision reads exactly like a complete one.
    const proposed = proposedPackages(delta({
      packages: [
        { work_package: 'WP-DRYLINE', unattributed: false, added: 1, removed: 0, changed: 2 },
        { work_package: null, unattributed: true, added: 0, removed: 3, changed: 0 }
      ]
    }));
    expect(proposed).toHaveLength(2);
    const bucket = proposed.find((row) => row.unattributed);
    expect(bucket).toMatchObject({ packageName: 'Unattributed', wpCode: null, removed: 3 });
  });

  it('counts a REMOVED item as impacting its package', () => {
    // Work disappearing from a subcontractor's scope is as much a change as work appearing.
    const proposed = proposedPackages(delta({
      packages: [{ work_package: 'WP-PILE', unattributed: false, added: 0, removed: 4, changed: 0 }]
    }));
    expect(proposed[0]).toMatchObject({ packageName: 'WP-PILE', removed: 4 });
  });

  it('proposes nothing when nothing moved', () => {
    expect(proposedPackages(delta({ packages: [] }))).toEqual([]);
  });
});
