import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import test from 'node:test';
import {verifyV1Access} from '../../src/v1/access.mjs';
import {handleV1Site} from '../../src/v1/entry.mjs';

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...publicKey.export({format: 'jwk'}), kid: 'k1', alg: 'RS256'};
const TEAM = 'https://team.cloudflareaccess.com';
const CLIENT = `${'a'.repeat(32)}.access`;
const env = {ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: 'aud-123456789012', ACCESS_OWNER_EMAIL: 'owner@x.io',
  V1_SERVICE_TOKEN_CLIENT_ID: CLIENT};
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);

function token(claims, kid = 'k1') {
  const head = b64({alg: 'RS256', kid});
  const body = b64({iss: TEAM, aud: [env.ACCESS_AUD], iat: now - 10, exp: now + 300, ...claims});
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
const fetcher = async () => new Response(JSON.stringify({keys: [jwk]}));
const req = (jwt, path = '/api/v1/health') => new Request(`https://s.test${path}`,
  {headers: jwt ? {'cf-access-jwt-assertion': jwt} : {}});

test('owner email and the configured service token are accepted', async () => {
  assert.deepEqual(await verifyV1Access(req(token({email: 'Owner@x.io'})), env, {fetcher}), {ok: true,
    identity: 'owner'});
  assert.deepEqual(await verifyV1Access(req(token({common_name: CLIENT})), env, {fetcher}), {ok: true,
    identity: 'service'});
});

test('other identities, unset config, bad signature, expiry and audience are rejected', async () => {
  const denied = async (jwt, e = env) => (await verifyV1Access(req(jwt), e, {fetcher})).ok === false;
  assert.ok(await denied(token({email: 'someone@x.io'})));
  assert.ok(await denied(token({common_name: `${'b'.repeat(32)}.access`})));
  assert.ok(await denied(token({common_name: CLIENT}), {...env, V1_SERVICE_TOKEN_CLIENT_ID: undefined}));
  assert.ok(await denied(token({common_name: CLIENT, email: 'someone@x.io'})));
  assert.ok(await denied(token({email: 'owner@x.io', exp: now - 1})));
  assert.ok(await denied(token({email: 'owner@x.io', aud: ['other']})));
  const forged = token({email: 'owner@x.io'}).split('.');
  forged[1] = b64({iss: TEAM, aud: [env.ACCESS_AUD], iat: now, exp: now + 300, email: 'owner@x.io', x: 1});
  assert.ok(await denied(forged.join('.')));
  assert.ok(await denied(null));
});

test('the service token opens only /api/v1, never the production pages', async () => {
  const service = token({common_name: CLIENT});
  const api = await handleV1Site(req(service, '/api/v1/health'), env, null, {access: {fetcher}});
  assert.equal(api.status, 200);
  const page = await handleV1Site(req(service, '/'), env);
  assert.equal(page.status, 401);
  const legacyApi = await handleV1Site(req(service, '/api/jobs'), env);
  assert.equal(legacyApi.status, 401);
});

test('the PC runner token opens only /api/v1/runner/*', async () => {
  const RUNNER = `${'c'.repeat(32)}.access`;
  const e = {...env, V1_RUNNER_TOKEN_CLIENT_ID: RUNNER};
  const jwt = token({common_name: RUNNER});
  assert.deepEqual(await verifyV1Access(req(jwt), e, {fetcher}), {ok: true, identity: 'runner'});
  const blocked = await handleV1Site(req(jwt, '/api/v1/jobs'), e, null, {access: {fetcher}});
  assert.equal(blocked.status, 403);
  const allowed = await handleV1Site(req(jwt, '/api/v1/runner/unknown'), e, null, {access: {fetcher}});
  assert.notEqual(allowed.status, 403);
  assert.notEqual(allowed.status, 401);
  assert.equal((await handleV1Site(req(jwt, '/'), e)).status, 401);
});

test('the reader token (other projects) may only list summaries and fetch exports', async () => {
  const READER = `${'d'.repeat(32)}.access`;
  const e = {...env, V1_READER_TOKEN_CLIENT_ID: READER};
  const jwt = token({common_name: READER});
  const call = (path, method = 'GET') => handleV1Site(new Request(`https://s.test${path}`, {method,
    headers: {'cf-access-jwt-assertion': jwt, origin: 'https://s.test', 'content-type': 'application/json'},
    body: method === 'GET' ? undefined : '{}'}), e, null, {access: {fetcher}});
  const id = '00000000-0000-4000-8000-000000000001';
  for (const path of ['/api/v1/jobs', `/api/v1/jobs/${id}/export`]) {
    assert.notEqual((await call(path)).status, 403, path);
  }
  for (const [path, method] of [['/api/v1/jobs', 'POST'], [`/api/v1/jobs/${id}`, 'GET'],
    [`/api/v1/jobs/${id}`, 'DELETE'], ['/api/v1/usage', 'GET'], ['/api/v1/runner/next', 'POST'], [`/api/v1/jobs/${id}/corrections`, 'PUT'],
    ['/api/v1/legacy-sources', 'GET']]) {
    assert.equal((await call(path, method)).status, 403, `${method} ${path}`);
  }
  assert.equal((await handleV1Site(req(jwt, '/'), e)).status, 401);
});
