import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertProductionTarget} from '../scripts/guard-production-target.mjs';

const config=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8');

test('production target, existing D1 and disabled paid/live API pass offline guard',()=>{
  assert.equal(assertProductionTarget(config),true);
});

test('wrong Worker, D1 and CI name override fail before deployment',()=>{
  assert.throws(()=>assertProductionTarget(config.replace('name = "holy-rice-b914"','name = "video-summary"')),/Worker name/);
  assert.throws(()=>assertProductionTarget(config.replace('d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34','00000000-0000-0000-0000-000000000000')),/D1 ID/);
  assert.throws(()=>assertProductionTarget(config,{WRANGLER_CI_OVERRIDE_NAME:'video-summary'}),/WRANGLER_CI_OVERRIDE_NAME/);
});

test('public Access values, live API and production D1 in previews fail',()=>{
  assert.throws(()=>assertProductionTarget(config+'\nACCESS_AUD = "do-not-publish"\n'),/private Access/);
  assert.throws(()=>assertProductionTarget(config.replace('ENABLE_LIVE_FREE = "false"','ENABLE_LIVE_FREE = "true"')),/ENABLE_LIVE_FREE/);
  assert.throws(()=>assertProductionTarget(config+'\n[[previews.d1_databases]]\ndatabase_id = "d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34"\n'),/preview/);
});
