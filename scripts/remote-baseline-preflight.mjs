// Read-only Workers Builds diagnostic. Never print remote bindings or raw API data.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readRemoteState} from './read-remote-state.mjs';
import {approvedRemoteBaseline} from './remote-state-policy.mjs';

const boolean=value=>typeof value==='boolean'?value:'MISSING_OR_INVALID';
const rate=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?value:'MISSING_OR_INVALID';
const count=value=>Array.isArray(value)?value.length:'MISSING_OR_INVALID';
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

function safeObservability(value){
  return {
    enabled:boolean(value?.enabled),headSamplingRate:rate(value?.head_sampling_rate),redactQueryString:boolean(value?.redact_query_string),
    logs:{enabled:boolean(value?.logs?.enabled),headSamplingRate:rate(value?.logs?.head_sampling_rate),invocationLogs:boolean(value?.logs?.invocation_logs),persist:boolean(value?.logs?.persist),destinationCount:count(value?.logs?.destinations)},
    traces:{enabled:boolean(value?.traces?.enabled),headSamplingRate:rate(value?.traces?.head_sampling_rate),persist:boolean(value?.traces?.persist),destinationCount:count(value?.traces?.destinations)},
    issues:{enabled:boolean(value?.issues?.enabled)},
  };
}

function safeOptional(field,kind){
  if(typeof field?.present!=='boolean')return {present:'MISSING_OR_INVALID',kind:'MISSING_OR_INVALID'};
  if(!field.present)return {present:false,kind:'OMITTED'};
  const value=field.value;
  if(value===null)return {present:true,kind:'NULL'};
  if(kind==='placement')return {present:true,kind:value==='smart'?'SMART':value==='off'?'OFF':'OTHER'};
  if(kind==='consumers')return {present:true,kind:Array.isArray(value)?'ARRAY':'OTHER',count:count(value)};
  if(kind==='limits')return {present:true,kind:typeof value==='object'&&!Array.isArray(value)?'OBJECT':'OTHER',fieldCount:value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).length:'NOT_OBJECT',cpuMs:typeof value?.cpu_ms==='number'&&Number.isFinite(value.cpu_ms)?value.cpu_ms:'NOT_NUMERIC'};
  return {present:true,kind:'OTHER'};
}

export function safeRemoteBaselineReport(remote,env={}){
  const bindings=Array.isArray(remote?.bindings)?remote.bindings:[];
  const binding=name=>bindings.find(item=>item?.name===name);
  const expected=approvedRemoteBaseline;
  const flags={ENABLE_LIVE_FREE:'false',ALLOW_PAID_API:'false',SITE_DEPLOYED:'true'};
  return {
    kind:'REMOTE_BASELINE_PREFLIGHT',readOnly:true,
    target:{workerMatched:remote?.workerName==='holy-rice-b914',productionEnvironment:remote?.environment==='production',buildTagMatched:env.WRANGLER_CI_MATCH_TAG?remote?.workerTag===env.WRANGLER_CI_MATCH_TAG:'NOT_SUPPLIED',activeVersionMatchesExpected:Boolean(remote?.activeVersions?.length===1&&remote.activeVersions[0]?.id===expected.activeVersionId&&remote.activeVersions[0]?.percentage===100),d1MatchesExpected:Boolean(binding('DB')?.type==='d1'&&binding('DB')?.id===expected.databaseId),accessBindingsPresent:Boolean(binding('ACCESS_AUD')?.type==='plain_text'&&binding('ACCESS_TEAM_DOMAIN')?.type==='plain_text'&&binding('ACCESS_OWNER_EMAIL')?.type==='secret_text'&&binding('KEY_ENCRYPTION_KEY_B64')?.type==='secret_text'),accessVarsValid:typeof binding('ACCESS_AUD')?.text==='string'&&binding('ACCESS_AUD').text.length>=12&&/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(binding('ACCESS_TEAM_DOMAIN')?.text??''),runtimeFlagsMatch:Object.entries(flags).every(([name,value])=>binding(name)?.type==='plain_text'&&binding(name)?.text===value)},
    exposure:{workersDev:boolean(remote?.workersDev),previewUrls:boolean(remote?.previewUrls),routeCount:count(remote?.routes),domainCount:count(remote?.domains)},
    metadata:{compatibilityDateMatchesExpected:remote?.compatibilityDate===expected.compatibilityDate,compatibilityFlagsMatchExpected:same(remote?.compatibilityFlags,expected.compatibilityFlags),observability:safeObservability(remote?.observability),observabilityMatchesProposed:same(remote?.observability,expected.observability),limits:safeOptional(remote?.optionalScriptFields?.limits,'limits'),placementMode:safeOptional(remote?.optionalScriptFields?.placement_mode,'placement'),streamingTailConsumers:safeOptional(remote?.optionalScriptFields?.streaming_tail_consumers,'consumers'),optionalFieldsMatchProposed:same(remote?.optionalScriptFields,expected.optionalScriptFields)},
    scriptSettings:{logpush:boolean(remote?.scriptSettings?.logpush),logpushMatchesProposed:remote?.scriptSettings?.logpush===expected.scriptSettings.logpush,tailConsumerCount:count(remote?.scriptSettings?.tail_consumers),tailConsumersMatchProposed:same(remote?.scriptSettings?.tail_consumers,expected.scriptSettings.tail_consumers),observability:safeObservability(remote?.scriptSettings?.observability),observabilityMatchesProposed:same(remote?.scriptSettings?.observability,expected.scriptSettings.observability)},
    reviewGateEnabled:expected.remoteSettingsReviewed===true,
  };
}

export async function runRemoteBaselinePreflight({env=process.env,fetcher=fetch,write=console.log}={}){
  if(!env.WORKERS_CI||!env.CLOUDFLARE_API_TOKEN){write('REMOTE_BASELINE_PREFLIGHT_FAILED: BUILD_CONTEXT_OR_TOKEN_UNAVAILABLE');return false;}
  try{
    const remote=await readRemoteState({token:env.CLOUDFLARE_API_TOKEN,fetcher});
    write(JSON.stringify(safeRemoteBaselineReport(remote,env)));
    return true;
  }catch{
    write('REMOTE_BASELINE_PREFLIGHT_FAILED: READ_OR_RESPONSE_INVALID');
    return false;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(!await runRemoteBaselinePreflight())process.exitCode=1;
}
