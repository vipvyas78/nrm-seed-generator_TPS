import { z } from 'zod';

const optionalUrl = z.string().url().optional();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3200),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  WEB_ORIGIN: z.string().url().default('http://localhost:5175'),
  OIDC_ISSUER: optionalUrl,
  OIDC_AUDIENCE: z.string().optional(),
  OIDC_JWKS_URI: optionalUrl,
  OIDC_ORGANIZATION_CLAIM: z.string().default('organization_id'),
  AUTH_DISABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  SCMS_BFF_URL: z.string().url().default('http://localhost:3100'),
  ENGINE_INTERNAL_URL: optionalUrl,
  ENGINE_INTERNAL_TOKEN: z.string().optional(),
  LOG_LEVEL: z.string().default('info')
});

export type Config = z.infer<typeof schema>;

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
