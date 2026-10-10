/**
 * TPS at the edge (nrm-seed-generator#145): one Worker per environment, reached only
 * through BuildFlow's Worker over a service binding — so TPS stays on BuildFlow's origin,
 * which is what lets one sign-in cover both apps (issue #37). It has no route and no
 * workers.dev URL of its own.
 *
 *   /tps, /tps/*            the TPS SPA (built with base '/tps/'), served from static assets
 *   /tps-api/_wake/worker   start the queue worker (bearer WORKER_WAKE_TOKEN)
 *   /tps-api/*              bff-tps, with the /tps-api prefix stripped — exactly what
 *                           nginx-web.conf's `proxy_pass http://bff-tps:3200/` did
 *
 * bff-tps sleeps after 30 idle minutes. worker-tps is woken by BuildFlow after it hands
 * TPS a job, and asked GET /internal/busy before it is stopped.
 */
import { Container, getContainer } from '@cloudflare/containers';

export interface Env {
  ASSETS: Fetcher;
  BFF_TPS: DurableObjectNamespace<BffTps>;
  WORKER_TPS: DurableObjectNamespace<WorkerTps>;

  // ── vars ──
  ENVIRONMENT: string;
  PUBLIC_ORIGIN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  TEST_EMAIL_FLAG: string;
  TEST_FROM_EMAIL_ACCOUNT?: string;
  TEST_TO_EMAIL_ACCOUNT?: string;
  CF_ACCESS_TEAM_NAME?: string;
  BULLMQ_DRAIN_DELAY_SECONDS: string;

  // ── secrets ──
  DATABASE_URL: string;
  REDIS_URL: string;
  TOKEN_ENCRYPTION_KEY: string;
  BUILDFLOW_DOCUMENT_LINKS_TOKEN: string;
  BUILDFLOW_NOTIFICATIONS_TOKEN: string;
  WORKER_WAKE_TOKEN: string;
  INBOUND_EMAIL_TOKEN?: string;
  INBOUND_EMAIL_SIGNING_SECRET?: string;
  SCHEDULED_TASKS_TOKEN?: string;
  SCHEDULED_TASKS_SIGNING_SECRET?: string;
  CLOUDFLARE_EMAIL_TOKEN?: string;
  CLOUDFLARE_ACCESS_TOKEN?: string;
}

function defined(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

async function busy(container: Container<Env>): Promise<boolean> {
  try {
    const response = await container.containerFetch('http://container/internal/busy');
    if (!response.ok) return true;
    const body = (await response.json()) as { busy?: unknown };
    return body.busy !== false;
  } catch {
    return true;
  }
}

export class BffTps extends Container<Env> {
  defaultPort = 3200;
  sleepAfter = '30m';
  entrypoint = ['node', '/app/apps/bff/dist/server.js'];

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    const origin = env.PUBLIC_ORIGIN;
    this.envVars = defined({
      NODE_ENV: 'production',
      PORT: '3200',
      DATABASE_URL: env.DATABASE_URL,
      DATABASE_SCHEMA: 'tps',
      SCMS_SCHEMA: 'scms',
      REDIS_URL: env.REDIS_URL,
      WEB_ORIGIN: origin,
      AUTH_DISABLED: 'false',
      TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
      EMAIL_TRANSPORT: 'cloudflare',
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_EMAIL_TOKEN: env.CLOUDFLARE_EMAIL_TOKEN,
      // TPS's own name for the Zero Trust token that manages the portal's Access apps.
      CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_ACCESS_TOKEN,
      CF_ACCESS_TEAM_NAME: env.CF_ACCESS_TEAM_NAME,
      PORTAL_BASE_URL: `${origin}/tps`,
      TEST_EMAIL_FLAG: env.TEST_EMAIL_FLAG,
      TEST_FROM_EMAIL_ACCOUNT: env.TEST_FROM_EMAIL_ACCOUNT,
      TEST_TO_EMAIL_ACCOUNT: env.TEST_TO_EMAIL_ACCOUNT,
      BUILDFLOW_BASE_URL: origin,
      BUILDFLOW_DOCUMENT_LINKS_TOKEN: env.BUILDFLOW_DOCUMENT_LINKS_TOKEN,
      BUILDFLOW_NOTIFICATIONS_TOKEN: env.BUILDFLOW_NOTIFICATIONS_TOKEN,
      INBOUND_EMAIL_TOKEN: env.INBOUND_EMAIL_TOKEN,
      INBOUND_EMAIL_SIGNING_SECRET: env.INBOUND_EMAIL_SIGNING_SECRET,
      SCHEDULED_TASKS_TOKEN: env.SCHEDULED_TASKS_TOKEN,
      SCHEDULED_TASKS_SIGNING_SECRET: env.SCHEDULED_TASKS_SIGNING_SECRET,
      LOG_LEVEL: 'info'
    });
  }
}

export class WorkerTps extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';
  entrypoint = ['node', '/app/apps/bff/dist/worker.js'];

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = defined({
      DATABASE_URL: env.DATABASE_URL,
      DATABASE_SCHEMA: 'tps',
      SCMS_SCHEMA: 'scms',
      REDIS_URL: env.REDIS_URL,
      BULLMQ_DRAIN_DELAY_SECONDS: env.BULLMQ_DRAIN_DELAY_SECONDS,
      WORKER_HTTP_PORT: '8080',
      LOG_LEVEL: 'info'
    });
  }

  override async onActivityExpired(): Promise<void> {
    if (await busy(this)) {
      this.renewActivityTimeout();
      return;
    }
    await this.stop();
  }
}

export function routeFor(pathname: string): 'assets' | 'api' | 'wake' | 'none' {
  if (pathname === '/tps-api/_wake/worker') return 'wake';
  if (pathname.startsWith('/tps-api/')) return 'api';
  if (pathname === '/tps' || pathname.startsWith('/tps/')) return 'assets';
  return 'none';
}

function bearerMatches(header: string | null, expected: string | undefined): boolean {
  if (!expected || !header) return false;
  const a = new TextEncoder().encode(header);
  const b = new TextEncoder().encode(`Bearer ${expected}`);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The SPA was built with base '/tps/' and its files live at the asset root, so the prefix
 *  comes off before lookup. Cache rules as nginx-web.conf had them. */
async function serveAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const stripped = url.pathname.slice('/tps'.length) || '/';
  const response = await env.ASSETS.fetch(new Request(new URL(stripped + url.search, url.origin), request));
  const headers = new Headers(response.headers);
  if (stripped.startsWith('/assets/')) {
    headers.set('cache-control', 'public, max-age=31536000, immutable');
  } else if ((headers.get('content-type') ?? '').includes('text/html')) {
    headers.set('cache-control', 'no-store, must-revalidate');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    switch (routeFor(url.pathname)) {
      case 'wake':
        if (request.method !== 'POST' || !bearerMatches(request.headers.get('authorization'), env.WORKER_WAKE_TOKEN)) {
          return new Response('Unauthorized', { status: 401 });
        }
        await getContainer(env.WORKER_TPS).fetch(new Request('http://container/health'));
        return new Response(null, { status: 202 });
      case 'api': {
        const target = new URL(request.url);
        target.pathname = url.pathname.slice('/tps-api'.length);
        return getContainer(env.BFF_TPS).fetch(new Request(target, request));
      }
      case 'assets':
        return serveAsset(request, env);
      case 'none':
        return new Response('Not found', { status: 404 });
    }
  }
} satisfies ExportedHandler<Env>;
