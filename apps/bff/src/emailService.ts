import Cloudflare from 'cloudflare';

export interface EmailAttachment {
  /** Base64-encoded file content, as Cloudflare's API requires. */
  content: string;
  filename: string;
  /** MIME type, e.g. 'application/pdf'. */
  type: string;
  disposition: 'attachment';
}

export interface SendEmailParams {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export class EmailService {
  private readonly client: Cloudflare;
  private readonly accountId: string;

  constructor(config: { cloudflareApiToken: string; cloudflareAccountId: string }) {
    this.client = new Cloudflare({ apiToken: config.cloudflareApiToken });
    this.accountId = config.cloudflareAccountId;
  }

  async send({ from, to, subject, html, text, attachments }: SendEmailParams) {
    return this.client.emailSending.send({
      account_id: this.accountId,
      from,
      to,
      subject,
      html,
      text,
      // Omitted rather than sent empty: the API treats an absent field and an empty array
      // differently in its own validation, and a message with no attachments should look
      // exactly as it did before attachments existed.
      ...(attachments && attachments.length > 0 ? { attachments } : {})
    });
  }
}
