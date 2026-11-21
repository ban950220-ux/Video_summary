// Production Worker entry for v1 (switch wrangler `main` to this file in stage 6, with approval).
// It serves the v1 API plus the existing site (src/v1/entry.mjs) and adds the durable Workflow class.
// Not imported by Node tests because `cloudflare:workers` only exists in the Workers runtime.
import {WorkflowEntrypoint} from 'cloudflare:workers';
import site from './entry.mjs';
import {runSummaryJob} from './pipeline.mjs';
import {runAnalysisJob} from './pipeline-analysis.mjs';

export class SummaryWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const run = event.payload.task === 'analysis' ? runAnalysisJob : runSummaryJob;
    return run({jobId: event.payload.jobId, env: this.env, step});
  }
}

export default site;
