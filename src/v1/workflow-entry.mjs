// Production Worker entry for v1 (switch wrangler `main` to this file in stage 6, with approval).
// It keeps the existing site handler and adds the durable Workflow class. Not imported by Node tests
// because `cloudflare:workers` only exists in the Workers runtime.
import {WorkflowEntrypoint} from 'cloudflare:workers';
import site from '../site-worker.mjs';
import {runSummaryJob} from './pipeline.mjs';

export class SummaryWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runSummaryJob({jobId: event.payload.jobId, env: this.env, step});
  }
}

export default site;
