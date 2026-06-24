import type { FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { AppError } from './errors.js';
import type { Actor } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
  }
}

function stringClaim(payload: JWTPayload, claim: string): string | undefined {
  const value = payload[claim];
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

export function buildAuthenticator(config: Config, db: Database) {
  const jwks = config.OIDC_JWKS_URI ? createRemoteJWKSet(new URL(config.OIDC_JWKS_URI)) : undefined;

  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (config.AUTH_DISABLED) {
      const subject = request.headers['x-buildflow-dev-subject'];
      const organization = request.headers['x-buildflow-dev-organization'];
      if (typeof subject !== 'string' || typeof organization !== 'string') {
        throw new AppError(401, 'Development authentication requires x-buildflow-dev-subject and x-buildflow-dev-organization', 'UNAUTHENTICATED');
      }
      request.actor = await db.provisionActor({ issuer: 'buildflow-dev', subject, organizationExternalId: organization, email: request.headers['x-buildflow-dev-email'] as string | undefined });
      return;
    }
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError(401, 'Bearer token is required', 'UNAUTHENTICATED');
    const token = header.slice('Bearer '.length);
    try {
      const { payload } = await jwtVerify(token, jwks!, { issuer: config.OIDC_ISSUER, audience: config.OIDC_AUDIENCE });
      const subject = payload.sub;
      const organization = stringClaim(payload, config.OIDC_ORGANIZATION_CLAIM);
      if (!subject || !organization) throw new AppError(401, 'Token is missing its subject or organization claim', 'INVALID_TOKEN');
      request.actor = await db.provisionActor({
        issuer: config.OIDC_ISSUER!, subject, organizationExternalId: organization,
        organizationName: stringClaim(payload, 'organization_name'),
        email: stringClaim(payload, 'email'), displayName: stringClaim(payload, 'name')
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(401, 'Token verification failed', 'INVALID_TOKEN');
    }
  };
}

export function requireActor(request: FastifyRequest): Actor {
  if (!request.actor) throw new AppError(401, 'Authentication is required', 'UNAUTHENTICATED');
  return request.actor;
}
