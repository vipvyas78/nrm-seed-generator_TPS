/**
 * Stores an RFI attachment in BuildFlow's object store and gets a durable link back
 * (BuildFlow migration `088`; contract: BUILDFLOW_COMMS_ATTACHMENTS_API.md).
 *
 * TPS holds the message store but no object storage and no S3 client, deliberately: the
 * primitive that serves a file to someone who is not a BuildFlow user — a DB-backed token
 * plus an unauthenticated redirect — lives where the bucket is, and a second S3 client in
 * this process would be a second chance to get SigV4's host-signing subtlety wrong. The
 * fifth BuildFlow client, gated on the same base URL and token as the other four.
 *
 * UNLIKE THE OTHER FOUR, THIS ONE THROWS. They are best-effort because an ITT is more
 * useful without document links than not sent at all. An attachment is the opposite: if
 * the bytes did not land, recording the message anyway would leave a row pointing at an
 * object key that holds nothing, and months later nobody could tell whether the file was
 * lost or never sent. The caller must fail the whole message instead.
 */

export interface StoredCommsAttachment {
  objectKey: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  token: string;
  url: string;
  expiresAt: string;
}

export class CommsAttachmentUploadError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'CommsAttachmentUploadError';
  }
}

export class BuildflowCommsAttachmentsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  /**
   * `attachmentId` is minted by US (it becomes comms.attachments.id) and is what the
   * object key is built from — never the filename, which on an inbound email is chosen by
   * whoever sent it.
   *
   * No content type is sent, and there is no parameter for one. BuildFlow derives it from
   * the filename alone, because a part announcing itself as application/pdf while named
   * `exploit.html` would otherwise be stored as a PDF, served inline, and sniffed back to
   * HTML by the browser. Do not add it.
   */
  async store(input: {
    organizationId: string; attachmentId: string; filename: string;
    /** Narrower than plain Uint8Array on purpose: BodyInit does not accept a view that
     *  could be backed by a SharedArrayBuffer, and widening it here would push a cast
     *  down into the fetch call. */
    content: Uint8Array<ArrayBuffer>;
  }): Promise<StoredCommsAttachment> {
    const query = new URLSearchParams({
      organizationId: input.organizationId,
      attachmentId: input.attachmentId,
      filename: input.filename
    });
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl.replace(/\/$/, '')}/internal/comms/attachments?${query}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/octet-stream' },
          body: input.content
        }
      );
    } catch (error) {
      throw new CommsAttachmentUploadError(
        `Could not reach document storage: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
    if (!response.ok) {
      throw new CommsAttachmentUploadError(
        `Document storage refused the attachment (${response.status})`, response.status
      );
    }
    return (await response.json()) as StoredCommsAttachment;
  }

  /**
   * Mint-or-reuse a link for an attachment already stored — a link lives three months and
   * a tender clarification is re-read long after that.
   *
   * Best-effort, unlike `store`: the attachment itself is not at risk, so a failure here
   * should leave the timeline rendering with that one file unlinked rather than refusing
   * to show the conversation at all.
   */
  async refreshLink(input: { objectKey: string; filename: string }): Promise<StoredCommsAttachment | null> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/internal/comms/links`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectKey: input.objectKey, filename: input.filename })
      });
      if (!response.ok) return null;
      return (await response.json()) as StoredCommsAttachment;
    } catch {
      return null;
    }
  }
}
