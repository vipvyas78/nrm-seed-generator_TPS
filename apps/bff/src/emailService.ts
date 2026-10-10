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
  /**
   * One address, or several on one message.
   *
   * The automated sends address one firm at a time. The in-app compose box lets a person put
   * several people on a single message deliberately, which is a different thing and their call
   * to make — so both shapes are allowed.
   */
  to: string | string[];
  cc?: string[];
  /**
   * Where a reply goes, when that should not be `from`.
   *
   * Every ITT is sent from the service address. A message a person composed and sent by hand
   * should come back to that person, not to a shared mailbox nobody is watching.
   */
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

/** Where mail goes. `cloudflare` is the real send; `mailpit` is the local stack's inbox
 *  (issue #145), so a developer reads every ITT, reminder and addendum at
 *  http://localhost:8025 and nothing reaches a real subcontractor or needs a token. */
export type EmailTransport =
  | { transport: 'cloudflare'; cloudflareApiToken: string; cloudflareAccountId: string }
  | { transport: 'mailpit'; mailpitUrl: string };

/** "Name <a@b>" or "a@b" — Mailpit's API takes the parts separately. */
export function mailbox(address: string): { Email: string; Name?: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(address);
  if (!match) return { Email: address.trim() };
  const name = match[1].replace(/^"|"$/g, '');
  return name ? { Email: match[2], Name: name } : { Email: match[2] };
}

export class EmailService {
  private readonly client?: Cloudflare;
  private readonly accountId?: string;
  private readonly mailpitUrl?: string;

  constructor(config: EmailTransport | { cloudflareApiToken: string; cloudflareAccountId: string }) {
    if ('transport' in config && config.transport === 'mailpit') {
      this.mailpitUrl = config.mailpitUrl.replace(/\/+$/, '');
      return;
    }
    const cloudflare = config as { cloudflareApiToken: string; cloudflareAccountId: string };
    this.client = new Cloudflare({ apiToken: cloudflare.cloudflareApiToken });
    this.accountId = cloudflare.cloudflareAccountId;
  }

  async send(params: SendEmailParams) {
    return this.mailpitUrl ? this.sendToMailpit(params) : this.sendWithCloudflare(params);
  }

  private async sendWithCloudflare({ from, to, cc, replyTo, subject, html, text, attachments }: SendEmailParams) {
    return this.client!.emailSending.send({
      account_id: this.accountId!,
      from,
      to,
      subject,
      html,
      text,
      // Omitted rather than sent empty: the API treats an absent field and an empty array
      // differently in its own validation, and a message with no attachments should look
      // exactly as it did before attachments existed. The same holds for cc and reply_to.
      ...(cc && cc.length > 0 ? { cc } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {})
    });
  }

  /** Mailpit's send API. Returns `message_id` like the Cloudflare result, because callers
   *  record it on the dispatch row. */
  private async sendToMailpit({ from, to, cc, replyTo, subject, html, text, attachments }: SendEmailParams) {
    const response = await fetch(`${this.mailpitUrl}/api/v1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        From: mailbox(from),
        To: (Array.isArray(to) ? to : [to]).map(mailbox),
        ...(cc && cc.length > 0 ? { Cc: cc.map(mailbox) } : {}),
        ...(replyTo ? { ReplyTo: [mailbox(replyTo)] } : {}),
        Subject: subject,
        HTML: html,
        Text: text,
        ...(attachments && attachments.length > 0
          ? { Attachments: attachments.map((a) => ({ Content: a.content, Filename: a.filename, ContentType: a.type })) }
          : {})
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Mailpit refused the message: HTTP ${response.status}`);
    const body = (await response.json()) as { ID?: string };
    return { message_id: body.ID ?? null };
  }
}

/** The configured sender, or undefined when this environment sends no email at all
 *  (the callers already record that as a failed send rather than a silent one). */
export function createEmailService(config: {
  EMAIL_TRANSPORT: 'cloudflare' | 'mailpit';
  MAILPIT_URL: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_EMAIL_TOKEN?: string;
}): EmailService | undefined {
  if (config.EMAIL_TRANSPORT === 'mailpit') return new EmailService({ transport: 'mailpit', mailpitUrl: config.MAILPIT_URL });
  return config.CLOUDFLARE_ACCOUNT_ID && config.CLOUDFLARE_EMAIL_TOKEN
    ? new EmailService({ transport: 'cloudflare', cloudflareAccountId: config.CLOUDFLARE_ACCOUNT_ID, cloudflareApiToken: config.CLOUDFLARE_EMAIL_TOKEN })
    : undefined;
}
