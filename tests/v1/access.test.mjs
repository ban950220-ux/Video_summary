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
