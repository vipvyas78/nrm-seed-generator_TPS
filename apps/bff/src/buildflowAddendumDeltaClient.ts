/**
 * What changed between a take-off and the last one that was actually tendered.
 * BuildFlow issue #67; read here to raise a tender addendum (#68, part of #42).
 *
 * WHY TPS DOES NOT COMPUTE THIS. Both take-offs are BuildFlow's, and so are the rules that
 * pair their items — `shared/client_boq/align.py`'s clause-ref identity, its negative rule,
 * and the tolerance it already uses against a client's bill. Reimplementing them here would
 * put the comparison somewhere the data it compares is not, and the two would drift on the
 * first change to either.
 *
 * NOT best-effort, unlike the other four BuildFlow clients. Those degrade because an ITT
 * that falls back to measured lines is better than an ITT that fails to send. This one
 * decides WHICH SUBCONTRACTORS GET RE-ISSUED: a silent empty answer would raise an addendum
 * covering no packages, which reads exactly like "nothing changed" and is how a revision
 * reaches nobody. So the caller is told, and `available: false` is passed through rather
 * than flattened into an empty delta.
 *
 * `available: false` is BuildFlow's own answer for "the comparison was never made" — a
 * take-off predating migration 096, or a run interrupted before its last node. It is NOT
 * "nothing changed", and conflating the two is the one mistake that matters here.
 */

export interface AddendumDeltaPackage {
  work_package: string | null;
  /** True when these items carry no work package at all: a thing to decide, not to drop. */
  unattributed: boolean;
  added: number;
  removed: number;
  changed: number;
}

export interface AddendumDelta {
  baseline_takeoff_id: string | null;
  baseline_resolution: 'tendered' | 'none' | 'unavailable';
  items_added: number;
  items_removed: number;
  items_changed: number;
  items_unchanged: number;
  packages: AddendumDeltaPackage[];
  delta: {
    changed: Array<Record<string, unknown>>;
    added: Array<Record<string, unknown>>;
    removed: Array<Record<string, unknown>>;
  };
  conflicts: { new: unknown[]; recurring: unknown[]; resolved: unknown[]; available: boolean };
  documents: { added: unknown[]; changed: unknown[]; removed: unknown[]; available: boolean };
  /** Pairs per identity rung. A delta dominated by `wording` is one that is guessing. */
  rung_mix: Record<string, number>;
}

export interface AddendumDeltaResponse {
  takeoffId: string;
  available: boolean;
  delta: AddendumDelta | null;
}

export class BuildflowAddendumDeltaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  /** Throws when BuildFlow cannot be reached or refuses — see the module header. */
  async deltaFor(takeoffId: string): Promise<AddendumDeltaResponse> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/internal/takeoffs/${encodeURIComponent(takeoffId)}/addendum-delta`;
    let response: Response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    } catch (cause) {
      throw new Error('BuildFlow could not be reached, so what changed is not known.', { cause });
    }
    if (!response.ok) {
      throw new Error(`BuildFlow refused the take-off comparison (${response.status}).`);
    }
    return (await response.json()) as AddendumDeltaResponse;
  }
}

/**
 * The packages an addendum proposes to issue to, from BuildFlow's rollup.
 *
 * A separate pure function because it carries a decision and no I/O: the **unattributed**
 * bucket is kept, named, and proposed like any other. Those are items whose work package is
 * NULL or no longer in `work_package_config` — CLAUDE.md records ~560 of them — and
 * dropping them here would quietly narrow the addendum to the packages that happened to
 * resolve. Over-issuing is the safe direction; a half-issued revision reads exactly like a
 * complete one to the subcontractor who receives it.
 */
export function proposedPackages(delta: AddendumDelta): Array<{
  packageName: string; wpCode: string | null; unattributed: boolean;
  added: number; removed: number; changed: number;
}> {
  return delta.packages.map((row) => ({
    // A name to show and to key on. The unattributed bucket has no code, so it is named
    // for what it is rather than left blank in a list of packages.
    packageName: row.work_package ?? 'Unattributed',
    wpCode: row.work_package,
    unattributed: row.unattributed,
    added: row.added,
    removed: row.removed,
    changed: row.changed
  }));
}
