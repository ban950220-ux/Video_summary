// Optional live adapters; disabled by default and NOT tested with real credentials.
import {InputError,videoIdOf} from './core.mjs';
export class ProviderError extends Error {constructor(code,message){super(message);this.code=code;}}
export function assertLive(env,provider){
  if(env?.ENABLE_LIVE_FREE!=='true') throw new ProviderError('LIVE_DISABLED','실제 제공자 호출은 기본적으로 비활성화 상태입니다.');
  if(env?.[`${provider}_FREE_PLAN_CONFIRMED`]!=='true') throw new ProviderError('PLAN_UNVERIFIED','해당 API 키가 무료 전용 계획인지 운영자 확인이 필요합니다.');
  if(env?.ALLOW_PAID_API==='true') throw new ProviderError('BUDGET_BLOCKED','MVP에서 유료 호출은 활성화할 수 없습니다.');
}
async function requestJson(url,options,fetchFn=fetch){
  const r=await fetchFn(url,{...options,signal:AbortSignal.timeout(120000)});
  if(!r.ok){const error=new ProviderError(String(r.status),`${new URL(url).hostname} HTTP ${r.status}`);if(new URL(url).hostname==='api.groq.com')error.safeRateLimit=safeGroqRateLimit(r.headers);throw error;}
  const data=await r.json();
  if(new URL(url).hostname==='api.groq.com'&&data&&typeof data==='object'&&!Array.isArray(data))data.safeRateLimit=safeGroqRateLimit(r.headers);
  return data;
}
function safeGroqRateLimit(headers){
 const number=(name,max)=>{const raw=headers.get(name);if(raw===null||!/^\d{1,8}$/.test(raw))return null;const value=Number(raw);return value<=max?value:null;};
 return {retryAfterSeconds:number('retry-after',3600),remainingRequests:number('x-ratelimit-remaining-requests',1000000),remainingAudioSeconds:number('x-ratelimit-remaining-audio-seconds',86400)};
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
  const res=await fetchFn(endpoint.toString(),{headers:{'x-api-key':env.SUPADATA_API_KEY},signal:AbortSignal.timeout(60000)});
  const billed=res.headers.has('x-billable-requests')?Number(res.headers.get('x-billable-requests')):NaN;
  const billedCredits=Number.isFinite(billed)&&billed>=0?billed:null;
  if(res.status===206) return {status:'NO_CAPTIONS',provider:'supadata',billedCredits,segments:[],usageProvenance:billedCredits===null?'UNKNOWN':'EXACT_APP'};
  if(!res.ok) throw new ProviderError(String(res.status),`Supadata HTTP ${res.status}`);
  const data=await res.json();
  if(data.jobId) return {status:'PENDING',jobId:data.jobId,billedCredits,provider:'supadata',segments:[]};
  const segments=(Array.isArray(data.content)?data.content:[]).map(s=>({text:String(s.text||''),startMs:Number(s.offset),endMs:Number(s.offset)+Number(s.duration)})).filter(s=>s.text&&Number.isFinite(s.startMs)&&Number.isFinite(s.endMs)&&s.endMs>s.startMs);
  return {status:'TRANSCRIPT_AVAILABLE',provider:'supadata',segments,language:data.lang||null,billedCredits,usageProvenance:billedCredits===null?'UNKNOWN':'EXACT_APP'};
}

export async function transcribeOwnedAudio({bytes,name,mime,durationSeconds,env,fetchFn=fetch,beforeFetch}){
  assertLive(env,'GROQ');
  if(!env.GROQ_API_KEY) throw new ProviderError('KEY_MISSING','Groq API 키 미설정');
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>24_000_000 || bytes.byteLength===0) throw new InputError('파일은 비어있지 않은 24MB 이하 음성이어야 합니다.','AUDIO_SIZE');
  if(!/\.(mp3|mp4|m4a|ogg|wav|webm|flac)$/i.test(name)) throw new InputError('지원하지 않는 음성 확장자','AUDIO_FORMAT');
  // This upload path is intentionally only a building block; the route must reserve quota BEFORE invoking it.
  const data=new FormData();data.append('file',new Blob([bytes],{type:mime||'application/octet-stream'}),name);
  data.append('model','whisper-large-v3-turbo');data.append('response_format','verbose_json');data.append('temperature','0');data.append('timestamp_granularities[]','segment');
  await beforeFetch?.();
  const result=await requestJson('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${env.GROQ_API_KEY}`},body:data},fetchFn);
  return {provider:'groq',model:'whisper-large-v3-turbo',text:result.text,segments:result.segments||[],durationSeconds,usageProvenance:'EXACT_APP_FILE_DURATION',safeRateLimit:result.safeRateLimit};
}
function safeGroqSummaryHeaders(headers){
 const integer=(name,max)=>{const value=headers.get(name);return value!==null&&/^\d{1,9}$/.test(value)&&Number(value)<=max?Number(value):null;};
 const reset=headers.get('x-ratelimit-reset-tokens');
 return {retryAfterSeconds:integer('retry-after',3600),remainingRequests:integer('x-ratelimit-remaining-requests',1_000_000),remainingTokens:integer('x-ratelimit-remaining-tokens',1_000_000),tokenReset:typeof reset==='string'&&/^\d{1,5}(?:\.\d{1,2})?s$/.test(reset)?reset:null};
}
export async function summarizeTranscriptWithGroq({env,messages,maxCompletionTokens,fetchFn=fetch,beforeFetch}){
 assertLive(env,'GROQ');
 if(!env.GROQ_API_KEY)throw new ProviderError('KEY_MISSING','Groq API 키 미설정');
 if(!Array.isArray(messages)||messages.length!==2||!Number.isSafeInteger(maxCompletionTokens)||maxCompletionTokens<1||maxCompletionTokens>1800)throw new InputError('Groq 요약 요청 범위 오류');
 const body={model:'openai/gpt-oss-120b',messages,response_format:{type:'json_object'},reasoning_effort:'low',max_completion_tokens:maxCompletionTokens,temperature:0,stream:false};
 await beforeFetch?.();
 const response=await fetchFn('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${env.GROQ_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
 const safeRateLimit=safeGroqSummaryHeaders(response.headers);
 if(!response.ok){const error=new ProviderError(String(response.status),`api.groq.com HTTP ${response.status}`);error.safeRateLimit=safeRateLimit;throw error;}
 let result;try{result=await response.json();}catch{throw new ProviderError('SUMMARY_RESPONSE_INVALID','요약 응답 JSON을 확인할 수 없습니다.');}
 const choice=result?.choices?.[0],usage=result?.usage,number=value=>Number.isSafeInteger(value)&&value>=0;
 const reasoningTokens=usage?.completion_tokens_details?.reasoning_tokens??usage?.reasoning_tokens??null;
 if(result?.model!=='openai/gpt-oss-120b'||choice?.finish_reason!=='stop'||typeof choice?.message?.content!=='string'||!choice.message.content.trim()||choice.message.tool_calls?.length||choice.message.function_call||!number(usage?.prompt_tokens)||!number(usage?.completion_tokens)||!number(usage?.total_tokens)||usage.total_tokens<usage.prompt_tokens+usage.completion_tokens||usage.completion_tokens>maxCompletionTokens||(reasoningTokens!==null&&(!number(reasoningTokens)||reasoningTokens>usage.completion_tokens))){
  const error=new ProviderError('SUMMARY_FINISH_UNVERIFIED','요약 종료 상태·모델·실제 사용량을 검토하세요.');
  error.reviewResult={model:result?.model??null,finishReason:choice?.finish_reason??null,partialText:typeof choice?.message?.content==='string'?choice.message.content.slice(0,12000):null,usage:number(usage?.prompt_tokens)&&number(usage?.completion_tokens)&&number(usage?.total_tokens)?{inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens,reasoningTokens:number(reasoningTokens)?reasoningTokens:null,totalTokens:usage.total_tokens}:null};
  error.safeRateLimit=safeRateLimit;
  throw error;
 }
 return {text:choice.message.content,model:result.model,inputTokens:usage.prompt_tokens,completionTokens:usage.completion_tokens,totalTokens:usage.total_tokens,usage:{inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens,reasoningTokens,totalTokens:usage.total_tokens},safeRateLimit};
}
function base64Audio(bytes){let out='';for(let i=0;i<bytes.length;i+=12288){const slice=bytes.subarray(i,i+12288);out+=btoa(String.fromCharCode(...slice));}return out;}
function assertGeminiDeadlinesAtFetch(env){if(env.quotaExpiresAt===undefined&&env.capacityValidUntil===undefined)return;if(!Number.isFinite(env.quotaExpiresAt)||env.quotaExpiresAt<=Date.now()||!Number.isFinite(env.capacityValidUntil)||env.capacityValidUntil<=Date.now()){const error=new ProviderError('CAPACITY_WAIT','제공자 관측치 또는 무료 허가가 전송 직전에 만료됐습니다.');error.preDispatchBlocked=true;throw error;}}
export async function transcribeOwnedAudioWithGemini({bytes,durationSeconds,env,fetchFn=fetch,beforeFetch}){
  assertLive(env,'GEMINI');
  if(!env.GEMINI_API_KEY)throw new ProviderError('KEY_MISSING','Gemini API 키 미설정');
  if(!(bytes instanceof Uint8Array)||bytes.length<100||bytes.length>8_000_000||!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>600)throw new InputError('Gemini 음성 조각의 형식·크기·길이를 확인하세요.');
  const prompt='보유자가 제공한 이 음성 조각의 말을 원어 그대로 빠짐없이 전사하세요. 조각 시작을 0초로 하는 상대 시각을 사용하세요. JSON 객체 하나만 출력하고 segments 배열의 각 항목은 start(초 숫자), end(초 숫자), text(문자열)입니다. 들리지 않는 부분을 지어내지 말고 요약하거나 번역하지 마세요.';
  const body={contents:[{role:'user',parts:[{text:prompt},{inlineData:{mimeType:'audio/mp3',data:base64Audio(bytes)}}]}],generationConfig:{temperature:0,responseMimeType:'application/json',maxOutputTokens:8192,thinkingConfig:{thinkingBudget:0}}};
  if(JSON.stringify(body).length>19_000_000)throw new InputError('Gemini 인라인 요청은 20MB 미만이어야 합니다.');
  await beforeFetch?.();
  assertGeminiDeadlinesAtFetch(env);
  const data=await requestJson('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',{method:'POST',headers:{'x-goog-api-key':env.GEMINI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body)},fetchFn);
  const candidate=data.candidates?.[0],raw=candidate?.content?.parts?.map(part=>part.text||'').join('')||'';
  const reviewResult={provider:'gemini',finishReason:candidate?.finishReason??null,partialText:raw.slice(0,12000),durationSeconds};
  const reviewError=(code,message)=>{const error=new ProviderError(code,message);error.reviewResult=reviewResult;return error;};
  if(candidate?.finishReason!=='STOP')throw reviewError('AUDIO_FINISH_UNVERIFIED','Gemini 응답이 정상적으로 끝나지 않았습니다. 부분 출력을 검토하세요.');
  let parsed;try{parsed=JSON.parse(raw);}catch{throw reviewError('AUDIO_RESPONSE_INVALID','Gemini 전사 JSON을 확인할 수 없습니다. 재호출 전 사용량을 검토하세요.');}
  if(!Array.isArray(parsed.segments)||parsed.segments.length<1||parsed.segments.length>500)throw reviewError('AUDIO_RESPONSE_INVALID','Gemini 전사 구간을 확인할 수 없습니다.');
  const segments=parsed.segments.map(part=>({start:Number(part.start),end:Number(part.end),text:String(part.text||'').trim()}));
  if(segments.some((part,i)=>!Number.isFinite(part.start)||!Number.isFinite(part.end)||part.start<0||part.end<=part.start||part.end>durationSeconds+1||!part.text||part.text.length>2000||(i&&part.start<segments[i-1].start)))throw reviewError('AUDIO_RESPONSE_INVALID','Gemini 전사 시간축을 확인할 수 없습니다.');
  if(durationSeconds>=60&&(segments[0].start>Math.min(15,durationSeconds*.1)||segments.at(-1).end<durationSeconds-Math.min(15,durationSeconds*.1)))throw reviewError('AUDIO_COVERAGE_UNVERIFIED','Gemini 전사가 음성 조각의 시작과 끝을 충분히 포함하지 않습니다. 부분 출력을 검토하세요.');
  return {provider:'gemini',model:'gemini-2.5-flash',segments,text:segments.map(part=>part.text).join('\n'),durationSeconds,usageProvenance:'PROVIDER_RESPONSE',usage:data.usageMetadata??null};
}
export async function summarizeTranscriptWithGemini(text,env,fetchFn=fetch,beforeFetch){
  assertLive(env,'GEMINI');
  if(!env.GEMINI_API_KEY) throw new ProviderError('KEY_MISSING','Gemini API 키 미설정');
  if(typeof text!=='string'||text.length>190_000) throw new InputError('텍스트 길이 제한을 초과했습니다.');
  const model='gemini-2.5-flash';
  const instruction=env.SUMMARY_JSON==='true'?text:`아래 전사문에서만 근거를 찾아 한국어로 정확히 요약하라. 불확실한 숫자/발언은 명시하라. 입력에 없는 인용구를 생성하지 말라. 영어인 경우 한국어로 번역하라.\n\n${text}`;
  const body={contents:[{role:'user',parts:[{text:instruction}]}],generationConfig:{temperature:0.2,maxOutputTokens:env.SUMMARY_STAGE_OUTPUT_TOKENS==='2048'?2048:8192,thinkingConfig:{thinkingBudget:0},...(env.SUMMARY_JSON==='true'?{responseMimeType:'application/json'}:{})}};
  await beforeFetch?.();
  assertGeminiDeadlinesAtFetch(env);
  const result=await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:'POST',headers:{'x-goog-api-key':env.GEMINI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body)},fetchFn);
  const candidate=result.candidates?.[0],outputText=candidate?.content?.parts?.map(x=>x.text||'').join('')||'';
  if(candidate?.finishReason!=='STOP'){const error=new ProviderError('SUMMARY_FINISH_UNVERIFIED','Gemini 요약 응답이 정상적으로 끝나지 않았습니다. 부분 출력을 검토하세요.');error.reviewResult={provider:'gemini',finishReason:candidate?.finishReason??null,partialText:outputText.slice(0,12000)};throw error;}
  return {provider:'gemini',text:outputText,usage:result.usageMetadata??null};
}

export async function pollSupadataCaption(jobId,env,fetchFn=fetch){
 assertLive(env,'SUPADATA');if(typeof jobId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(jobId))throw new InputError('제공자 작업 ID 오류');
 const data=await requestJson('https://api.supadata.ai/v1/transcript/'+encodeURIComponent(jobId),{headers:{'x-api-key':env.SUPADATA_API_KEY}},fetchFn);
 if(data.status==='failed')return {status:'NO_CAPTIONS',segments:[]};
 if(data.status!=='completed')return {status:'PENDING',jobId,segments:[]};
 const result=data.result||data;const segments=(Array.isArray(result.content)?result.content:[]).map(s=>({text:String(s.text||''),startMs:Number(s.offset),endMs:Number(s.offset)+Number(s.duration)})).filter(s=>s.text&&Number.isFinite(s.startMs)&&s.endMs>s.startMs);
 return {status:segments.length?'TRANSCRIPT_AVAILABLE':'NO_CAPTIONS',segments,provider:'supadata'};
}
