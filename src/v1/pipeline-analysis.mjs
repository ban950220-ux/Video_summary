// Stage 8-B analysis pipeline: runs on request for a job that already has a summary.
// Result is stored as summary.analysis; numeric verification then covers it automatically.
import {AppError} from './errors.mjs';
import {safeReason} from './providers/http.mjs';
import {analysisPlan, analyzeChunk, analyzeSingle, combineAnalysis, finalizeAnalysis} from './summary/analysis.mjs';
import {inlineStep, jobContext} from './pipeline.mjs';

export async function runAnalysisJob({jobId, env, step = inlineStep, deps = {}}) {
  const {sleep, jobs, usage, modelsFor, durable} = jobContext({env, step, deps});
  try {
    const plan = await durable('analysis-plan', async () => {
      const [transcript, summary] = await Promise.all([jobs.loadTranscript(jobId), jobs.loadSummary(jobId)]);
      if (!transcript || !summary) throw new AppError('NOT_FOUND', 'summary required');
      return analysisPlan(transcript);
    });
    const run = (name, fn) => durable(name, async () => {
      const [transcript, job, {models}] = await Promise.all([jobs.loadTranscript(jobId), jobs.get(jobId),
        modelsFor()]);
      const log = [];
      const value = await fn({transcript, title: job.title, models, usage, sleep, log});
      return {value, log};
    });
    const calls = [];
    let result;
    if (plan.mode === 'single') {
      const single = await run('analysis-single', common => analyzeSingle(common));
      calls.push(...single.log);
      result = single.value;
    } else {
      const partials = [];
      for (const chunk of plan.chunks) {
        const mapped = await run(`analysis-map-${chunk.index + 1}`,
          common => analyzeChunk({...common, chunk, total: plan.chunks.length}));
        calls.push(...mapped.log);
        partials.push(mapped.value);
      }
      const reduced = await run('analysis-reduce', common => combineAnalysis({...common, partials}));
      calls.push(...reduced.log);
      result = reduced.value;
    }
    await durable('analysis-save', async () => {
      const summary = await jobs.loadSummary(jobId);
      await jobs.saveSummary(jobId, {...summary, analysis: finalizeAnalysis({result, plan, calls})});
    });
    return {status: 'DONE'};
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'INTERNAL';
    const detail = safeReason(error instanceof AppError ? error.detail : error?.message);
    try {
      const summary = await jobs.loadSummary(jobId);
      if (summary) {
        await jobs.saveSummary(jobId, {...summary, analysis: {status: 'FAILED', code, detail,
          finishedAt: new Date().toISOString()}});
      }
    } catch {
      // Recording the failure must never hide it.
    }
    return {status: 'FAILED', errorCode: code, detail};
  }
}
