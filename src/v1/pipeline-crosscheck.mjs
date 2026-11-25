// Cross-check pipeline: listens again to the evidence windows with Gemini (video by URL) and stores
// summary.crossCheck. Runs on request; each window is one durable step.
import {AppError} from './errors.mjs';
import {inlineStep, jobContext} from './pipeline.mjs';
import {transcribeClip} from './providers/gemini.mjs';
import {safeReason} from './providers/http.mjs';
import {withRetry} from './retry.mjs';
import {compareFacts, CROSS_VERSION, planWindows} from './verify/crosscheck.mjs';
import {checksCurrent, currentVerification} from './checks.mjs';
import {refreshChecks} from './detail.mjs';

export async function runCrossCheckJob({jobId, env, step = inlineStep, deps = {}}) {
  const {fetchFn, sleep, jobs, usage, modelsFor, durable} = jobContext({env, step, deps});
  const load = async () => {
    const [job, transcript, summary] = await Promise.all([jobs.get(jobId), jobs.loadTranscript(jobId),
      jobs.loadSummary(jobId)]);
    if (!job?.url || !transcript || !summary) {
      throw new AppError('NOT_FOUND', 'video URL, transcript and summary required');
    }
    const stored = await jobs.loadChecks(jobId);
    const checks = checksCurrent(stored) ? stored : await refreshChecks(jobs, jobId);
    return {job, transcript, summary, verification: currentVerification(checks.verification, summary)};
  };
  try {
    const windows = await durable('cross-plan', async () => {
      const {transcript, verification} = await load();
      const planned = planWindows(verification, transcript);
      if (!planned.length) throw new AppError('BAD_REQUEST', 'no timed numeric evidence to check');
      return planned;
    });
    const clips = [];
    for (const [index, window] of windows.entries()) {
      clips.push(await durable(`cross-clip-${index + 1}`, async () => {
        const {job} = await load();
        const {keys, geminiModel} = await modelsFor();
        const clip = await withRetry(`cross ${window.startSec}-${window.endSec}s`, async () => {
          await usage.consume({geminiCalls: 1, geminiVideoSeconds: window.endSec - window.startSec});
          const heard = await transcribeClip({canonicalUrl: job.url, startSec: window.startSec,
            endSec: window.endSec, apiKey: keys.gemini, model: geminiModel, fetchFn});
          await usage.charge(heard.usage);
          return heard;
        }, {sleep});
        return {...window, segments: clip.segments.map(({startMs, endMs, text}) => ({startMs, endMs, text})),
          promptTokens: clip.usage.promptTokens};
      }));
    }
    await durable('cross-save', async () => {
      const {transcript, summary, verification} = await load();
      const compared = compareFacts(verification, transcript, clips);
      await jobs.saveSummary(jobId, {...summary, crossCheck: {version: CROSS_VERSION, status: 'DONE', ...compared,
        engine: 'gemini-video', sameEngineAsTranscript: transcript.source === 'gemini-video',
        windows: clips.map(({startSec, endSec, promptTokens}) => ({startSec, endSec, promptTokens})),
        finishedAt: new Date().toISOString()}});
    });
    return {status: 'DONE'};
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'INTERNAL';
    const detail = safeReason(error instanceof AppError ? error.detail : error?.message);
    try {
      const summary = await jobs.loadSummary(jobId);
      if (summary) await jobs.saveSummary(jobId, {...summary, crossCheck: {status: 'FAILED', code, detail}});
    } catch {
      // Recording the failure must never hide it.
    }
    return {status: 'FAILED', errorCode: code, detail};
  }
}
