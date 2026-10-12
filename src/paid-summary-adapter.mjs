import {ProviderError} from './adapters.mjs';
import {configuredMasterKey,decryptProviderKey} from './vault.mjs';
import {PAID_SUMMARY_CATALOG,paidExecutionEnabled} from './paid-summary-contract.mjs';

// This adapter is reachable only through a separately enabled paid contract route.
// Tests inject fetchFn. No paid API is invoked by importing this module.
export async function runPaidGeminiFullSummary({env,body,fetchFn=fetch,beforeFetch}){
 if(!paidExecutionEnabled(env))throw new ProviderError('PAID_EXECUTION_DISABLED','유료 요약 실행은 비활성입니다.');
 const row=await env.DB.prepare('SELECT cipher_version,iv_b64,ciphertext_b64 FROM provider_credentials WHERE owner_id=? AND provider=?').bind('owner','gemini').first();
 const root=configuredMasterKey(env);if(!row||!root)throw new ProviderError('PAID_CREDENTIAL_UNAVAILABLE','저장된 Gemini 연결을 확인하세요.');
 let key;try{key=await decryptProviderKey(root,'gemini',{version:row.cipher_version,ivB64:row.iv_b64,ciphertextB64:row.ciphertext_b64});}catch{throw new ProviderError('PAID_CREDENTIAL_UNAVAILABLE','저장된 Gemini 연결을 확인하세요.');}
 await beforeFetch?.();
 let response;try{response=await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${PAID_SUMMARY_CATALOG.model}:generateContent`,{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:JSON.stringify(body)});}catch{throw new ProviderError('PAID_PROVIDER_UNCERTAIN','제공자 응답이 확인되지 않았습니다. 예약을 유지하고 사용량을 확인하세요.');}
 let data;try{data=await response.json();}catch{throw new ProviderError('PAID_PROVIDER_UNCERTAIN','제공자 응답을 확인할 수 없습니다.');}
 if(!response.ok)throw new ProviderError('PAID_PROVIDER_UNCERTAIN','제공자 호출 결과와 청구 여부를 확인하세요.');
 const candidate=data.candidates?.[0],output=candidate?.content?.parts?.map(part=>part.text||'').join('')||'';
 if(candidate?.finishReason!=='STOP'||!output)throw new ProviderError('PAID_PROVIDER_UNCERTAIN','종합 요약 완료 여부를 확인할 수 없습니다.');
 const usage=data.usageMetadata??null;
 return {text:output,usage,modelVersion:data.modelVersion??null};
}
