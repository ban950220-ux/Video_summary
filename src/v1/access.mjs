// Cloudflare Access verification for /api/v1/* only. Accepts the owner (email claim) or, when
// configured, ONE Access service token (common_name claim == V1_SERVICE_TOKEN_CLIENT_ID), so an
// automated tester can call the v1 API. Every other path keeps the production owner-only check.
const jwksCache = new Map();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlBytes(value) {
  if (typeof value !== 'string' || value.length > 24_000 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('INVALID_JWT');
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

function readJwt(request) {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header;
  return (request.headers.get('cookie') ?? '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1] ?? null;
}

async function jwks(domain, kid, fetcher, nowMs) {
  const cached = jwksCache.get(domain);
  if (cached && cached.expires > nowMs && cached.keys.some(k => k.kid === kid)) return cached.keys;
  const response = await fetcher(`${domain}/cdn-cgi/access/certs`, {headers: {accept: 'application/json'}});
  if (!response.ok) throw Error('JWKS_UNAVAILABLE');
  const body = await response.json();
  const keys = (Array.isArray(body?.keys) ? body.keys : []).filter(k => k.kty === 'RSA' && typeof k.kid === 'string');
  jwksCache.set(domain, {keys, expires: nowMs + 5 * 60_000});
  return keys;
}

const CLIENT_ID = /^[0-9a-f]{32}\.access$/;

export function serviceTokenConfigured(env) {
  return CLIENT_ID.test(env?.V1_SERVICE_TOKEN_CLIENT_ID ?? '');
}

// Returns {ok, identity: 'owner' | 'service'} or {ok: false, reason}.
export async function verifyV1Access(request, env, {fetcher = fetch, nowMs = Date.now()} = {}) {
  const jwt = readJwt(request);
  if (!jwt || jwt.length > 18_000) return {ok: false, reason: 'ACCESS_LOGIN_REQUIRED'};
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw Error('INVALID_JWT');
    const header = JSON.parse(decoder.decode(base64UrlBytes(parts[0])));
    const claims = JSON.parse(decoder.decode(base64UrlBytes(parts[1])));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw Error('UNSUPPORTED_ALGORITHM');
    if (claims.iss !== env.ACCESS_TEAM_DOMAIN) throw Error('ISSUER');
    const audOk = Array.isArray(claims.aud) ? claims.aud.includes(env.ACCESS_AUD) : claims.aud === env.ACCESS_AUD;
    if (!audOk) throw Error('AUDIENCE');
    const now = Math.floor(nowMs / 1000);
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= now) throw Error('EXPIRED');
    if (!Number.isSafeInteger(claims.iat) || claims.iat > now + 60) throw Error('FUTURE_IAT');
    if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 60)) throw Error('NBF');
    const owner = typeof claims.email === 'string'
      && claims.email.toLowerCase() === String(env.ACCESS_OWNER_EMAIL ?? '').toLowerCase();
    const service = !claims.email && serviceTokenConfigured(env)
      && claims.common_name === env.V1_SERVICE_TOKEN_CLIENT_ID;
    // The PC runner has its own token; entry.mjs limits it to /api/v1/runner/*.
    const runner = !claims.email && CLIENT_ID.test(env.V1_RUNNER_TOKEN_CLIENT_ID ?? '')
      && claims.common_name === env.V1_RUNNER_TOKEN_CLIENT_ID;
    if (!owner && !service && !runner) throw Error('NOT_ALLOWED');
    const jwk = (await jwks(env.ACCESS_TEAM_DOMAIN, header.kid, fetcher, nowMs)).find(k => k.kid === header.kid);
    if (!jwk) throw Error('UNKNOWN_KEY');
    const key = await crypto.subtle.importKey('jwk', {kty: 'RSA', n: jwk.n, e: jwk.e, ext: true},
      {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlBytes(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) throw Error('SIGNATURE');
    return {ok: true, identity: owner ? 'owner' : service ? 'service' : 'runner'};
  } catch {
    return {ok: false, reason: 'ACCESS_DENIED'};
  }
}
