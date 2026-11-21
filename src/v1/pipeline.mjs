// Summary job pipeline. Written against a minimal step interface so the same code runs as a
// Cloudflare Workflow (durable steps, resume after failure) or inline (no Workflow binding):
//   step.do(name, options, fn) -> result of fn, cached by name when durable.
// Step results stay small: the transcript and summary live in D1, not in step state.
import {acquireTranscript} from './acquire.mjs';
import {readConfig} from './config.mjs';
import {jobRepository, STATUS} from './db/jobs.mjs';
import {createD1Usage} from './db/usage.mjs';
import {AppError} from './errors.mjs';
import {loadProviderKeys} from './keys.mjs';
import {DEFAULT_GEMINI_MODEL} from './providers/gemini.mjs';
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

export async function runSummaryJob({jobId, env, step = inlineStep, deps = {}}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep;
  const config = readConfig(env);
  const jobs = jobRepository(env.DB, deps);
  const usage = createD1Usage(env.DB, config.dailyLimits, deps);
  const modelsFor = async () => {
    const keys = await loadProviderKeys(env);
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

  try {
    const acquired = await step.do('acquire', STEP_OPTIONS, async () => {
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

    const plan = await step.do('plan', STEP_OPTIONS, async () => {
      await jobs.update(jobId, {status: STATUS.SUMMARIZING});
      return summaryPlan(await jobs.loadTranscript(jobId));
    });

    const run = async (name, fn) => step.do(name, STEP_OPTIONS, async () => {
      const [transcript, job, {models}] = await Promise.all([jobs.loadTranscript(jobId), jobs.get(jobId), modelsFor()]);
      const log = [];
      const value = await fn({transcript, title: job.title, models, usage, sleep, log});
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

    await step.do('save', STEP_OPTIONS, async () => {
      const transcript = await jobs.loadTranscript(jobId);
      await jobs.saveSummary(jobId, finalizeSummary({final, transcript, plan, calls}));
      await jobs.update(jobId, {status: STATUS.DONE, errorCode: null});
    });
    return {status: STATUS.DONE, source: acquired.source};
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'INTERNAL';
    await jobs.update(jobId, {status: STATUS.FAILED, errorCode: code}).catch(() => {});
    return {status: STATUS.FAILED, errorCode: code};
  }
}
