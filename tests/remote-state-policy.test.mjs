import {test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedRemoteBaseline,assertRemoteState} from '../scripts/remote-state-policy.mjs';

const observability=approvedRemoteBaseline.observability;
const version='a'.repeat(8)+'-1111-4111-8111-'+'b'.repeat(12);
const optionalScriptFields=approvedRemoteBaseline.optionalScriptFields;
const baseline={...approvedRemoteBaseline,activeVersionId:version,remoteSettingsReviewed:true};
const remote=()=>({workerName:'holy-rice-b914',environment:'production',activeVersions:[{id:version,percentage:100}],workersDev:true,previewUrls:false,routes:[],domains:[],compatibilityDate:'2026-10-10',compatibilityFlagsPresent:false,observability:structuredClone(observability),optionalScriptFields:structuredClone(optionalScriptFields),scriptSettings:{logpush:false,tail_consumers:null,observability:structuredClone(observability)},bindings:[
  {name:'DB',type:'d1',id:baseline.databaseId},
  {name:'ACCESS_AUD',type:'plain_text',text:'test-audience-value'},
  {name:'ACCESS_TEAM_DOMAIN',type:'plain_text',text:'https://test.cloudflareaccess.com'},
  {name:'ACCESS_OWNER_EMAIL',type:'secret_text'},
  {name:'KEY_ENCRYPTION_KEY_B64',type:'secret_text'},
  {name:'ENABLE_LIVE_FREE',type:'plain_text',text:'false'},
  {name:'ALLOW_PAID_API',type:'plain_text',text:'false'},
  {name:'SITE_DEPLOYED',type:'plain_text',text:'true'},
]});

test('offline remote policy permits ASSETS only after upload',()=>{
  assert.equal(assertRemoteState(remote(),baseline),true);
  const after=remote();after.bindings.push({name:'ASSETS',type:'assets'});
  assert.throws(()=>assertRemoteState(after,baseline),/BINDINGS_UNEXPECTED/);
  assert.equal(assertRemoteState(after,baseline,{allowAssets:true}),true);
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
    state=>{state.scriptSettings.tail_consumers=[];},
    state=>{state.optionalScriptFields.streaming_tail_consumers={present:true,value:[]};},
    state=>{state.optionalScriptFields.limits={present:true,value:null};},
    state=>{state.optionalScriptFields.placement_mode={present:true,value:'smart'};},
    state=>{state.compatibilityFlagsPresent=true;state.compatibilityFlags=[];},
    state=>{state.observability.logs.destinations=[];},
    state=>{state.observability.issues={enabled:false};},
    state=>{state.scriptSettings.observability.logs.persist=false;},
  ]){const state=remote();mutate(state);assert.throws(()=>assertRemoteState(state,baseline),/Remote deployment guard/);}
  const incomplete=remote();delete incomplete.observability.logs.invocation_logs;
  assert.throws(()=>assertRemoteState(incomplete,baseline),/OBSERVABILITY_INCOMPLETE/);
});
