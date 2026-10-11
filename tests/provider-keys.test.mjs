import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptProviderKey} from '../src/vault.mjs';
import {resolveProviderKey,runNativeCaption,runTranscriptSummary,runOwnedAudioTranscription} from '../src/provider-keys.mjs';

const root=Buffer.alloc(32,31).toString('base64');
const mockKey={supadata:'mock-supadata-123456',gemini:'mock-gemini-123456',groq:'mock-groq-123456'};
const rows=new Map();
const DB={prepare(sql){assert.match(sql,/SELECT cipher_version,iv_b64,ciphertext_b64 FROM provider_credentials/);return {bind(owner,provider){assert.equal(owner,'owner');return {first:async()=>rows.get(provider)||null};}}}};
const env={DB,KEY_ENCRYPTION_KEY_B64:root,ENABLE_LIVE_FREE:'true',ALLOW_PAID_API:'false',SUPADATA_FREE_PLAN_CONFIRMED:'true',GEMINI_FREE_PLAN_CONFIRMED:'true',GROQ_FREE_PLAN_CONFIRMED:'true'};
async function store(p){const crypt=await encryptProviderKey(Buffer.alloc(32,31),p,mockKey[p]);rows.set(p,{cipher_version:crypt.version,iv_b64:crypt.ivB64,ciphertext_b64:crypt.ciphertextB64});}

test('site-encrypted key can be used inside the server but never returned in provider results',async()=>{
  await store('supadata');
  let endpoint,observedKey;
  const res=await runNativeCaption({env,url:'https://youtu.be/2hUkTmwYm3A',fetchFn:async(u,opts)=>{endpoint=u;observedKey=opts.headers['x-api-key'];return Response.json({content:[{offset:0,duration:1234,text:'원문 발언'}]},{headers:{'x-billable-requests':'1'}});}});
  assert.equal(observedKey,mockKey.supadata);
  assert.equal(new URL(endpoint).searchParams.get('mode'),'native');
  assert.equal(res.status,'TRANSCRIPT_AVAILABLE');
  assert.equal(res.billedCredits,1);
  assert.doesNotMatch(JSON.stringify(res),/mock-supadata/);
});
test('free-tier gate blocks before decrypting or sending API traffic',async()=>{
  let hits=0;
  await assert.rejects(()=>runNativeCaption({env:{...env,ENABLE_LIVE_FREE:'false'},url:'https://youtu.be/2hUkTmwYm3A',fetchFn:async()=>{hits++;return Response.json({});}}),e=>e.code==='LIVE_DISABLED');
  await assert.rejects(()=>resolveProviderKey({...env,GEMINI_FREE_PLAN_CONFIRMED:'false'},'gemini'),e=>e.code==='PLAN_UNVERIFIED');
  assert.equal(hits,0);
});
test('Gemini transcript summary uses site-managed key transiently, never browser-visible',async()=>{
  await store('gemini');let apiKey,model;
  const result=await runTranscriptSummary({env,text:'A documented English subtitle sample.',fetchFn:async(u,opts)=>{model=u;apiKey=opts.headers['x-goog-api-key'];return Response.json({candidates:[{content:{parts:[{text:'한국어 요약(모의 응답)'}]}}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:4}});}});
  assert.equal(apiKey,mockKey.gemini);
  assert.match(model,/generateContent/);
  assert.equal(result.text,'한국어 요약(모의 응답)');
  assert.doesNotMatch(JSON.stringify(result),/mock-gemini/);
});
test('Groq owner audio adapter resolves encrypted key without raw key in results',async()=>{
  await store('groq');let token;
  const result=await runOwnedAudioTranscription({env,bytes:new Uint8Array([1,2,3]),name:'test.mp3',mime:'audio/mpeg',durationSeconds:1,fetchFn:async(_,options)=>{token=options.headers.Authorization;return Response.json({text:'안녕',segments:[]});}});
  assert.equal(token,`Bearer ${mockKey.groq}`);assert.equal(result.text,'안녕');
  assert.doesNotMatch(JSON.stringify(result),/mock-groq/);
});
test('vault rejection: wrong master key, unsupported provider, and no configured connection',async()=>{
  await store('supadata');
  await assert.rejects(()=>resolveProviderKey({...env,KEY_ENCRYPTION_KEY_B64:Buffer.alloc(32,13).toString('base64')},'supadata'),e=>e.code==='VAULT_DECRYPT_FAILED');
  await assert.rejects(()=>resolveProviderKey(env,'unknown'),e=>e.code==='PROVIDER_NOT_SUPPORTED');
  await assert.rejects(()=>resolveProviderKey(env,'assemblyai'),e=>e.code==='PLAN_UNVERIFIED');
});

test('Groq fetch boundary rechecks expiry after multipart preparation',async()=>{
 await store('groq');let calls=0,checks=0;
 await assert.rejects(()=>runOwnedAudioTranscription({env,bytes:new Uint8Array([1,2,3]),name:'test.mp3',mime:'audio/mpeg',durationSeconds:1,beforeDispatch:()=>{checks++;},beforeFetch:()=>{checks++;const error=new Error('EXPIRED_BEFORE_FETCH');error.preDispatchBlocked=true;throw error;},fetchFn:async()=>{calls++;return Response.json({});}}),/EXPIRED_BEFORE_FETCH/);
 assert.equal(checks,2);assert.equal(calls,0);
});
