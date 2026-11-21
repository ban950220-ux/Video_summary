// Supadata existing-caption lookup. ALWAYS mode=native: the default (auto) falls back to
// AI generation billed per minute, which this free-only app must never trigger.
// Responses: 200 content, 202 {jobId} (poll), 206 no captions (still costs 1 credit).
import {AppError} from '../errors.mjs';
import {makeTranscript, SOURCES} from '../transcript.mjs';
import {failedResponse, providerFetch, readProviderJson} from './http.mjs';

export const SUPADATA_BASE = 'https://api.supadata.ai/v1/transcript';
const JOB_ID = /^[A-Za-z0-9-]{1,100}$/;

export function supadataRequestUrl(canonicalUrl) {
  const url = new URL(SUPADATA_BASE);
  url.searchParams.set('url', canonicalUrl);
  url.searchParams.set('mode', 'native');
  url.searchParams.set('text', 'false');
  return url.toString();
}

function toTranscript(body) {
  const content = body?.content;
  if (!Array.isArray(content)) throw new AppError('PROVIDER_INVALID_OUTPUT', 'supadata content missing');
  const segments = content.map(item => {
    if (!item || typeof item.text !== 'string' || !Number.isFinite(item.offset) || !Number.isFinite(item.duration)
        || item.offset < 0 || item.duration < 0) {
      throw new AppError('PROVIDER_INVALID_OUTPUT', 'supadata segment invalid');
    }
    return {startMs: item.offset, endMs: item.offset + item.duration, text: item.text};
  });
  try {
    return makeTranscript({source: SOURCES.SUPADATA_NATIVE, language: body.lang ?? null, segments});
  } catch (error) {
    if (error?.code === 'INVALID_TRANSCRIPT') throw new AppError('PROVIDER_INVALID_OUTPUT', 'supadata empty');
    throw error;
  }
}

// Returns a transcript, or null when the video has no captions.
export async function fetchNativeCaptions({canonicalUrl, apiKey, fetchFn = fetch, sleep, maxPolls = 30,
  pollDelayMs = 2000}) {
  if (!apiKey) throw new AppError('PROVIDER_KEY_MISSING', 'supadata');
  const headers = {'x-api-key': apiKey, accept: 'application/json'};
  const response = await providerFetch(supadataRequestUrl(canonicalUrl), {headers}, {fetchFn, name: 'supadata'});
  if (response.status === 206 || response.status === 404) return null;
  if (!response.ok && response.status !== 202) throw failedResponse(response, 'supadata');
  const body = await readProviderJson(response, 'supadata');
  if (!body?.jobId) return toTranscript(body);
  if (typeof body.jobId !== 'string' || !JOB_ID.test(body.jobId)) {
    throw new AppError('PROVIDER_INVALID_OUTPUT', 'supadata jobId');
  }
  const wait = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let poll = 0; poll < maxPolls; poll += 1) {
    await wait(pollDelayMs);
    const jobUrl = `${SUPADATA_BASE}/${encodeURIComponent(body.jobId)}`;
    const jobResponse = await providerFetch(jobUrl, {headers}, {fetchFn, name: 'supadata'});
    if (!jobResponse.ok) throw failedResponse(jobResponse, 'supadata');
    const job = await readProviderJson(jobResponse, 'supadata');
    if (job?.status === 'failed') return null;
    if (job?.status === 'completed') return toTranscript(job.result ?? job);
  }
  throw new AppError('PROVIDER_FAILED', 'supadata job did not finish');
}
