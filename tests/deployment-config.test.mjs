import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertProductionTarget} from '../scripts/guard-production-target.mjs';
import {assertProductionBranch} from '../scripts/production-branch.mjs';

const config=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8');

test('production target, existing D1 and disabled paid/live API pass offline guard',()=>{
  assert.equal(assertProductionTarget(config),true);
});

test('wrong Worker, D1 and CI name override fail before deployment',()=>{
  assert.throws(()=>assertProductionTarget(config.replace('name = "holy-rice-b914"','name = "video-summary"')),/Worker name/);
  assert.throws(()=>assertProductionTarget(config.replace('d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34','00000000-0000-0000-0000-000000000000')),/D1 ID/);
  assert.equal(assertProductionTarget(config,{WRANGLER_CI_OVERRIDE_NAME:'holy-rice-b914'}),true);
  assert.throws(()=>assertProductionTarget(config,{WRANGLER_CI_OVERRIDE_NAME:'video-summary'}),/WRANGLER_CI_OVERRIDE_NAME/);
});

test('Workers Builds detached checkout uses branch and commit metadata',()=>{
  const sha='a'.repeat(40);
  assert.equal(assertProductionBranch({WORKERS_CI:'1',WORKERS_CI_BRANCH:'main',WORKERS_CI_COMMIT_SHA:sha},'',sha),true);
  assert.throws(()=>assertProductionBranch({WORKERS_CI:'1',WORKERS_CI_BRANCH:'review',WORKERS_CI_COMMIT_SHA:sha},'',sha),/main branch/);
  assert.throws(()=>assertProductionBranch({WORKERS_CI:'1',WORKERS_CI_BRANCH:'main',WORKERS_CI_COMMIT_SHA:'b'.repeat(40)},'',sha),/matching commit SHA/);
  assert.throws(()=>assertProductionBranch({},'codex/production-config-review',sha),/main branch/);
});

test('public Access values, live API and production D1 in previews fail',()=>{
  assert.throws(()=>assertProductionTarget(config+'\nACCESS_AUD = "do-not-publish"\n'),/private Access/);
  assert.throws(()=>assertProductionTarget(config.replace('ENABLE_LIVE_FREE = "false"','ENABLE_LIVE_FREE = "true"')),/ENABLE_LIVE_FREE/);
  assert.throws(()=>assertProductionTarget(config+'\n[[previews.d1_databases]]\ndatabase_id = "d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34"\n'),/preview/);
});

test('production config preserves remote preview, logs, and dashboard variables',()=>{
  assert.throws(()=>assertProductionTarget(config.replace('preview_urls = false','preview_urls = true')),/version URLs/);
  assert.throws(()=>assertProductionTarget(config.replace('keep_vars = true','keep_vars = false')),/dashboard variables/);
  assert.throws(()=>assertProductionTarget(config.replace('redact_query_string = false','redact_query_string = true')),/observability/);
  assert.throws(()=>assertProductionTarget(config.replace('invocation_logs = true','invocation_logs = false')),/observability/);
  assert.throws(()=>assertProductionTarget(config.replace('invocation_logs = true','invocation_logs = true\ndestinations = []')),/unobserved observability fields/);
  assert.throws(()=>assertProductionTarget(config.replace('[assets]','[observability.issues]\nenabled = false\n\n[assets]')),/unobserved observability fields/);
});
