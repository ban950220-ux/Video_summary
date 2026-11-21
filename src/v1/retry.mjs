// Retry policy approved 2026-11-21 (docs/v1/HANDOFF_REVIEW.md 3-1), free providers only:
// - response arrived but output was invalid  -> retry at most 1 time
// - network error, timeout, 5xx or 429       -> wait, then retry at most 2 times
// - anything else (4xx, missing key, limits) -> no retry
// Every attempt is recorded so the outcome stays reviewable.
import {AppError} from './errors.mjs';

export const RETRY_POLICY = Object.freeze({invalidOutput: 1, transient: 2, baseDelayMs: 2000, maxDelayMs: 60_000});

export function classify(error) {
  if (!(error instanceof AppError)) return 'transient';
  if (error.code === 'PROVIDER_INVALID_OUTPUT') return 'invalidOutput';
  if (error.code === 'PROVIDER_RATE_LIMITED') return 'transient';
  if (error.code === 'PROVIDER_FAILED' && error.retryable) return 'transient';
  return 'permanent';
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function withRetry(label, fn, {policy = RETRY_POLICY, sleep = realSleep, attempts = []} = {}) {
  const used = {invalidOutput: 0, transient: 0};
  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = await fn(attempt);
      attempts.push({label, attempt, outcome: 'ok'});
      return value;
    } catch (error) {
      const kind = classify(error);
      const code = error instanceof AppError ? error.code : 'NETWORK';
      attempts.push({label, attempt, outcome: 'error', code, kind});
      if (kind === 'permanent' || used[kind] >= policy[kind]) throw error;
      used[kind] += 1;
      const hinted = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null;
      const backoff = policy.baseDelayMs * 2 ** (used.transient + used.invalidOutput - 1);
      await sleep(Math.min(policy.maxDelayMs, hinted ?? backoff));
    }
  }
}
