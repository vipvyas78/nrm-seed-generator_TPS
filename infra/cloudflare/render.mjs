#!/usr/bin/env node
/**
 * Render the TPS wrangler config for ONE environment (nrm-seed-generator#145).
 *
 *   node render.mjs --env dev --account-id <id> --tag <image tag> [--out wrangler.json]
 *
 * The same shape as BuildFlow's infra/cloudflare/render.mjs, for the same reason:
 * containers, durable objects and routes do not inherit across wrangler environments, and
 * the image tag is only known at deploy time. Nothing secret is rendered.
 *
 * The worker names must match the `services` binding BuildFlow's render.mjs declares.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

export const ENVIRONMENTS = {
  dev: { worker: 'novamerx-tps-dev', host: 'dev.novamerx.ai', testEmail: 'Y' },
  staging: { worker: 'novamerx-tps-staging', host: 'staging.novamerx.ai', testEmail: 'Y' },
  production: { worker: 'novamerx-tps', host: 'app.novamerx.ai', testEmail: 'N' }
};

export const REQUIRED_SECRETS = [
  'DATABASE_URL', 'REDIS_URL', 'TOKEN_ENCRYPTION_KEY',
  'BUILDFLOW_DOCUMENT_LINKS_TOKEN', 'BUILDFLOW_NOTIFICATIONS_TOKEN', 'WORKER_WAKE_TOKEN'
];

export function render({ env, accountId, tag, logDestination, vars = {} }) {
  const spec = ENVIRONMENTS[env];
  if (!spec) throw new Error(`unknown environment "${env}" (expected ${Object.keys(ENVIRONMENTS).join(', ')})`);
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error('--account-id must be a 32-character Cloudflare account id');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(tag)) throw new Error(`--tag "${tag}" is not a valid image tag`);

  const image = `registry.cloudflare.com/${accountId}/tps-bff:${tag}`;
  const eu = { jurisdiction: 'eu' };
  const destinations = logDestination ? { destinations: [logDestination] } : {};
  const containerObservability = { logs: { enabled: true, ...destinations } };

  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: spec.worker,
    main: 'src/index.ts',
    compatibility_date: '2026-09-01',
    // No route of its own: reached only through BuildFlow's service binding.
    workers_dev: false,
    preview_urls: false,
    assets: { directory: '../../apps/web/dist', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
    containers: [
      { class_name: 'BffTps', image, instance_type: 'basic', max_instances: 1, constraints: eu, observability: containerObservability },
      { class_name: 'WorkerTps', image, instance_type: 'lite', max_instances: 1, constraints: eu, observability: containerObservability }
    ],
    durable_objects: {
      bindings: [
        { name: 'BFF_TPS', class_name: 'BffTps' },
        { name: 'WORKER_TPS', class_name: 'WorkerTps' }
      ]
    },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['BffTps', 'WorkerTps'] }],
    secrets: { required: REQUIRED_SECRETS },
    vars: {
      ENVIRONMENT: env,
      PUBLIC_ORIGIN: `https://${spec.host}`,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      // Dev and staging redirect every outbound email to the test inbox.
      TEST_EMAIL_FLAG: spec.testEmail,
      BULLMQ_DRAIN_DELAY_SECONDS: '30',
      ...vars
    },
    observability: { enabled: true, logs: { enabled: true, invocation_logs: true, ...destinations } }
  };
}

if (process.argv[1]?.endsWith('render.mjs')) {
  const { values } = parseArgs({
    options: {
      env: { type: 'string' },
      'account-id': { type: 'string' },
      tag: { type: 'string' },
      'log-destination': { type: 'string' },
      // Non-secret per-environment settings: --var TEST_TO_EMAIL_ACCOUNT=qa@firm.com
      var: { type: 'string', multiple: true, default: [] },
      out: { type: 'string', default: 'wrangler.json' }
    }
  });
  const vars = Object.fromEntries(values.var.filter((pair) => pair.includes('=') && !pair.endsWith('=')).map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)];
  }));
  const config = render({
    env: values.env, accountId: values['account-id'], tag: values.tag, logDestination: values['log-destination'], vars
  });
  writeFileSync(values.out, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`rendered ${values.out} for ${values.env} (${config.name}, image tag ${values.tag})`);
}
