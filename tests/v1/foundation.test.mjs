import assert from 'node:assert/strict';
import test from 'node:test';
import {readConfig, DEFAULT_DAILY_LIMITS} from '../../src/v1/config.mjs';
import {AppError, ERRORS, toPublicError} from '../../src/v1/errors.mjs';
import {assertSameOrigin, readJson} from '../../src/v1/http.mjs';
import {routeV1} from '../../src/v1/router.mjs';
import {lintText} from '../../scripts/v1-lint.mjs';

const BASE = 'https://example.test';

test('paid API is never allowed, even when the environment requests it', () => {
  const config = readConfig({ALLOW_PAID_API: 'true'});
  assert.equal(config.paidApiAllowed, false);
  assert.equal(config.paidApiRequested, true);
  assert.equal(readConfig({}).paidApiAllowed, false);
});

test('daily limits can be lowered but never raised above defaults', () => {
  const lowered = readConfig({V1_LIMIT_SUPADATA_CALLS: '1'});
  assert.equal(lowered.dailyLimits.supadataCalls, 1);
  const raised = readConfig({V1_LIMIT_GEMINI_VIDEO_SECONDS: String(DEFAULT_DAILY_LIMITS.geminiVideoSeconds * 10)});
  assert.equal(raised.dailyLimits.geminiVideoSeconds, DEFAULT_DAILY_LIMITS.geminiVideoSeconds);
  for (const bad of ['-1', 'abc', '1.5']) {
    assert.equal(readConfig({V1_LIMIT_GROQ_CALLS: bad}).dailyLimits.groqCalls, DEFAULT_DAILY_LIMITS.groqCalls);
  }
});

test('error codes stay few and every code has a status and Korean message', () => {
  const codes = Object.keys(ERRORS);
  assert.ok(codes.length <= 30, `too many error codes: ${codes.length}`);
  for (const code of codes) {
    assert.ok(Number.isInteger(ERRORS[code].status));
    assert.match(ERRORS[code].message, /[가-힣]/);
  }
});

test('unknown errors become INTERNAL and never leak details', () => {
  const unknown = toPublicError(new Error('secret detail sk-123'));
  assert.equal(unknown.status, 500);
  assert.equal(unknown.body.error.code, 'INTERNAL');
  assert.doesNotMatch(JSON.stringify(unknown.body), /secret detail/);
  const known = toPublicError(new AppError('INVALID_URL', 'raw input'));
  assert.deepEqual(known.body.error, {code: 'INVALID_URL', message: ERRORS.INVALID_URL.message});
  assert.equal(new AppError('NOT_A_CODE').code, 'INTERNAL');
});

test('readJson rejects oversized, malformed and non-object bodies', async () => {
  const post = (body, headers = {}) => new Request(`${BASE}/x`, {method: 'POST', body, headers});
  assert.deepEqual(await readJson(post('{"a":1}')), {a: 1});
  await assert.rejects(readJson(post('x'.repeat(20), {'content-length': '20'}), 10), {code: 'PAYLOAD_TOO_LARGE'});
  await assert.rejects(readJson(post('가'.repeat(5)), 10), {code: 'PAYLOAD_TOO_LARGE'});
  await assert.rejects(readJson(post('{bad')), {code: 'BAD_REQUEST'});
  await assert.rejects(readJson(post('[1,2]')), {code: 'BAD_REQUEST'});
});

test('same-origin check accepts only the exact site origin', () => {
  const withOrigin = origin => new Request(`${BASE}/api/v1/jobs`, {method: 'POST', headers: origin ? {origin} : {}});
  assert.doesNotThrow(() => assertSameOrigin(withOrigin(BASE)));
  assert.throws(() => assertSameOrigin(withOrigin('https://evil.test')), {code: 'FORBIDDEN_ORIGIN'});
  assert.throws(() => assertSameOrigin(withOrigin(null)), {code: 'FORBIDDEN_ORIGIN'});
});

test('health endpoint reports free-only status without secrets', async () => {
  const response = await routeV1(new Request(`${BASE}/api/v1/health`), {
    ALLOW_PAID_API: 'false', ENABLE_LIVE_FREE: 'true', GEMINI_API_KEY: 'should-not-appear', DB: {},
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.paidApiAllowed, false);
  assert.equal(body.liveProvidersEnabled, true);
  assert.equal(body.persistence, true);
  assert.doesNotMatch(JSON.stringify(body), /should-not-appear/);
});

test('unknown routes and methods return NOT_FOUND', async () => {
  for (const request of [new Request(`${BASE}/api/v1/nope`), new Request(`${BASE}/api/v1/health`, {method: 'POST'})]) {
    const response = await routeV1(request, {});
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
});

test('lint rule flags long files and long lines', () => {
  assert.deepEqual(lintText('ok\n'), []);
  assert.equal(lintText('a\n'.repeat(401)).length, 1);
  assert.match(lintText('x'.repeat(121))[0], /121 chars/);
});
