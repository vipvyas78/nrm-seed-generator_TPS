// node --test test/render.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENVIRONMENTS, REQUIRED_SECRETS, render } from '../render.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';

test('worker names are the ones BuildFlow binds to', () => {
  // Must equal `services[0].service` in nrm-seed-generator/infra/cloudflare/render.mjs.
  assert.equal(ENVIRONMENTS.dev.worker, 'novamerx-tps-dev');
  assert.equal(ENVIRONMENTS.staging.worker, 'novamerx-tps-staging');
  assert.equal(ENVIRONMENTS.production.worker, 'novamerx-tps');
});

test('TPS has no public route: no custom domain, no workers.dev, no preview URL', () => {
  for (const env of Object.keys(ENVIRONMENTS)) {
    const config = render({ env, accountId: ACCOUNT, tag: 't' });
    assert.equal(config.routes, undefined);
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
  }
});

test('containers are held to the EU and run the image at the resolved tag', () => {
  for (const container of render({ env: 'dev', accountId: ACCOUNT, tag: 'sha-abc' }).containers) {
    assert.deepEqual(container.constraints, { jurisdiction: 'eu' });
    assert.equal(container.image, `registry.cloudflare.com/${ACCOUNT}/tps-bff:sha-abc`);
  }
});

test('only production sends real email; dev and staging redirect to the test inbox', () => {
  assert.equal(render({ env: 'dev', accountId: ACCOUNT, tag: 't' }).vars.TEST_EMAIL_FLAG, 'Y');
  assert.equal(render({ env: 'staging', accountId: ACCOUNT, tag: 't' }).vars.TEST_EMAIL_FLAG, 'Y');
  assert.equal(render({ env: 'production', accountId: ACCOUNT, tag: 't' }).vars.TEST_EMAIL_FLAG, 'N');
});

test('required secrets are declared and none is rendered into vars', () => {
  const config = render({ env: 'production', accountId: ACCOUNT, tag: 't' });
  assert.deepEqual(config.secrets.required, REQUIRED_SECRETS);
  for (const key of Object.keys(config.vars)) assert.doesNotMatch(key, /TOKEN|SECRET|PASSWORD|DATABASE_URL|REDIS_URL/, key);
});

test('bad input is refused', () => {
  assert.throws(() => render({ env: 'qa', accountId: ACCOUNT, tag: 't' }), /unknown environment/);
  assert.throws(() => render({ env: 'dev', accountId: 'x', tag: 't' }), /account-id/);
});
