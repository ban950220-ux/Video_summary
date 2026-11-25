// Summary job pipeline. Written against a minimal step interface so the same code runs as a
// Cloudflare Workflow (durable steps, resume after failure) or inline (no Workflow binding):
//   step.do(name, options, fn) -> result of fn, cached by name when durable.
// Step results stay small: the transcript and summary live in D1, not in step state.
import {acquireTranscript} from './acquire.mjs';
import {readConfig} from './config.mjs';
import {jobRepository, STATUS} from './db/jobs.mjs';
import {createD1Usage} from './db/usage.mjs';
import {AppError} from './errors.mjs';
import {refreshChecks} from './detail.mjs';
import {loadProviderKeys} from './keys.mjs';
import {DEFAULT_GEMINI_MODEL} from './providers/gemini.mjs';
import {safeReason} from './providers/http.mjs';
import {geminiTextModel, groqTextModel} from './providers/llm.mjs';
import {combinePartials, finalizeSummary, summarizeChunk, summarizeSingle, summaryPlan} from './summary/engine.mjs';

// Provider retries happen inside the step (approved policy); the platform must not add more.
export const STEP_OPTIONS = Object.freeze({retries: {limit: 0, delay: 1000}, timeout: '15 minutes'});

export const inlineStep = Object.freeze({do: async (name, options, fn) => (fn ?? options)()});

async function fetchTitle(canonicalUrl, fetchFn) {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonicalUrl)}`;
    const response = await fetchFn(url, {signal: AbortSignal.timeout(10_000)});
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.title === 'string' ? body.title.slice(0, 300) : null;
  } catch {
    return null;
  }
}

const STEP_ERROR = /V1ERR::([A-Z_]{2,40})::([\s\S]*)$/;

export function encodeStepError(name, error) {
  const known = error instanceof AppError;
  const code = known ? error.code : 'INTERNAL';
  const detail = safeReason(`${name}: ${known ? error.detail ?? error.message : error?.message ?? error}`);
  return `V1ERR::${code}::${detail}`;
}

export function decodeStepError(error) {
  if (error instanceof AppError) return error;
  const match = String(error?.message ?? '').match(STEP_ERROR);
  return match ? new AppError(match[1], match[2]) : new AppError('INTERNAL', safeReason(error?.message));
}

// Per-job helpers shared by the summary and analysis pipelines.
export function jobContext({env, step = inlineStep, deps = {}}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep;
  const config = readConfig(env);
  const jobs = jobRepository(env.DB, deps);
  const usage = createD1Usage(env.DB, config.dailyLimits, {...deps, budget: config.budget});
  // Reused by every step of one run: keys, transcript and title do not change while a job runs, and each
  // D1 call and decryption costs CPU against the Free plan's 10ms per step. A failure is not cached.
  const once = fn => {
    let pending = null;
    return () => (pending ??= fn().catch(error => {
      pending = null;
      throw error;
    }));
  };
  const keysOnce = once(() => loadProviderKeys(env));
  let transcript = null;
  let title;
  const current = {
    async transcript(jobId) {
      transcript ??= await jobs.loadTranscript(jobId);
      return transcript;
    },
    async title(jobId) {
      if (title === undefined) title = (await jobs.get(jobId))?.title ?? null;
      return title;
    },
  };
  const modelsFor = async () => {
    const keys = await keysOnce();
    const geminiModel = env.V1_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    return {
      keys,
      geminiModel,
      models: [
        ...(keys.gemini ? [geminiTextModel({apiKey: keys.gemini, model: geminiModel, fetchFn})] : []),
        ...(keys.groq ? [groqTextModel({apiKey: keys.groq, fetchFn})] : []),
      ],
    };
  };

  // Errors thrown inside a durable step come back from the Workflow engine re-wrapped as plain Errors,
  // losing the AppError class. The code and reason are carried in the message and rebuilt here.
  // Failures are still thrown (never returned), so the engine does not cache a failed step.
  const durable = async (name, fn) => {
    try {
      return await step.do(name, STEP_OPTIONS, async () => {
        try {
          return await fn();
        } catch (error) {
          throw new Error(encodeStepError(name, error));
        }
      });
    } catch (error) {
      throw decodeStepError(error);
    }
  };

  return {fetchFn, sleep, config, jobs, usage, modelsFor, durable, current};
}

export async function runSummaryJob({jobId, env, step = inlineStep, deps = {}}) {
  const {fetchFn, sleep, config, jobs, usage, modelsFor, durable, current} = jobContext({env, step, deps});

  try {
    const acquired = await durable('acquire', async () => {
      const job = await jobs.get(jobId);
      if (!job) throw new AppError('NOT_FOUND', jobId);
      const existing = await jobs.loadTranscript(jobId);
      if (existing) return {source: existing.source, reused: true};
      await jobs.update(jobId, {status: STATUS.ACQUIRING});
      const {keys, geminiModel} = await modelsFor();
      try {
        const result = await acquireTranscript({url: job.url, db: env.DB, keys, usage, fetchFn, sleep, geminiModel,
          geminiOnly: job.options?.geminiOnly === true,
          liveProvidersEnabled: config.liveProvidersEnabled});
        await jobs.saveTranscript(jobId, result.transcript, {legacyJobId: result.legacyJobId ?? null});
        const title = job.title ?? await fetchTitle(result.canonicalUrl, fetchFn);
        await jobs.update(jobId, {transcriptSource: result.method, attempts: result.attempts, title});
        return {source: result.method, reused: false};
      } catch (error) {
        if (error?.attempts) await jobs.update(jobId, {attempts: error.attempts});
        throw error;
      }
    });

    const plan = await durable('plan', async () => {
      await jobs.update(jobId, {status: STATUS.SUMMARIZING});
      return summaryPlan(await current.transcript(jobId));
    });

    const run = async (name, fn) => durable(name, async () => {
      const [transcript, title, {models}] = await Promise.all([current.transcript(jobId), current.title(jobId),
        modelsFor()]);
      const log = [];
      const value = await fn({transcript, title, models, usage, sleep, log});
      return {value, log};
    });

    const calls = [];
    let final;
    if (plan.mode === 'single') {
      const single = await run('single', common => summarizeSingle(common));
      calls.push(...single.log);
      final = single.value;
    } else {
      const partials = [];
      for (const chunk of plan.chunks) {
        const mapped = await run(`map-${chunk.index + 1}`,
          common => summarizeChunk({...common, chunk, total: plan.chunks.length}));
        calls.push(...mapped.log);
        partials.push(mapped.value);
      }
      const reduced = await run('reduce', common => combinePartials({...common, partials}));
      calls.push(...reduced.log);
      final = reduced.value;
    }

    await durable('save', async () => {
      const transcript = await jobs.loadTranscript(jobId);
      await jobs.saveSummary(jobId, finalizeSummary({final, transcript, plan, calls}));
    });
    // Its own step: verification of a long video is the heaviest CPU work after the model calls.
    await durable('checks', async () => {
      await refreshChecks(jobs, jobId);
      await jobs.update(jobId, {status: STATUS.DONE, errorCode: null});
    });
    return {status: STATUS.DONE, source: acquired.source};
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'INTERNAL';
    const detail = safeReason(error instanceof AppError ? error.detail : error?.message);
    try {
      const job = await jobs.get(jobId);
      const attempts = [...(job?.attempts ?? []), {step: 'failure', outcome: 'error', code, detail}];
      await jobs.update(jobId, {status: STATUS.FAILED, errorCode: code, attempts});
    } catch {
      // Recording the failure must never hide it.
    }
    return {status: STATUS.FAILED, errorCode: code, detail};
  }
}
