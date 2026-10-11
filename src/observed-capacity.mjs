import {InputError} from './core.mjs';
import {ProviderError} from './adapters.mjs';
const models={gemini:'gemini-2.5-flash',groq:'whisper-large-v3-turbo'};
const sources={gemini:'AI_STUDIO_LIVE',groq:'GROQ_CONSOLE_LIVE'};
const dimensions={gemini:['requestsMinute','tokensMinute','requestsDay'],groq:['requestsMinute','audioSecondsHour','audioSecondsDay']};
const maxAgeMs=60_000;
export async function ensureCapacitySchema(env){
 const rows=(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('yta_capacity','yta_wait')").bind().all()).results||[];
 if(rows.length!==2)throw new ProviderError('CAPACITY_SCHEMA_REQUIRED','관측 용량 테이블의 추가 마이그레이션이 필요합니다.');
}
export async function recordCapacity(env,body){
 await ensureCapacitySchema(env);
 if(!body||typeof body!=='object'||Array.isArray(body))throw new InputError('용량 관측 입력 형식 오류');
 const provider=body.provider,required=dimensions[provider],now=Date.now();
 if(provider&&dimensions[provider]&&body.externalActivity===true){await env.DB.prepare('UPDATE yta_capacity SET valid_until=0,version=version+1 WHERE provider=?').bind(provider).run();throw new ProviderError('CAPACITY_WAIT','외부 계정 사용이 보고되어 관측치를 무효화했습니다.');}
 if(!required||body.model!==models[provider]||body.source!==sources[provider]||body.billingDisabled!==true||body.freeOnly!==true||body.externalActivity!==false)throw new InputError('제공자 콘솔의 무료 계정·모델·외부 사용 상태 확인이 필요합니다.');
 if(!Number.isInteger(body.observedAt)||body.observedAt>now||now-body.observedAt>maxAgeMs)throw new InputError('공급자 계정 전체의 최신 관측 시각이 필요합니다.');
 const remaining={},reset={};
 for(const key of required){
  const value=body.remaining?.[key],at=body.resetAt?.[key];
  if(!Number.isSafeInteger(value)||value<0||!Number.isInteger(at)||at<=now||at>now+86_500_000)throw new InputError('공급자 잔여량과 각 제한의 재설정 시각이 모두 필요합니다.');
  remaining[key]=value;reset[key]=at;
 }
 const inFlight=await env.DB.prepare("SELECT 1 FROM yta_operations WHERE provider=? AND state='CLAIMED' LIMIT 1").bind(provider).first();
 if(inFlight)throw new ProviderError('OPERATION_IN_FLIGHT','진행 중인 제공자 요청이 끝난 뒤 관측치를 갱신하세요.');
 const old=await env.DB.prepare('SELECT version FROM yta_capacity WHERE provider=?').bind(provider).first();
 const data=[provider,body.model,body.source,body.observedAt,body.observedAt+maxAgeMs,JSON.stringify(reset),JSON.stringify(remaining),JSON.stringify(Object.fromEntries(required.map(key=>[key,0]))),1];
 const result=old?await env.DB.prepare('UPDATE yta_capacity SET model=?,source=?,observed_at=?,valid_until=?,reset_json=?,remaining_json=?,reserved_json=?,version=version+1,billing_disabled=? WHERE provider=? AND version=? AND NOT EXISTS (SELECT 1 FROM yta_operations WHERE provider=? AND state=\'CLAIMED\')').bind(...data.slice(1),provider,old.version,provider).run():await env.DB.prepare('INSERT OR IGNORE INTO yta_capacity(provider,model,source,observed_at,valid_until,reset_json,remaining_json,reserved_json,billing_disabled) VALUES(?,?,?,?,?,?,?,?,?)').bind(...data).run();
 if(result.meta?.changes!==1)throw new ProviderError('CAPACITY_UPDATE_RACE','용량 관측 중 요청 상태가 바뀌었습니다. 다시 확인하세요.');
 return {recorded:true,provider,model:body.model,validUntil:body.observedAt+maxAgeMs,provenance:'OWNER_COPIED_PROVIDER_DASHBOARD_NOT_INDEPENDENTLY_VERIFIED'};
}
export async function reserveObservedCapacity(env,{provider,operationId,jobId,bounds}){
 await ensureCapacitySchema(env);
 const required=dimensions[provider];if(!required)throw new ProviderError('CAPACITY_PROVIDER_UNSUPPORTED','관측 용량 제공자 오류');
 for(let attempt=0;attempt<3;attempt++){
  const row=await env.DB.prepare('SELECT * FROM yta_capacity WHERE provider=?').bind(provider).first(),now=Date.now();
  if(!row||row.model!==models[provider]||row.billing_disabled!==1||row.valid_until<=now){await persistWait(env,{operationId,jobId,provider,reason:'OBSERVATION_MISSING_OR_STALE',resetAt:null});throw new ProviderError('CAPACITY_WAIT','최신 공급자 계정 전체 잔여량 관측이 필요합니다.');}
  const remaining=JSON.parse(row.remaining_json),reserved=JSON.parse(row.reserved_json),reset=JSON.parse(row.reset_json);
  const limiting=required.find(key=>!Number.isSafeInteger(bounds[key])||bounds[key]<1||!Number.isSafeInteger(remaining[key])||!Number.isSafeInteger(reserved[key])||remaining[key]-reserved[key]<bounds[key]);
  if(limiting){await persistWait(env,{operationId,jobId,provider,reason:'INSUFFICIENT_'+limiting,resetAt:reset[limiting]});throw new ProviderError('CAPACITY_WAIT','공급자 잔여 '+limiting+' 한도가 부족합니다. 재설정 후 다시 관측하세요.');}
  for(const key of required)reserved[key]+=bounds[key];
  const update=await env.DB.prepare('UPDATE yta_capacity SET reserved_json=?,version=version+1 WHERE provider=? AND version=? AND valid_until>? AND billing_disabled=1').bind(JSON.stringify(reserved),provider,row.version,Date.now()).run();
  if(update.meta?.changes===1){await env.DB.prepare('DELETE FROM yta_wait WHERE operation_id=?').bind(operationId).run();return {validUntil:row.valid_until,observedAt:row.observed_at,version:row.version+1};}
 }
 await persistWait(env,{operationId,jobId,provider,reason:'CONCURRENT_CAPACITY_CHANGE',resetAt:null});throw new ProviderError('CAPACITY_WAIT','동시 용량 변경을 확인한 뒤 다시 시도하세요.');
}
export async function persistWait(env,{operationId,jobId,provider,reason,resetAt}){
 await env.DB.prepare('INSERT INTO yta_wait(operation_id,job_id,provider,reason,reset_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET reason=excluded.reason,reset_at=excluded.reset_at,created_at=excluded.created_at').bind(operationId,jobId,provider,reason,resetAt,new Date().toISOString()).run();
}
export function capacityBounds(provider,units){
 if(provider==='gemini')return {requestsMinute:1,tokensMinute:Math.ceil(units*1.25),requestsDay:1};
 if(provider==='groq')return {requestsMinute:1,audioSecondsHour:Math.ceil(units*1.25)+60,audioSecondsDay:Math.ceil(units*1.25)+60};
 throw new ProviderError('CAPACITY_PROVIDER_UNSUPPORTED','용량 제공자 오류');
}
