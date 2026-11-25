import {AppError, toPublicError} from './errors.mjs';

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: JSON_HEADERS});
}

// A body that is already JSON text (stored rows passed through without re-serializing).
export function jsonText(text, status = 200) {
  return new Response(text, {status, headers: JSON_HEADERS});
}

export function errorResponse(error) {
  const {status, body} = toPublicError(error);
  return json(body, status);
}

export const MAX_JSON_BYTES = 1_000_000;

export async function readJson(request, maxBytes = MAX_JSON_BYTES) {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new AppError('BAD_REQUEST', 'JSON body must be an object');
  }
}

// Writes must come from the same origin as the site (CSRF protection).
export function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) throw new AppError('FORBIDDEN_ORIGIN');
}
