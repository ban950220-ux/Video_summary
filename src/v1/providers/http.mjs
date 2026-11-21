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

// Keeps the provider's own reason (e.g. Google's error.message) so failures can be diagnosed.
// Anything that looks like a credential is masked, and the text is truncated.
export function safeReason(text) {
  return String(text ?? '')
    .replace(/(AIza[0-9A-Za-z_-]{10,}|gsk_[0-9A-Za-z]{10,}|sk-[0-9A-Za-z]{10,}|Bearer\s+\S+)/g, '[masked]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[masked]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export async function failedResponse(response, name = 'provider') {
  let reason = '';
  try {
    const text = await response.text();
    try {
      const body = JSON.parse(text);
      reason = body?.error?.message ?? body?.message ?? body?.error ?? text;
    } catch {
      reason = text;
    }
  } catch {
    reason = '';
  }
  const detail = `${name} ${response.status}${reason ? `: ${safeReason(reason)}` : ''}`;
  return providerError('PROVIDER_FAILED', detail, {status: response.status});
}
