/**
 * loadConfig / loadWorkerConfig guard rails added for the cloud deployment (issue #145).
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, loadWorkerConfig } from '../../src/config.js';

const REQUIRED = { DATABASE_URL: 'postgres://stub', TOKEN_ENCRYPTION_KEY: 'stub-key-stub-key-stub-key-stub' };

describe('loadConfig', () => {
  it('boots with authentication on and no OIDC — BuildFlow local sessions need none', () => {
    const config = loadConfig({ ...REQUIRED, NODE_ENV: 'production', AUTH_DISABLED: 'false' });
    expect(config.OIDC_ISSUER).toBeUndefined();
  });

  it('refuses a half-configured OIDC', () => {
    expect(() => loadConfig({ ...REQUIRED, AUTH_DISABLED: 'false', OIDC_AUDIENCE: 'aud' }))
      .toThrow('must be set together or not at all');
  });

  it('refuses the committed compose dev defaults in production', () => {
    expect(() => loadConfig({
      ...REQUIRED, NODE_ENV: 'production', AUTH_DISABLED: 'false',
      TOKEN_ENCRYPTION_KEY: 'tps-dev-token-key-32-chars-min'
    })).toThrow('TOKEN_ENCRYPTION_KEY must not use the committed development default in production');
  });

  it('defaults to Cloudflare email and refuses the Mailpit inbox in production', () => {
    expect(loadConfig({ ...REQUIRED, AUTH_DISABLED: 'true' }).EMAIL_TRANSPORT).toBe('cloudflare');
    expect(() => loadConfig({ ...REQUIRED, NODE_ENV: 'production', AUTH_DISABLED: 'false', EMAIL_TRANSPORT: 'mailpit' }))
      .toThrow('must not be used in production');
  });
});

describe('loadWorkerConfig', () => {
  it('keeps BullMQ\'s own drain delay unless told otherwise, and serves no port by default', () => {
    const config = loadWorkerConfig({ DATABASE_URL: 'postgres://stub', REDIS_URL: 'redis://redis:6379' });
    expect(config.BULLMQ_DRAIN_DELAY_SECONDS).toBe(5);
    expect(config.WORKER_HTTP_PORT).toBeUndefined();
  });
});
