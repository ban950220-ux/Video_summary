// Optional live adapters; disabled by default and NOT tested with real credentials.
import {InputError,videoIdOf} from './core.mjs';
export class ProviderError extends Error {constructor(code,message){super(message);this.code=code;}}
export function assertLive(env,provider){
  if(env?.ENABLE_LIVE_FREE!=='true') throw new ProviderError('LIVE_DISABLED','실제 제공자 호출은 기본적으로 비활성화 상태입니다.');
  if(env?.[`${provider}_FREE_PLAN_CONFIRMED`]!=='true') throw new ProviderError('PLAN_UNVERIFIED','해당 API 키가 무료 전용 계획인지 운영자 확인이 필요합니다.');
  if(env?.ALLOW_PAID_API==='true') throw new ProviderError('BUDGET_BLOCKED','MVP에서 유료 호출은 활성화할 수 없습니다.');
}
async function requestJson(url,options,fetchFn=fetch){
  const r=await fetchFn(url,options);
  if(!r.ok) throw new ProviderError(String(r.status),`${new URL(url).hostname} HTTP ${r.status}`);
  return await r.json();
}
export async function fetchSupadataCaption(url,env,fetchFn=fetch){
  assertLive(env,'SUPADATA');
  if(!env.SUPADATA_API_KEY) throw new ProviderError('KEY_MISSING','Supadata API 키 미설정');
  const id=videoIdOf(url);
  // Supadata docs: explicit mode=native ONLY uses existing captions and never AI-generates audio.
  // A 206 'transcript unavailable' still consumes one credit, so meter it as a charge.
  const endpoint=new URL('https://api.supadata.ai/v1/transcript');
  endpoint.searchParams.set('url',`https://www.youtube.com/watch?v=${id}`);
  endpoint.searchParams.set('mode','native');
  endpoint.searchParams.set('text','false');
  const res=await fetchFn(endpoint.toString(),{headers:{'x-api-key':env.SUPADATA_API_KEY}});
  const billed=Number(res.headers.get('x-billable-requests'));
  const billedCredits=Number.isFinite(billed)&&billed>=0?billed:null;
  if(res.status===206) return {status:'NO_CAPTIONS',provider:'supadata',billedCredits,segments:[],usageProvenance:billedCredits===null?'UNKNOWN':'EXACT_APP'};
  if(!res.ok) throw new ProviderError(String(res.status),`Supadata HTTP ${res.status}`);
  const data=await res.json();
  if(data.jobId) return {status:'PENDING',jobId:data.jobId,billedCredits,provider:'supadata',segments:[]};
  const segments=(Array.isArray(data.content)?data.content:[]).map(s=>({text:String(s.text||''),startMs:Number(s.offset),endMs:Number(s.offset)+Number(s.duration)})).filter(s=>s.text&&Number.isFinite(s.startMs)&&Number.isFinite(s.endMs)&&s.endMs>s.startMs);
  return {status:'TRANSCRIPT_AVAILABLE',provider:'supadata',segments,language:data.lang||null,billedCredits,usageProvenance:billedCredits===null?'UNKNOWN':'EXACT_APP'};
}

export async function transcribeOwnedAudio({bytes,name,mime,durationSeconds,env,fetchFn=fetch}){
  assertLive(env,'GROQ');
  if(!env.GROQ_API_KEY) throw new ProviderError('KEY_MISSING','Groq API 키 미설정');
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>24_000_000 || bytes.byteLength===0) throw new InputError('파일은 비어있지 않은 24MB 이하 음성이어야 합니다.','AUDIO_SIZE');
  if(!/\.(mp3|mp4|m4a|ogg|wav|webm|flac)$/i.test(name)) throw new InputError('지원하지 않는 음성 확장자','AUDIO_FORMAT');
  // This upload path is intentionally only a building block; the route must reserve quota BEFORE invoking it.
  const data=new FormData();data.append('file',new Blob([bytes],{type:mime||'application/octet-stream'}),name);
  data.append('model','whisper-large-v3-turbo');data.append('response_format','verbose_json');
  const result=await requestJson('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${env.GROQ_API_KEY}`},body:data},fetchFn);
  return {provider:'groq',text:result.text,segments:result.segments||[],durationSeconds,usageProvenance:'EXACT_APP_FILE_DURATION'};
}
export async function summarizeTranscriptWithGemini(text,env,fetchFn=fetch){
  assertLive(env,'GEMINI');
  if(!env.GEMINI_API_KEY) throw new ProviderError('KEY_MISSING','Gemini API 키 미설정');
  if(typeof text!=='string'||text.length>100_000) throw new InputError('텍스트 길이 제한(10만자)을 초과했습니다.');
  const model='gemini-3.5-flash-lite';
  const body={contents:[{role:'user',parts:[{text:`아래 전사문에서만 근거를 찾아 한국어로 정확히 요약하라. 불확실한 숫자/발언은 명시하라. 입력에 없는 인용구를 생성하지 말라. 영어인 경우 한국어로 번역하라.\n\n${text}`}]}]};
  const result=await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:'POST',headers:{'x-goog-api-key':env.GEMINI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body)},fetchFn);
  return {provider:'gemini',text:result.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('')||'',usage:result.usageMetadata??null};
}
