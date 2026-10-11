import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertRemoteState} from '../scripts/remote-state-policy.mjs';

const observability={enabled:true,head_sampling_rate:1,redact_query_string:false,logs:{enabled:true,head_sampling_rate:1,invocation_logs:true,persist:true,destinations:[]},traces:{enabled:false,head_sampling_rate:1,persist:true,destinations:[]},issues:{enabled:false}};
const version='a'.repeat(8)+'-1111-4111-8111-'+'b'.repeat(12);
const optionalScriptFields={limits:{present:true,value:null},placement_mode:{present:true,value:null},streaming_tail_consumers:{present:true,value:[]}};
const baseline={activeVersionId:version,routes:[],domains:[],compatibilityDate:'2026-10-10',compatibilityFlags:[],observability,databaseId:'d7c1bd48-b0e1-4bb2-a7d7-2079d5e20b34',remoteSettingsReviewed:true,optionalScriptFields,scriptSettings:{logpush:false,tail_consumers:[],observability}};
const remote=()=>({workerName:'holy-rice-b914',environment:'production',activeVersions:[{id:version,percentage:100}],workersDev:true,previewUrls:false,routes:[],domains:[],compatibilityDate:'2026-10-10',compatibilityFlags:[],observability:structuredClone(observability),optionalScriptFields:structuredClone(optionalScriptFields),scriptSettings:{logpush:false,tail_consumers:[],observability:structuredClone(observability)},bindings:[
  {name:'DB',type:'d1',id:baseline.databaseId},
  {name:'ACCESS_AUD',type:'plain_text',text:'test-audience-value'},
  {name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:'https://test.cloudflareaccess.com'},
  {name:'ACCESS_OWNER_EMAIL',type:'secret_text'},
  {name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text'},
  {name:'ENABLE_LIVE_FREE',type:'plain_text',text:'false'},
  {name:'ALLOW_PAID_API',type:'plain_text',text:'false'},
  {name:'SITE_DEPLOYED',type:'plain_text',text:'true'},
]});

test('offline remote policy allows reviewed ASSETS addition and unchanged state',()=>{
  assert.equal(assertRemoteState(remote(),baseline),true);
  const after=remote();after.bindings.push({name:'ASSETS',type:'assets'});
  assert.equal(assertRemoteState(after,baseline),true);
});
test('offline remote policy fails closed on active version, DB, Access, preview and observability drift',()=>{
  for(const mutate of [
    state=>{state.activeVersions[0].id='different';},
    state=>{state.bindings[0].id='different';},
    state=>{state.bindings.splice(1,1);},
    state=>{state.bindings[1].text='';},
    state=>{state.previewUrls=true;},
    state=>{state.observability.logs.persist=false;},
    state=>{state.observability.traces.head_sampling_rate=0.5;},
    state=>{state.bindings.push({name:'OTHER',type:'plain_text',text:'x'});},
    state=>{state.scriptSettings.logpush=true;},
    state=>{state.scriptSettings.tail_consumers.push({service:'unexpected'});},
    state=>{state.optionalScriptFields.streaming_tail_consumers.value.push({service:'unexpected'});},
    state=>{state.optionalScriptFields.limits.value={cpu_ms:100};},
    state=>{state.optionalScriptFields.placement_mode.value='smart';},
    state=>{state.optionalScriptFields.placement_mode.present=false;},
    state=>{state.scriptSettings.observability.logs.persist=false;},
  ]){const state=remote();mutate(state);assert.throws(()=>assertRemoteState(state,baseline),/Remote deployment guard/);}
  const incomplete=remote();delete incomplete.observability.logs.invocation_logs;
  assert.throws(()=>assertRemoteState(incomplete,baseline),/OBSERVABILITY_INCOMPLETE/);
});
