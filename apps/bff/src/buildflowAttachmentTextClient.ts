/**
 * Reads the TEXT of an .xlsx/.docx RFI attachment TPS has already stored in BuildFlow
 * (issue #41). Sixth BuildFlow client, same base URL and token as the other five.
 *
 * BEST-EFFORT, unlike `BuildflowCommsAttachmentsClient.store` — the same reasoning
 * that class's own header gives for why storing must throw does not apply here in
 * reverse: the bytes are already safely stored regardless of whether this call
 * succeeds, so a failure to READ them back is a degraded RFI (one attachment stays
 * unread, flagged, and an estimator opens it by hand) rather than a lost one.
 */

export interface AttachmentTextResult {
  status: 'extracted' | 'unsupported_pdf' | 'unsupported_type' | 'too_large' | 'empty' | 'failed';
  extractor: string | null;
  text: string | null;
  charCount: number | null;
  truncated: boolean;
  error: string | null;
}

export class BuildflowAttachmentTextClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  async extract(input: { organizationId: string; attachmentId: string; objectKey: string; filename: string }): Promise<AttachmentTextResult> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/internal/comms/attachments/text`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      });
      if (!response.ok) {
        return {
          status: 'failed', extractor: null, text: null, charCount: null, truncated: false,
          error: `BuildFlow refused the extraction (${response.status})`
        };
      }
      // .pdf is a real extension, not an error case, so a 200 with status
      // 'unsupported_pdf' etc. is passed through verbatim — the caller decides what
      // that means for the question extractor and the review page.
      return (await response.json()) as AttachmentTextResult;
    } catch (error) {
      return {
        status: 'failed', extractor: null, text: null, charCount: null, truncated: false,
        error: `Could not reach BuildFlow: ${error instanceof Error ? error.message : 'unknown error'}`
      };
    }
  }
}
