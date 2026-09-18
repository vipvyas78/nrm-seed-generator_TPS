/**
 * The MEP bill BuildFlow generates from its own configured template, for a WP-MEP-*
 * package's ITT. BuildFlow issue #28.
 *
 * WHY TPS DOES NOT BUILD THIS ITSELF. The bill is the client's MEP house sequence —
 * 9 main sections, 45 sub, 79 sub-sub — held in BuildFlow's `mep_boq_template_rows` and
 * edited by a reviewer in Configuration → Tenders. Which of its sections a project
 * carries is decided by the NRM1 codes that project's take-off measured, which is also
 * BuildFlow's. Reimplementing either here would put the rule somewhere the configuration
 * it reads is not, and the two would drift on the first template edit.
 *
 * WHAT IT REPLACES, AND WHEN. Today a WP-MEP-* package's bill comes off
 * `takeoffLinesForWorkPackage` — the pipeline's own measured rows, whose descriptions
 * are whatever the drawing reader produced. That is right when nothing better exists and
 * wrong when the client has stated their own bill. So this is asked FIRST and the old
 * path is the fallback, for all three of the ways this can decline to answer:
 *
 *   `source: 'client_boq'`  the pack ships the client's own priced bill, which is
 *                           authoritative for MEP — keep reading the take-off.
 *   `null`                  unreachable, unauthorised, or no such take-off.
 *   not configured          BUILDFLOW_BASE_URL / _TOKEN absent, as in a local dev run.
 *
 * Best-effort in exactly the shape BuildflowSpecClauseClient and
 * BuildflowDocumentBundlesClient already use: never throws, and an ITT that falls back
 * to measured lines is far better than an ITT that fails to send.
 */
export interface BuildflowMepBoqLine {
  ref: string;
  depth: number;
  rowKind: 'main' | 'sub' | 'subsub' | 'item' | 'note';
  description: string;
  unit: string | null;
  /** Always null: the tenderer measures and prices. See the BuildFlow module header. */
  quantity: null;
  isPriceable: boolean;
  verdict: 'measured' | 'all_mep' | 'unknown_code' | 'ancestor' | 'not_measured';
  nrm1Code: string | null;
  matchedBy: string | null;
}

export interface BuildflowMepBoqPackage {
  wpCode: string;
  wpLabel: string | null;
  lines: BuildflowMepBoqLine[];
}

export interface BuildflowMepBoq {
  takeoffId: string;
  sessionId: string;
  source: 'template' | 'client_boq';
  packages: BuildflowMepBoqPackage[];
  diagnostics: {
    templateRows: number;
    candidateRows: number;
    billedRows: number;
    evidenceCodes: string[];
    byVerdict: Record<string, number>;
    droppedRefs: string[];
  };
}

export class BuildflowMepBoqClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  async billFor(takeoffId: string): Promise<BuildflowMepBoq | null> {
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/, '')}/internal/takeoffs/${encodeURIComponent(takeoffId)}/mep-boq`,
        { headers: { Authorization: `Bearer ${this.token}` } }
      );
      if (!response.ok) return null;
      return (await response.json()) as BuildflowMepBoq;
    } catch {
      return null;
    }
  }
}

/**
 * One package's template lines in the shape the rest of the ITT already speaks —
 * the same columns takeoffLinesForWorkPackage returns, so nothing downstream has to
 * know where a bill came from.
 *
 * Separated from the client so it can be read and tested as what it is: a translation
 * between two shapes, with three decisions in it and no I/O.
 */
export function templateLinesAsBoqRows(
  lines: BuildflowMepBoqLine[]
): Record<string, unknown>[] {
  return lines.map((line, index) => ({
    // Not a database id. It only has to be stable and unique within this pack, because
    // "Ignore for ITT" addresses a line by it — and a bill ref is exactly that.
    id: `mep-template:${line.ref}`,
    // The whole MEP template sits under NRM1 group element 5, Services.
    ge_code: 'GE5',
    // The bill's own ref, which is what a tenderer quotes back at you: '1.2.1', not a
    // take-off element code. The column is headed "Element" and reads correctly either way.
    element_code: line.ref,
    description: line.description,
    unit: line.unit,
    quantity: null,
    is_priceable: line.isPriceable,
    sort_order: index,
    attributed_by: 'mep_template',
    spec_chunk_ids: [],
    spec_source_files: []
  }));
}
