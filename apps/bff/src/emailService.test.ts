import { describe, expect, it, vi } from 'vitest';
import { EmailService } from './emailService.js';

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
