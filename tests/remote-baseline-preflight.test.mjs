import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runRemoteBaselinePreflight,safeRemoteBaselineReport} from '../scripts/remote-baseline-preflight.mjs';
import {approvedRemoteBaseline} from '../scripts/remote-state-policy.mjs';

const secret='PRIVATE_SENTINEL_DO_NOT_PRINT';
const remote=()=>({
 workerName:'holy-rice-b914',environment:'production',workerTag:secret,
 activeVersions:[{id:approvedRemoteBaseline.activeVersionId,percentage:100}],
 workersDev:true,previewUrls:false,routes:[{pattern:secret}],domains:[{hostname:secret}],deploymentMessage:secret,
 compatibilityDate:'2026-10-10',compatibilityFlags:[],
 observability:{...structuredClone(approvedRemoteBaseline.observability),logs:{...approvedRemoteBaseline.observability.logs,destinations:[secret]}},
 optionalScriptFields:{limits:{present:false},placement_mode:{present:true,value:null},streaming_tail_consumers:{present:true,value:[{service:secret}]}},
 scriptSettings:{logpush:false,tail_consumers:[{service:secret}],observability:{...structuredClone(approvedRemoteBaseline.observability),traces:{...approvedRemoteBaseline.observability.traces,destinations:[secret]}},tags:[secret]},
 bindings:[{name:'DB',type:'d1',id:approvedRemoteBaseline.databaseId},{name:'ACCESS_AUD',type:'plain_text',text:secret},{name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:secret},{name:'ACCESS_OWNER_EMAIL',type:'secret_text',text:secret},{name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text',text:secret},{name:'ENABLE_LIVE_FREE',type:'plain_text',text:'false'},{name:'ALLOW_PAID_API',type:'plain_text',text:'false'},{name:'SITE_DEPLOYED',type:'plain_text',text:'true'}],
});

test('preflight emits only approved booleans, rates, presence and counts',()=>{
 const output=JSON.stringify(safeRemoteBaselineReport(remote(),{WRANGLER_CI_MATCH_TAG:secret}));
 assert.ok(!output.includes(secret));
 assert.ok(!output.includes(approvedRemoteBaseline.databaseId));
 assert.ok(!output.includes(approvedRemoteBaseline.activeVersionId));
 const report=JSON.parse(output);
 assert.equal(report.metadata.limits.kind,'OMITTED');
 assert.equal(report.metadata.streamingTailConsumers.count,1);
 assert.equal(report.scriptSettings.tailConsumerCount,1);
 assert.equal(report.scriptSettings.observability.logs.persist,true);
 assert.equal(report.scriptSettings.observability.traces.destinationCount,1);
 assert.equal(report.exposure.routeCount,1);
 assert.equal(report.target.buildTagMatched,true);
 assert.equal(report.target.accessVarsValid,false);
 assert.equal(report.scriptSettings.logpushMatchesProposed,true);
 assert.equal(report.scriptSettings.tailConsumersMatchProposed,false);
 assert.equal(report.reviewGateEnabled,false);
});

test('preflight uses only fixed Cloudflare GET endpoints and never logs API data on failure',async()=>{
 const calls=[],output=[];
 const fetcher=async(url,options)=>{
  calls.push({url,method:options.method});
  const path=new URL(url).pathname;
  let result;
  if(path.endsWith('/workers/services/holy-rice-b914'))result={default_environment:{environment:'production',script:{tag:secret}}};
  else if(path.endsWith('/environments/production'))result={script:{compatibility_date:'2026-10-10',compatibility_flags:[],observability:remote().observability}};
  else if(path.endsWith('/bindings'))result=remote().bindings;
  else if(path.endsWith('/subdomain'))result={enabled:true,previews_enabled:false};
  else if(path.endsWith('/routes'))result=[];
  else if(path.endsWith('/domains/records'))result=[];
  else if(path.endsWith('/deployments'))result={deployments:[{versions:[{version_id:approvedRemoteBaseline.activeVersionId,percentage:100}]}]};
  else if(path.endsWith('/script-settings'))result=remote().scriptSettings;
  else throw Error('unexpected endpoint');
  return {ok:true,json:async()=>({success:true,result})};
 };
 assert.equal(await runRemoteBaselinePreflight({env:{WORKERS_CI:'1',CLOUDFLARE_API_TOKEN:secret,WRANGLER_CI_MATCH_TAG:secret},fetcher,write:value=>output.push(value)}),true);
 assert.equal(calls.length,8);
 assert.ok(calls.every(call=>call.method==='GET'&&call.url.startsWith('https://api.cloudflare.com/client/v4/accounts/')));
 assert.ok(!output.join('').includes(secret));
 const denied=[];
 assert.equal(await runRemoteBaselinePreflight({env:{WORKERS_CI:'1',CLOUDFLARE_API_TOKEN:secret},fetcher:()=>{throw Error(secret);},write:value=>denied.push(value)}),false);
 assert.deepEqual(denied,['REMOTE_BASELINE_PREFLIGHT_FAILED: READ_OR_RESPONSE_INVALID']);
});
