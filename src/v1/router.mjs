// v1 API router. Stage 1 only exposes a health check; it is not yet wired into
// src/site-worker.mjs, so production behavior is unchanged until stage 4.
// Callers must authenticate the owner (Cloudflare Access) before calling routeV1.
import {readConfig} from './config.mjs';
import {AppError} from './errors.mjs';
import {errorResponse, json} from './http.mjs';

export const API_PREFIX = '/api/v1/';

export async function routeV1(request, env = {}) {
  try {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(API_PREFIX)) throw new AppError('NOT_FOUND');
    const path = url.pathname.slice(API_PREFIX.length);

    if (path === 'health' && request.method === 'GET') {
      const config = readConfig(env);
      return json({
        ok: true,
        version: config.version,
        paidApiAllowed: config.paidApiAllowed,
        paidApiRequested: config.paidApiRequested,
        liveProvidersEnabled: config.liveProvidersEnabled,
        persistence: Boolean(env.DB),
      });
    }

    throw new AppError('NOT_FOUND');
  } catch (error) {
    return errorResponse(error);
  }
}
