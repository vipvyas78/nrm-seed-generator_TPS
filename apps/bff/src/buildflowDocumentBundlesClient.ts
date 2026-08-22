/**
 * Resolves a tendered take-off to its per-work-package document bundles, via the BuildFlow
 * BFF's document-bundles contract (migration `082_takeoff_document_bundles` on their side;
 * `TPS_DOCUMENT_BUNDLES_API.md`).
 *
 * A bundle is a `.zip` scoped to ONE work package: every non-drawing document plus only the
 * drawing sheets a non-ignored take-off item in that package actually cites. It exists
 * because the flat document-links list issues a flooring subcontractor the drainage sheets
 * and every other trade's drawings along with their own.
 *
 * Every take-off also carries one bundle with `wpCode: null` — the complete set. Send both:
 * the package bundle as the primary pack, the complete set as the safety net.
 *
 * KEYED ON `takeoffId`, NOT `packageVersionId`. A take-off re-run mints a new `takeoffId`,
 * so re-running before re-tendering cannot silently swap the documents behind a link that
 * has already been emailed. Superseded and expired bundles are simply absent from the
 * response — an empty array means "nothing to send right now", never "send the old ones".
 *
 * Best-effort, exactly like `BuildflowDocumentLinksClient`: any failure returns an empty
 * list rather than throwing. An ITT is more useful without a bundle link than not sent.
 */
export interface BuildflowBundle {
  /** `null` is the complete set — everything the tender pack contains. */
  wpCode: string | null;
  wpLabel: string | null;
  documentCount: number;
  /**
   * True when this package cited no drawing sheet and was given every sheet instead. Not an
   * error — over-issuing is the safe failure, since a half-issued scope reads exactly like a
   * complete one — but worth saying out loud before telling a subcontractor "here is yours".
   */
  allSheetsFallback: boolean;
  buildError: string | null;
  url: string;
  expiresAt: string;
}

interface DocumentBundlesResponse {
  takeoffId: string;
  bundles: BuildflowBundle[];
}

export class BuildflowDocumentBundlesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  async bundlesFor(takeoffId: string): Promise<BuildflowBundle[]> {
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/, '')}/internal/takeoffs/${encodeURIComponent(takeoffId)}/document-bundles`,
        { headers: { Authorization: `Bearer ${this.token}` } }
      );
      // The contract has no 404: an unknown or superseded take-off returns an empty array,
      // because "not built yet" and "nothing to send you" are the same thing to a caller.
      // So a non-2xx here is 401 (bad token) or an outage, and neither is retried — this is
      // a single user-initiated send, not a background job.
      if (!response.ok) return [];
      const body = (await response.json()) as DocumentBundlesResponse;
      return body.bundles ?? [];
    } catch {
      return [];
    }
  }
}
