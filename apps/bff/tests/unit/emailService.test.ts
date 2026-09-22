import { describe, expect, it, vi } from 'vitest';
import { EmailService } from '../../src/emailService.js';

vi.mock('cloudflare', () => ({
  default: vi.fn().mockImplementation(() => ({
    emailSending: { send: vi.fn().mockResolvedValue({ message_id: 'msg-1' }) }
  }))
}));

describe('EmailService', () => {
  it('sends the given fields through client.emailSending.send with the account id', async () => {
    const service = new EmailService({ cloudflareApiToken: 'token', cloudflareAccountId: 'account-1' });
    const client = (service as unknown as { client: { emailSending: { send: ReturnType<typeof vi.fn> } } }).client;

    await service.send({
      from: 'welcome@novamerx.ai',
      to: 'someone@example.com',
      subject: 'Welcome to our service!',
      html: '<h1>Welcome!</h1>',
      text: 'Welcome!'
    });

    expect(client.emailSending.send).toHaveBeenCalledWith({
      account_id: 'account-1',
      from: 'welcome@novamerx.ai',
      to: 'someone@example.com',
      subject: 'Welcome to our service!',
      html: '<h1>Welcome!</h1>',
      text: 'Welcome!'
    });
  });

  it('passes attachments through when there are any', async () => {
    const service = new EmailService({ cloudflareApiToken: 'token', cloudflareAccountId: 'account-1' });
    const client = (service as unknown as { client: { emailSending: { send: ReturnType<typeof vi.fn> } } }).client;
    const attachments = [{
      content: 'YmFzZTY0', filename: 'Bill of Quantities - Flooring.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: 'attachment' as const
    }];

    await service.send({
      from: 'tenders@novamerx.ai', to: 'someone@example.com', subject: 'ITT',
      html: '<p>ITT</p>', text: 'ITT', attachments
    });

    expect(client.emailSending.send).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
  });

  it('carries several recipients, a cc list and a reply-to on one message', async () => {
    // What the in-app compose box sends: the person chose to put these people on one email.
    const service = new EmailService({ cloudflareApiToken: 'token', cloudflareAccountId: 'account-1' });
    const client = (service as unknown as { client: { emailSending: { send: ReturnType<typeof vi.fn> } } }).client;

    await service.send({
      from: 'tenders@novamerx.ai',
      to: ['a@example.com', 'b@example.com'],
      cc: ['qs@novamerx.ai'],
      replyTo: 'jo@novamerx.ai',
      subject: 'ITT', html: '<p>ITT</p>', text: 'ITT'
    });

    expect(client.emailSending.send).toHaveBeenCalledWith(expect.objectContaining({
      to: ['a@example.com', 'b@example.com'],
      cc: ['qs@novamerx.ai'],
      reply_to: 'jo@novamerx.ai'
    }));
  });

  it('omits cc and reply_to rather than sending them empty', async () => {
    const service = new EmailService({ cloudflareApiToken: 'token', cloudflareAccountId: 'account-1' });
    const client = (service as unknown as { client: { emailSending: { send: ReturnType<typeof vi.fn> } } }).client;

    await service.send({
      from: 'tenders@novamerx.ai', to: 'a@example.com', cc: [], replyTo: undefined,
      subject: 'ITT', html: '<p>ITT</p>', text: 'ITT'
    });

    const sent = client.emailSending.send.mock.calls[0][0];
    expect(sent).not.toHaveProperty('cc');
    expect(sent).not.toHaveProperty('reply_to');
  });

  it('omits the attachments field entirely when the list is empty', async () => {
    const service = new EmailService({ cloudflareApiToken: 'token', cloudflareAccountId: 'account-1' });
    const client = (service as unknown as { client: { emailSending: { send: ReturnType<typeof vi.fn> } } }).client;

    await service.send({
      from: 'tenders@novamerx.ai', to: 'someone@example.com', subject: 'ITT',
      html: '<p>ITT</p>', text: 'ITT', attachments: []
    });

    expect(client.emailSending.send.mock.calls[0][0]).not.toHaveProperty('attachments');
  });
});
