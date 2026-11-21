// v1 API. src/site-worker.mjs verifies Cloudflare Access (owner) and same-origin JSON writes
// before any /api/ route, so every handler here already runs as the owner.
import {acquireFromUpload} from './acquire.mjs';
import {readConfig} from './config.mjs';
import {jobRepository} from './db/jobs.mjs';
import {createD1Usage} from './db/usage.mjs';
import {AppError} from './errors.mjs';
import {exportMarkdown, exportText} from './export.mjs';
import {assertSameOrigin, errorResponse, json, readJson} from './http.mjs';
import {keyStatus, loadProviderKeys} from './keys.mjs';
import {inlineStep, runSummaryJob} from './pipeline.mjs';
import {parseYouTubeUrl} from './youtube.mjs';

export const API_PREFIX = '/api/v1/';
const JOB_PATH = /^jobs\/([0-9a-f-]{36})(\/export)?$/;

// Durable Workflow when bound (production), otherwise inline in the background or awaited (tests).
async function startJob(jobId, env, ctx, deps) {
  if (env.SUMMARY_WORKFLOW?.create) {
    await env.SUMMARY_WORKFLOW.create({id: jobId, params: {jobId}});
    return 'workflow';
  }
  const run = runSummaryJob({jobId, env, step: inlineStep, deps});
  if (ctx?.waitUntil) {
    ctx.waitUntil(run);
    return 'background';
  }
  await run;
  return 'inline';
}

async function jobDetail(jobs, id) {
  const job = await jobs.get(id);
  if (!job) throw new AppError('NOT_FOUND');
  const [transcript, summary] = await Promise.all([jobs.loadTranscript(id), jobs.loadSummary(id)]);
  return {job, transcript, summary};
}

async function createJob(request, env, ctx, deps, jobs) {
  assertSameOrigin(request);
  const body = await readJson(request);
  const {videoId, canonicalUrl} = parseYouTubeUrl(body.url);
  if (body.force !== true) {
    const existing = await jobs.findReusable(videoId);
    if (existing) return json({job: existing, reused: true});
  }
  const job = await jobs.create({videoId, url: canonicalUrl});
  const runner = await startJob(job.id, env, ctx, deps);
  return json({job: await jobs.get(job.id), reused: false, runner}, 202);
}

async function uploadJob(request, env, ctx, deps, jobs) {
  assertSameOrigin(request);
  const body = await readJson(request, 2_500_000);
  const acquired = acquireFromUpload({url: body.url || null, filename: body.filename, text: body.text});
  const title = typeof body.title === 'string' ? body.title.slice(0, 300) : null;
  const job = await jobs.create({videoId: acquired.videoId, url: acquired.canonicalUrl, title});
  await jobs.saveTranscript(job.id, acquired.transcript);
  await jobs.update(job.id, {transcriptSource: acquired.method, attempts: acquired.attempts});
  const runner = await startJob(job.id, env, ctx, deps);
  return json({job: await jobs.get(job.id), runner}, 202);
}

export async function routeV1(request, env = {}, ctx = null, deps = {}) {
  try {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(API_PREFIX)) throw new AppError('NOT_FOUND');
    const path = url.pathname.slice(API_PREFIX.length);
    const method = request.method;
    const config = readConfig(env);

    if (path === 'health' && method === 'GET') {
      return json({ok: true, version: config.version, paidApiAllowed: config.paidApiAllowed,
        paidApiRequested: config.paidApiRequested, liveProvidersEnabled: config.liveProvidersEnabled,
        persistence: Boolean(env.DB), durableJobs: Boolean(env.SUMMARY_WORKFLOW)});
    }
    const known = path === 'jobs' || path === 'jobs/upload' || path === 'usage' || JOB_PATH.test(path);
    if (!known) throw new AppError('NOT_FOUND');
    if (!env.DB) throw new AppError('PERSISTENCE_UNAVAILABLE');
    const jobs = jobRepository(env.DB, deps);

    if (path === 'jobs' && method === 'POST') return await createJob(request, env, ctx, deps, jobs);
    if (path === 'jobs/upload' && method === 'POST') return await uploadJob(request, env, ctx, deps, jobs);
    if (path === 'jobs' && method === 'GET') {
      const items = await jobs.list({q: url.searchParams.get('q') ?? '', limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset')});
      return json({jobs: items});
    }
    if (path === 'usage' && method === 'GET') {
      const usage = await createD1Usage(env.DB, config.dailyLimits, deps).snapshot();
      return json({usage, keys: keyStatus(await loadProviderKeys(env))});
    }

    const match = path.match(JOB_PATH);
    if (match && !match[2] && method === 'GET') return json(await jobDetail(jobs, match[1]));
    if (match && match[2] && method === 'GET') {
      const detail = await jobDetail(jobs, match[1]);
      if (!detail.summary) throw new AppError('NOT_FOUND', 'summary not ready');
      const txt = url.searchParams.get('format') === 'txt';
      const body = txt ? exportText(detail) : exportMarkdown(detail);
      return new Response(body, {headers: {
        'content-type': `${txt ? 'text/plain' : 'text/markdown'}; charset=utf-8`, 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="summary-${detail.job.videoId ?? detail.job.id}`
          + `.${txt ? 'txt' : 'md'}"`,
      }});
    }
    if (match && !match[2] && method === 'DELETE') {
      assertSameOrigin(request);
      if (!(await jobs.remove(match[1]))) throw new AppError('NOT_FOUND');
      return json({deleted: true});
    }
    throw new AppError('NOT_FOUND');
  } catch (error) {
    return errorResponse(error);
  }
}
