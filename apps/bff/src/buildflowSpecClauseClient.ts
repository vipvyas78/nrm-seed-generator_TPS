/**
 * Resolves spec-clause chunk ids (carried on `boq_items`/`takeoff_items.spec_chunk_ids`) to
 * display text, via a BuildFlow BFF endpoint mirroring the document-links contract: TPS
 * holds the ids, BuildFlow owns `nrm_chunks` and resolves them.
 *
 * Best-effort, same shape as `BuildflowDocumentLinksClient`: any failure — bad/expired
 * token, unreachable BuildFlow, an id nobody recognises — returns an empty list rather than
 * throwing. An ITT email is more useful without a spec clauses section than not sent at all.
 */
export interface BuildflowSpecClause {
  chunkId: string;
  geCode: string | null;
  elementCode: string | null;
  subElementCode: string | null;
  subsectionTitle: string | null;
  rawText: string;
  nbsCode: string | null;
}

interface SpecClausesResponse {
  clauses: BuildflowSpecClause[];
}

export class BuildflowSpecClauseClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  async clausesFor(chunkIds: string[]): Promise<BuildflowSpecClause[]> {
    if (chunkIds.length === 0) return [];
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/, '')}/internal/spec-clauses`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ chunkIds })
        }
      );
      if (!response.ok) return [];
      const body = (await response.json()) as SpecClausesResponse;
      return body.clauses;
    } catch {
      return [];
    }
  }
}
