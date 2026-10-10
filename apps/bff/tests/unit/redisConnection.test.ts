/**
 * redisConnection — REDIS_URL to BullMQ options (issue #145).
 */
import { describe, expect, it } from 'vitest';
import { redisConnection } from '../../src/queues.js';

describe('redisConnection', () => {
  it('keeps the local plaintext URL plaintext', () => {
    const connection = redisConnection({ REDIS_URL: 'redis://redis:6379' });
    expect(connection).toMatchObject({ host: 'redis', port: 6379, maxRetriesPerRequest: null });
    expect('tls' in connection).toBe(false);
  });

  it('turns on TLS for rediss://, which Upstash requires', () => {
    expect(redisConnection({ REDIS_URL: 'rediss://default:p%40ss@eu1-x.upstash.io:6379' })).toMatchObject({
      host: 'eu1-x.upstash.io', username: 'default', password: 'p@ss', tls: { servername: 'eu1-x.upstash.io' }
    });
  });
});
