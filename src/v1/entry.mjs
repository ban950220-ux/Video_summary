// v1 site entry. Runs the same owner checks as src/site-worker.mjs (Cloudflare Access JWT,
// same-origin JSON writes) before /api/v1/*, and hands every other path to the v0.7 handler
// unchanged. Kept separate so the reviewed v0.7 entry and its single-file bundle stay as they were.
import {authConfigured, sameOriginMutation, verifyOwnerAccess} from '../access.mjs';
import {handleSiteRequest} from '../site-worker.mjs';
import {routeV1} from './router.mjs';

const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
});

function denied(code, status) {
  return new Response(JSON.stringify({error: {code, message: '본인 인증이 필요합니다.'}}), {status,
    headers: {...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}});
}

export async function handleV1Site(request, env, ctx, deps = {}) {
  if (!new URL(request.url).pathname.startsWith('/api/v1/')) return handleSiteRequest(request, env, ctx);
  if (!authConfigured(env)) return denied('ACCESS_NOT_CONFIGURED', 503);
  const access = await verifyOwnerAccess(request, env, deps.access);
  if (!access.ok) return denied(access.reason, 401);
  if (!sameOriginMutation(request)) return denied('CSRF_BLOCKED', 403);
  const response = await routeV1(request, env, ctx, deps);
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, {status: response.status, headers});
}

export default {fetch: (request, env, ctx) => handleV1Site(request, env, ctx)};
