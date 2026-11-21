// v1 site entry. Runs the same owner checks as src/site-worker.mjs (Cloudflare Access JWT,
// same-origin JSON writes) before /api/v1/*, and hands every other path to the production handler
// unchanged, so every live feature keeps working.
import {authConfigured, sameOriginMutation, verifyOwnerAccess} from '../access.mjs';
// The live production site (version dede9fb3), not the older v0.7 source in src/: see production/README.md.
import {handleSiteRequest} from '../../production/dede9fb3/runtime/primary.mjs';
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

// The v0.7 site CSP has no manifest-src, so `default-src 'none'` would block the PWA manifest.
// Only /v1/ pages get the same policy plus manifest-src and worker-src.
export const V1_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; "
  + "frame-ancestors 'none'";

async function v1Page(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/v1') return Response.redirect(`${url.origin}/v1/`, 301);
  return withV1PageHeaders(await handleSiteRequest(request, env, ctx), url.pathname);
}

export function withV1PageHeaders(response, pathname) {
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', V1_PAGE_CSP);
  // Revalidate every time: a stale app.js/result.js after a deploy hid new failure details once.
  headers.set('cache-control', 'no-cache');
  if (pathname.endsWith('/sw.js')) headers.set('service-worker-allowed', '/v1/');
  return new Response(response.body, {status: response.status, headers});
}

export async function handleV1Site(request, env, ctx, deps = {}) {
  const path = new URL(request.url).pathname;
  if (path === '/v1' || path.startsWith('/v1/')) return v1Page(request, env, ctx);
  if (!path.startsWith('/api/v1/')) return handleSiteRequest(request, env, ctx);
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
