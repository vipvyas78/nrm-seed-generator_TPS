import Cloudflare from 'cloudflare';

export interface SendEmailParams {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export class EmailService {
  private readonly client: Cloudflare;
  private readonly accountId: string;

  constructor(config: { cloudflareApiToken: string; cloudflareAccountId: string }) {
    this.client = new Cloudflare({ apiToken: config.cloudflareApiToken });
    this.accountId = config.cloudflareAccountId;
  }

  async send({ from, to, subject, html, text }: SendEmailParams) {
    return this.client.emailSending.send({
      account_id: this.accountId,
      from,
      to,
      subject,
      html,
      text
    });
  }
}
