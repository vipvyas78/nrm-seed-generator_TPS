import { z } from 'zod';

const optionalUrl = z.string().url().optional();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3200),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  // Interpolated into a connection startup string and into CREATE SCHEMA, so it is
  // constrained to a bare SQL identifier rather than accepting arbitrary text.
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'DATABASE_SCHEMA must be a bare SQL identifier').default('tps'),
  // SCMS owns this schema in the same database. TPS reads it directly (Step 4 shortlist
  // candidates) rather than calling the SCMS BFF, so the name is interpolated into SQL
  // and carries the same bare-identifier constraint as DATABASE_SCHEMA above.
  SCMS_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'SCMS_SCHEMA must be a bare SQL identifier').default('scms'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5175'),
  OIDC_ISSUER: optionalUrl,
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_JWKS_URI: optionalUrl,
  OIDC_ORGANIZATION_CLAIM: z.string().default('organization_id'),
  AUTH_DISABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  ENGINE_INTERNAL_URL: optionalUrl,
  ENGINE_INTERNAL_TOKEN: z.string().optional(),
  // Optional here on purpose: migrate.ts calls loadConfig() and migrate-tps has no Redis.
  // The worker requires it through loadWorkerConfig below.
  REDIS_URL: z.string().min(1).optional(),
  LOG_LEVEL: z.string().default('info')
});

export type Config = z.infer<typeof schema>;

/**
 * The worker's own config.
 *
 * Not a subset of loadConfig() — that one requires TOKEN_ENCRYPTION_KEY and throws
 * unless OIDC is configured or AUTH_DISABLED is set, which is itself illegal in
 * production. A headless queue consumer serves no requests and authenticates nobody, so
 * none of that applies to it. What it does need, REDIS_URL, is required here and
 * optional there.
 */
const workerSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'DATABASE_SCHEMA must be a bare SQL identifier').default('tps'),
  SCMS_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'SCMS_SCHEMA must be a bare SQL identifier').default('scms'),
  REDIS_URL: z.string().min(1),
  LOG_LEVEL: z.string().default('info')
});

export type WorkerConfig = z.infer<typeof workerSchema>;

export function loadWorkerConfig(input: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return workerSchema.parse(input);
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(input);
  if (!config.AUTH_DISABLED && (!config.OIDC_ISSUER || !config.OIDC_AUDIENCE || !config.OIDC_JWKS_URI)) {
    throw new Error('OIDC_ISSUER, OIDC_AUDIENCE, and OIDC_JWKS_URI are required when authentication is enabled');
  }
  if (config.NODE_ENV === 'production' && config.AUTH_DISABLED) {
    throw new Error('AUTH_DISABLED must not be enabled in production');
  }
  return config;
}
