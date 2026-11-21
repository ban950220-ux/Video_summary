// Outbound HTTP helper for providers. Maps transport outcomes to AppError codes used by
// the retry policy. Never puts keys in URLs or error details.
import {AppError} from '../errors.mjs';

function providerError(code, detail, {retryable = false, retryAfterMs = null, status = null} = {}) {
  const error = new AppError(code, detail);
  error.retryable = retryable;
  error.retryAfterMs = retryAfterMs;
  error.providerStatus = status;
  return error;
}

function retryAfter(headers) {
  const raw = headers.get('retry-after');
  if (raw && /^\d{1,5}$/.test(raw)) return Number(raw) * 1000;
  return null;
}

export async function providerFetch(url, init, {fetchFn = fetch, timeoutMs = 120_000, name = 'provider'} = {}) {
  let response;
  try {
    response = await fetchFn(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
  } catch (error) {
    throw providerError('PROVIDER_FAILED', `${name} network: ${error?.name ?? 'error'}`, {retryable: true});
  }
  if (response.status === 429) {
    throw providerError('PROVIDER_RATE_LIMITED', `${name} 429`, {
      retryable: true, retryAfterMs: retryAfter(response.headers), status: 429,
    });
  }
  if (response.status >= 500) {
    throw providerError('PROVIDER_FAILED', `${name} ${response.status}`, {retryable: true, status: response.status});
  }
  return response;
}

export async function readProviderJson(response, name = 'provider') {
  try {
    return await response.json();
  } catch {
    throw providerError('PROVIDER_INVALID_OUTPUT', `${name} body is not JSON`);
  }
}

export function failedResponse(response, name = 'provider') {
  return providerError('PROVIDER_FAILED', `${name} ${response.status}`, {status: response.status});
}
