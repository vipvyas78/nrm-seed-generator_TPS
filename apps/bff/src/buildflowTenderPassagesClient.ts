/**
 * Retrieves passages from a tender's document corpus, to ground a drafted RFI
 * response (issue #41). Seventh BuildFlow client, same base URL and token family as
 * the others.
 *
 * BEST-EFFORT: `ready: false` and a fetch failure are both handled the same way by
 * the caller — the question is left undraftable this tick rather than the whole
 * batch failing, the same "one bad item does not cost the rest" doctrine
 * ittRemindersDb.ts already applies to its own per-recipient sends.
 *
 * Note this is the ONLY BuildFlow client keyed on takeoffId rather than
 * packageVersionId — see buildflowDocumentBundlesClient.ts's own header comment for
 * why: a take-off re-run mints a new takeoffId, and TPS holds that id (in
 * workflows.step_data.takeoff.takeoffId), never a packageVersionId directly.
 */

export interface TenderPassage {
  passageId: string;
  documentId: string;
  filename: string;
  docType: string | null;
  headingPath: string | null;
  pageHint: number | null;
  text: string;
  snippet: string;
  rank: number;
  shareUrl: string | null;
}

export interface TenderPassagesResult {
  ready: boolean;
  corpus: { documentCount: number; passageCount: number; builtAt: string | null };
  results: Record<string, TenderPassage[]>;
}

export class BuildflowTenderPassagesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  async search(takeoffId: string, queries: Array<{ id: string; text: string; terms: string[] }>, limit = 8): Promise<TenderPassagesResult> {
    const empty: TenderPassagesResult = { ready: false, corpus: { documentCount: 0, passageCount: 0, builtAt: null }, results: {} };
    if (queries.length === 0) return empty;
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/, '')}/internal/takeoffs/${encodeURIComponent(takeoffId)}/tender-passages`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ queries, limit })
        }
      );
      if (!response.ok) return empty;
      return (await response.json()) as TenderPassagesResult;
    } catch {
      return empty;
    }
  }
}
