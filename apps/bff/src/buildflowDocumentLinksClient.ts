/**
 * Resolves a take-off package version's source documents to long-lived, email-safe links,
 * via the BuildFlow BFF's own document-links contract (migration `072_document_share_links`
 * on their side; TPS integration contract v1).
 *
 * BuildFlow issues its own stable opaque redirect URL rather than a raw S3 presigned URL —
 * SigV4 presigned URLs cannot exceed 7 days, and an emailed link needs to stay clickable for
 * 3 months. The `url` returned here is meant to be embedded in an email as-is: never
 * constructed, decoded or extended, and never re-derived from a presigned URL of our own.
 *
 * Best-effort, same shape as `DropboxDocumentLinkProvider`: any failure — a bad/expired
 * token, an import that hasn't settled yet (`404 NO_COMPLETED_IMPORT`), or BuildFlow being
 * unreachable — returns an empty list rather than throwing. An ITT email is more useful
 * without document links than not sent at all.
 */
export interface BuildflowDocumentLink {
  fileId: string;
  displayName: string;
  contentType: string | null;
  url: string;
  expiresAt: string;
}

interface DocumentLinksResponse {
  packageVersionId: string;
  documents: BuildflowDocumentLink[];
}

export class BuildflowDocumentLinksClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  async linksFor(packageVersionId: string): Promise<BuildflowDocumentLink[]> {
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/, '')}/internal/package-versions/${packageVersionId}/document-links`,
        { headers: { Authorization: `Bearer ${this.token}` } }
      );
      // 401/422 are permanent (bad token, bad id); 404 NO_COMPLETED_IMPORT and 500 are the
      // contract's documented retryable cases. Neither is retried here — this is a single,
      // user-initiated send, not a background job — so both simply mean "no links this time".
      if (!response.ok) return [];
      const body = (await response.json()) as DocumentLinksResponse;
      return body.documents;
    } catch {
      return [];
    }
  }
}
