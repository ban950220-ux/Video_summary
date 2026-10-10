import {InputError,videoIdOf,durationSec,parseCaptions,transcriptAudit,extractiveReport,estimateSource,PROVIDERS,DEFAULT_POLICY,usableFreeUnits} from './core.mjs';
import {configuredMasterKey,encryptProviderKey,providerAllowed} from './vault.mjs';
import {routeLive,saveSource} from './live.mjs';

const JSON_HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:JSON_HEADERS});
const deny=()=>json({error:{code:'UNAUTHORIZED',message:'관리자 인증이 필요합니다.'}},401);
const dbUnavailable=()=>json({error:{code:'PERSISTENCE_NOT_CONFIGURED',message:'D1 바인딩을 설정해야 저장·조회가 가능합니다.'}},503);
function isAuth(req,env){
  // Prototype machine-to-machine guard ONLY. A browser settings UI must NOT handle
  // ADMIN_TOKEN. Gate with verified Cloudflare Access JWT/identity before deployment.
  const token=env?.ADMIN_TOKEN;
  if(!token||typeof token!=='string'||token.length<24) return false;
  return req.headers.get('Authorization')===`Bearer ${token}`;
}
async function bodyJson(request){
  const header=Number(request.headers.get('content-length')||0);
  if(header>2_300_000) throw new InputError('요청 용량이 너무 큽니다.');
  const text=await request.text();
  if(text.length>2_000_000) throw new InputError('요청 용량이 너무 큽니다.');
  try{return JSON.parse(text);}catch{throw new InputError('JSON 구문 오류');}
}
async function saveJob(env,row){
  if(!env?.DB) return false;
  await env.DB.prepare('INSERT INTO jobs(id, owner_id,video_id,title,source_url,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(row.id,'owner',row.videoId??null,row.title??null,row.url??null,row.source,row.status,row.durationSeconds,row.createdAt,row.createdAt,JSON.stringify(row.report??null),JSON.stringify(row.audit??null)).run();
  return true;
}
function preflight(payload){
  const durationSeconds=durationSec(payload.durationSeconds);
  const source=payload.sourceType;
  if(!['url','text','audio'].includes(source)) throw new InputError('지원하지 않는 입력 형식');
  const videoId=source==='url'?videoIdOf(payload.url):null;
  return {videoId,sourceType:source,durationSeconds,budget:DEFAULT_POLICY,routes:estimateSource({durationSeconds,sourceType:source,hasCaptions:payload.hasCaptions===true?true:null,hasOwnedAudio:source==='audio'}),warning:'무료 잔여량은 API 키 및 계정 조회 전 UNKNOWN입니다. 실시간 무료 처리 가능을 보장하지 않습니다.'};
}
async function handleJob(env,payload){
  const quote=preflight(payload),ts=new Date().toISOString();
  const title=typeof payload.title==='string' ? payload.title.trim().slice(0,160) : null;
  const job={id:crypto.randomUUID(),createdAt:ts,videoId:quote.videoId,source:quote.sourceType,durationSeconds:quote.durationSeconds,title};
  if(quote.sourceType==='url'){
    const row={...job,url:`https://www.youtube.com/watch?v=${quote.videoId}`,status:'NEED_UPLOAD',audit:{status:'VIDEO_SUMMARY_ONLY_UNAVAILABLE',reason:'현재 데모에는 YouTube 직접 접근 API 키가 없으며 영상 내용을 추측하지 않습니다.'},report:null};
    return json({job:row,persisted:await saveJob(env,row),preflight:quote},202);
  }
  if(quote.sourceType==='audio'){
    const row={...job,status:'NEED_AUDIO_UPLOAD',audit:{status:'NOT_RUN',reason:'보유 MP3 조각 계획과 무료 계정 할당 후 전사할 수 있습니다. 실환경 검증은 별도 필요합니다.'},report:null};
    return json({job:row,persisted:await saveJob(env,row),preflight:quote},202);
  }
  if(typeof payload.transcript!=='string'||!payload.transcript.trim()) throw new InputError('전사 텍스트가 필요합니다.');
  const parsed=parseCaptions(payload.transcript,payload.filename||'captions.txt');
  const audit=transcriptAudit(parsed.segments,quote.durationSeconds,false);
  const report=extractiveReport(parsed);
  const row={...job,status:audit.status,report,audit,segments:parsed.segments};
  const persistRow={...row,segments:undefined};
  const persisted=await saveJob(env,persistRow);
  if(persisted&&payload.persistTranscript===true)await saveSource(env,row.id,payload.transcript,parsed.segments,parsed.origin);
  return json({job:row,persisted,preflight:quote},201);
}
async function handleUsage(env){
  const usage=PROVIDERS.map(p=>({id:p.id,role:p.role,period:p.period,publishedFreeLimit:p.publishedFreeLimit,accountQuota:usableFreeUnits({limit:p.publishedFreeLimit,appUsed:0,otherUsageKnown:false}),providerConnected:false}));
  let appObserved=[];
  if(env?.DB){
    const res=await env.DB.prepare('SELECT provider,unit,SUM(used_units) AS total_units,COUNT(*) AS events FROM usage_events WHERE owner_id = ? GROUP BY provider,unit').bind('owner').all();
    appObserved=res.results??[];
  }
  return json({scope:'APP_OBSERVED_ONLY',providers:usage,appObserved,policy:DEFAULT_POLICY,verifiedAt:null,warning:'계정 전체 사용량은 알 수 없으며 공급자 대시보드와 차이가 있을 수 있습니다.'});
}
async function listJobs(env,url){
  if(!env?.DB)return dbUnavailable();
  const limit=Math.min(50,Math.max(1,Number.parseInt(url.searchParams.get('limit')||'20',10)||20));
  const offset=Math.min(10000,Math.max(0,Number.parseInt(url.searchParams.get('offset')||'0',10)||0));
  const q=(url.searchParams.get('q')||'').trim().slice(0,100);
  const pattern='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%';
  const stmt=q
    ? env.DB.prepare("SELECT id,video_id,title,source_url,source_type,status,duration_seconds,created_at,updated_at,report_json FROM jobs WHERE owner_id = ? AND (title LIKE ? ESCAPE '\\' OR video_id LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ? OFFSET ?").bind('owner',pattern,pattern,limit,offset)
    : env.DB.prepare('SELECT id,video_id,title,source_url,source_type,status,duration_seconds,created_at,updated_at,report_json FROM jobs WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').bind('owner',limit,offset);
  const rows=(await stmt.all()).results??[];
  return json({jobs:rows.map(({report_json,...row})=>({...row,summary:JSON.parse(report_json||'null')?.summary??[]})),limit,offset,hasMore:rows.length===limit,source:'D1'});
}
async function credentialEvent(env,provider,event){
  await env.DB.prepare('INSERT INTO provider_credential_events(id,owner_id,provider,event_type,at) VALUES(?,?,?,?,?)')
    .bind(crypto.randomUUID(),'owner',provider,event,new Date().toISOString()).run();
}
async function listCredentialStatus(env){
  if(!env?.DB)return dbUnavailable();
  const result=await env.DB.prepare('SELECT provider,updated_at FROM provider_credentials WHERE owner_id = ?').bind('owner').all();
  const mapped=new Map((result.results??[]).map(x=>[x.provider,x.updated_at]));
  return json({providers:['supadata','gemini','groq','assemblyai'].map(provider=>({provider,configured:mapped.has(provider),updatedAt:mapped.get(provider)??null,verification:'NOT_RUN',keyNeverReturned:true})),vaultRootConfigured:!!configuredMasterKey(env),apiCallsEnabled:env.ENABLE_LIVE_FREE==='true'});
}
async function saveCredential(env,provider,req){
  if(!env?.DB)return dbUnavailable();
  const key=configuredMasterKey(env);
  if(!key)return json({error:{code:'VAULT_ROOT_NOT_CONFIGURED',message:'Workers Secret 저장소의 마스터 키가 설정되지 않았습니다.'}},503);
  const obj=await bodyJson(req);
  if(typeof obj.apiKey!=='string'||obj.apiKey.length<8||obj.apiKey.length>1024||/[\r\n\0]/.test(obj.apiKey))throw new InputError('API 키 형식을 확인하세요.');
  const encrypted=await encryptProviderKey(key,provider,obj.apiKey);
  const updatedAt=new Date().toISOString();
  await env.DB.prepare('INSERT INTO provider_credentials(owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,provider) DO UPDATE SET cipher_version=excluded.cipher_version,iv_b64=excluded.iv_b64,ciphertext_b64=excluded.ciphertext_b64,updated_at=excluded.updated_at')
    .bind('owner',provider,encrypted.version,encrypted.ivB64,encrypted.ciphertextB64,updatedAt).run();
  await credentialEvent(env,provider,'SET_OR_ROTATE');
  return json({provider,configured:true,updatedAt,verification:'NOT_RUN',keyNeverReturned:true});
}
async function deleteCredential(env,provider){
  if(!env?.DB)return dbUnavailable();
  await env.DB.prepare('DELETE FROM provider_credentials WHERE owner_id = ? AND provider = ?').bind('owner',provider).run();
  await credentialEvent(env,provider,'DELETE');
  return json({provider,configured:false,keyNeverReturned:true});
}
export async function routeApi(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/api/health'&&request.method==='GET')return json({service:'youtube-ai-analyzer-mvp',version:'0.7.0',mode:env?.ENABLE_LIVE_FREE==='true'?'LIVE_FREE_GATED':'MOCK_ONLY',deployed:env?.SITE_DEPLOYED==='true',productionReady:false,realCalls:env?.ENABLE_LIVE_FREE==='true'?null:false,storageConfigured:!!env?.DB});
    try{
      const live=await routeLive(request,env);if(live)return live;
      if(url.pathname==='/api/preflight'&&request.method==='POST')return json(preflight(await bodyJson(request)));
      if(url.pathname==='/api/jobs'&&request.method==='POST')return await handleJob(env,await bodyJson(request));
      if(url.pathname==='/api/jobs'&&request.method==='GET')return await listJobs(env,url);
      if(url.pathname==='/api/usage'&&request.method==='GET')return await handleUsage(env);
      if(url.pathname==='/api/settings/providers'&&request.method==='GET')return await listCredentialStatus(env);
      const secretMatch=url.pathname.match(/^\/api\/settings\/providers\/([a-z0-9-]+)\/secret$/);
      if(secretMatch){
        const provider=secretMatch[1];
        if(!providerAllowed(provider))return json({error:{code:'PROVIDER_NOT_SUPPORTED'}},404);
        if(request.method==='PUT')return await saveCredential(env,provider,request);
        if(request.method==='DELETE')return await deleteCredential(env,provider);
      }
      const jobMatch=url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
      if(jobMatch){
        if(!env?.DB)return dbUnavailable();
        const id=jobMatch[1];
        if(request.method==='GET'){
          const row=await env.DB.prepare('SELECT * FROM jobs WHERE id = ? AND owner_id = ?').bind(id,'owner').first();
          return row?json({job:{...row,report:JSON.parse(row.report_json||'null'),audit:JSON.parse(row.audit_json||'null')}}):json({error:{code:'NOT_FOUND'}},404);
        }
        if(request.method==='DELETE'){
          await env.DB.prepare('DELETE FROM jobs WHERE id = ? AND owner_id = ?').bind(id,'owner').run();
          return json({deleted:true,id});
        }
      }
      return json({error:{code:'NOT_FOUND'}},404);
    }catch(e){
      if(e instanceof InputError) return json({error:{code:e.code,message:e.message}},400);
      // Do not leak provider credentials, transcripts, or request bodies into logs.
      return json({error:{code:'INTERNAL_ERROR',message:'내부 처리 오류입니다.'}},500);
    }
}

// Legacy test-only entrypoint. Production wrangler config deploys site-worker.mjs,
// which verifies signed Cloudflare Access JWT before calling routeApi.
export default {async fetch(request,env){
  if(!isAuth(request,env))return deny();
  return routeApi(request,env);
}};
