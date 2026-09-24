/**
 * The mechanism that keeps issue #37's approval gate honest in TPS.
 *
 * `routeAccess.ts` is a map from route template to `read | ordinary | approval`, and a
 * map is only as good as its completeness: the failure that matters is somebody adding a
 * route and not classifying it, which grants access silently and in the wrong direction.
 * So this walks the BUILT Fastify instance's own route table — collected by an `onRoute`
 * hook inside the authenticated plugin, which is also what excludes the portal, the
 * client-reply page, `/internal/*` and `/scheduled/*` — and fails on anything the map
 * does not carry.
 *
 * No database: routes are collected at registration, before any handler runs.
 *
 *   pnpm --filter @tps/bff exec vitest run tests/unit/routeAccess.test.ts
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import {
  ROUTE_ACCESS, accessFor, orphanedRouteEntries, resolvableTenderParams, unclassifiedRoutes
} from '../../src/routeAccess.js';

// Enough of a Config to register every route. Nothing here connects: `createApp` builds
// a pool lazily and no handler runs.
const config = {
  NODE_ENV: 'test', PORT: 3200, HOST: '0.0.0.0',
  DATABASE_URL: 'postgres://stub', DATABASE_SCHEMA: 'tps', SCMS_SCHEMA: 'scms',
  WEB_ORIGIN: 'http://localhost:5175', OIDC_ORGANIZATION_CLAIM: 'organization_id',
  AUTH_DISABLED: true, TOKEN_ENCRYPTION_KEY: 'stub-key-stub-key-stub-key-stub',
  PORTAL_ACCESS_REQUIRED: false, PORTAL_LINK_TTL_DAYS: 90,
  LOG_LEVEL: 'silent'
} as unknown as Config;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function registeredApiRoutes(): Promise<string[]> {
  app = await createApp(config);
  await app.ready();
  return [...new Set(app.authenticatedRoutes)].sort();
}

describe('the route access map', () => {
  it('classifies every authenticated API route', async () => {
    const routes = await registeredApiRoutes();
    expect(routes.length).toBeGreaterThan(40);
    const unclassified = unclassifiedRoutes(routes);
    expect(unclassified, `Unclassified routes — add them to routeAccess.ts:\n  ${unclassified.join('\n  ')}`).toEqual([]);
  });

  it('carries no entry for a route that no longer exists', async () => {
    const orphans = orphanedRouteEntries(await registeredApiRoutes());
    expect(orphans, `ROUTE_ACCESS names routes that do not exist:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });

  it('refuses an unknown route rather than waving it through', () => {
    expect(accessFor('POST', '/api/something-nobody-classified')).toBe('approval');
    expect(accessFor('POST', undefined)).toBe('approval');
  });

  it('gates every act that reaches a subcontractor or the employer', () => {
    // This is the list issue #37 is actually about. TPS is where a tender stops being an
    // internal document, and before this file an L2 could do every one of these.
    for (const key of [
      'POST /api/tender-prep/:workflowId/itts/:packageName/draft/send',
      'POST /api/tender-prep/:workflowId/itts/:packageName/confirm',
      'POST /api/tender-prep/:workflowId/itts/send-all',
      'POST /api/tender-prep/addenda/:addendumId/approve',
      'POST /api/tender-prep/addenda/:addendumId/issue',
      'POST /api/tender-prep/:workflowId/rfi/questions/:questionId/approve',
      'POST /api/tender-prep/:workflowId/rfi/questions/:questionId/ask-client',
      'POST /api/tender-prep/:workflowId/rfi/client-forward',
      'POST /api/tender-prep/:workflowId/threads/forward',
      'POST /api/comms/messages/:messageId/relay',
      'POST /api/tender-prep/:workflowId/submission/approve'
    ]) {
      expect(ROUTE_ACCESS[key], key).toBe('approval');
    }
  });

  it('leaves preparing the tender to an L2', () => {
    // The other half. Working through the wizard, drafting an RFI answer, overriding a
    // bill line and raising an addendum off a computed delta are the job, not sign-offs.
    for (const key of [
      'POST /api/tender-prep/:workflowId/advance',
      'POST /api/tender-prep/:workflowId/step',
      'POST /api/tender-prep/:workflowId/packages/selection',
      'PUT /api/tender-prep/:workflowId/itts/:packageName/line-overrides',
      'POST /api/tender-prep/:workflowId/rfi/responses',
      'POST /api/tender-prep/:workflowId/addenda',
      'POST /api/tender-prep/itt/:dispatchId/reminder'
    ]) {
      expect(ROUTE_ACCESS[key], key).toBe('ordinary');
    }
  });

  it('can reach a tender from every parameter a gated route carries', async () => {
    // The scope gate resolves at most one parameter per request, so a route whose only
    // identifying parameter is unresolvable is a route with no tender check at all. This
    // catches that directly rather than leaving it to be noticed in production.
    const routes = await registeredApiRoutes();
    const resolvable = new Set(resolvableTenderParams());
    const unscoped = routes.filter((key) => {
      if (ROUTE_ACCESS[key] !== 'approval') return false;
      const params = [...key.matchAll(/:(\w+)/g)].map((match) => match[1]);
      // Organisation-wide configuration has no tender and is not meant to have one.
      if (key.includes('/config/')) return false;
      return params.length > 0 && !params.some((param) => resolvable.has(param));
    });
    expect(unscoped, `Approval routes whose tender cannot be resolved:\n  ${unscoped.join('\n  ')}`).toEqual([]);
  });
});
