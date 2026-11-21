import assert from 'node:assert/strict';
import test from 'node:test';
import {AppError} from '../../src/v1/errors.mjs';
import {classify, withRetry} from '../../src/v1/retry.mjs';

const transient = () => Object.assign(new AppError('PROVIDER_FAILED'), {retryable: true});

async function run(errors) {
  let calls = 0;
  const attempts = [];
  const delays = [];
  const result = withRetry('t', async () => {
    const next = errors[calls++];
    if (next) throw next;
    return 'ok';
  }, {attempts, sleep: async ms => delays.push(ms)});
  return {result, attempts, delays, calls: () => calls};
}

test('invalid output is retried exactly once', async () => {
  const one = await run([new AppError('PROVIDER_INVALID_OUTPUT')]);
  assert.equal(await one.result, 'ok');
  assert.equal(one.calls(), 2);
  const two = await run([new AppError('PROVIDER_INVALID_OUTPUT'), new AppError('PROVIDER_INVALID_OUTPUT')]);
  await assert.rejects(two.result, {code: 'PROVIDER_INVALID_OUTPUT'});
  assert.equal(two.calls(), 2);
});

test('network/5xx/429 are retried at most twice with waiting', async () => {
  const ok = await run([transient(), new AppError('PROVIDER_RATE_LIMITED')]);
  assert.equal(await ok.result, 'ok');
  assert.equal(ok.calls(), 3);
  assert.deepEqual(ok.delays, [2000, 4000]);
  const fail = await run([transient(), transient(), transient()]);
  await assert.rejects(fail.result, {code: 'PROVIDER_FAILED'});
  assert.equal(fail.calls(), 3);
});

test('retry-after hint is honoured and capped', async () => {
  const hinted = Object.assign(new AppError('PROVIDER_RATE_LIMITED'), {retryAfterMs: 10_000});
  const capped = Object.assign(new AppError('PROVIDER_RATE_LIMITED'), {retryAfterMs: 999_000});
  const r = await run([hinted, capped]);
  await r.result;
  assert.deepEqual(r.delays, [10_000, 60_000]);
});

test('permanent errors are not retried and every attempt is recorded', async () => {
  for (const code of ['PROVIDER_KEY_MISSING', 'DAILY_LIMIT_REACHED', 'PAID_API_BLOCKED']) {
    const r = await run([new AppError(code)]);
    await assert.rejects(r.result, {code});
    assert.equal(r.calls(), 1);
    assert.deepEqual(r.attempts, [{label: 't', attempt: 1, outcome: 'error', code, kind: 'permanent'}]);
  }
  assert.equal(classify(new AppError('PROVIDER_FAILED')), 'permanent');
  assert.equal(classify(new TypeError('x')), 'transient');
});
