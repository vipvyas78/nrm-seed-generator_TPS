import { describe, expect, it, vi } from 'vitest';
import { EmailService, createEmailService } from '../../src/emailService.js';

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

describe('EmailService — Mailpit transport (issue #145, local stack)', () => {
  it('posts the message to Mailpit and returns its id as message_id, as callers expect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ID: 'mp-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const service = new EmailService({ transport: 'mailpit', mailpitUrl: 'http://mailpit:8025/' });
      const result = await service.send({
        from: 'Tenders <tenders@novamerx.ai>', to: ['a@example.com'], cc: ['qs@novamerx.ai'], replyTo: 'jo@novamerx.ai',
        subject: 'ITT', html: '<p>ITT</p>', text: 'ITT',
        attachments: [{ content: 'YmFzZTY0', filename: 'boq.xlsx', type: 'application/octet-stream', disposition: 'attachment' }]
      });
      expect(result).toEqual({ message_id: 'mp-1' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://mailpit:8025/api/v1/send');
      expect(JSON.parse(init.body)).toEqual({
        From: { Email: 'tenders@novamerx.ai', Name: 'Tenders' },
        To: [{ Email: 'a@example.com' }],
        Cc: [{ Email: 'qs@novamerx.ai' }],
        ReplyTo: [{ Email: 'jo@novamerx.ai' }],
        Subject: 'ITT', HTML: '<p>ITT</p>', Text: 'ITT',
        Attachments: [{ Content: 'YmFzZTY0', Filename: 'boq.xlsx', ContentType: 'application/octet-stream' }]
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails the send when Mailpit refuses it, so the dispatch row records a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 500 })));
    try {
      const service = new EmailService({ transport: 'mailpit', mailpitUrl: 'http://mailpit:8025' });
      await expect(service.send({ from: 'a@b.c', to: 'd@e.f', subject: 's', html: 'h', text: 't' }))
        .rejects.toThrow('Mailpit refused the message: HTTP 500');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('createEmailService', () => {
  it('builds no sender without Cloudflare credentials, as before', () => {
    expect(createEmailService({ EMAIL_TRANSPORT: 'cloudflare', MAILPIT_URL: 'http://mailpit:8025' })).toBeUndefined();
  });

  it('builds a Mailpit sender with no credentials at all', () => {
    expect(createEmailService({ EMAIL_TRANSPORT: 'mailpit', MAILPIT_URL: 'http://mailpit:8025' })).toBeInstanceOf(EmailService);
  });
});
