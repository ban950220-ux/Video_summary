import {ProviderError} from './adapters.mjs';
import {configuredMasterKey,decryptProviderKey} from './vault.mjs';
import {PAID_SUMMARY_CATALOG,paidExecutionAllowed,checkedPaidWireBody} from './paid-summary-contract.mjs';
import {PAID_RECEIPT_MAX_BYTES} from './paid-summary-receipt.mjs';

// This adapter is reachable only through a separately enabled paid contract route.
// Tests inject fetchFn. No paid API is invoked by importing this module.
export async function runPaidGeminiFullSummary({env,body,quote,firstTrial=false,fetchFn=fetch,beforeFetch,recordResponse,recordEnvelope}){
 if(!paidExecutionAllowed(env,firstTrial))throw new ProviderError('PAID_EXECUTION_DISABLED','유료 요약 실행은 비활성입니다.');
 const row=await env.DB.prepare('SELECT cipher_version,iv_b64,ciphertext_b64 FROM provider_credentials WHERE owner_id=? AND provider=?').bind('owner','gemini').first();
 const root=configuredMasterKey(env);if(!row||!root)throw new ProviderError('PAID_CREDENTIAL_UNAVAILABLE','저장된 Gemini 연결을 확인하세요.');
 let key;try{key=await decryptProviderKey(root,'gemini',{version:row.cipher_version,ivB64:row.iv_b64,ciphertextB64:row.ciphertext_b64});}catch{throw new ProviderError('PAID_CREDENTIAL_UNAVAILABLE','저장된 Gemini 연결을 확인하세요.');}
 const serialized=await checkedPaidWireBody(body,quote);
 await beforeFetch?.();
 let response;try{response=await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${PAID_SUMMARY_CATALOG.model}:generateContent`,{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},body:serialized});}catch{throw new ProviderError('PAID_PROVIDER_UNCERTAIN','제공자 응답이 확인되지 않았습니다. 예약을 유지하고 사용량을 확인하세요.');}
 // Count bytes actually received. Never rely on Content-Length or save a prefix as a full response.
 let chunks=[],received=0,complete=false,responseText;
 try{
  const reader=response.body?.getReader();if(!reader)throw Error('NO_RESPONSE_BODY');
  while(true){const {done,value}=await reader.read();if(done){complete=true;break;}received+=value.byteLength;if(received>PAID_RECEIPT_MAX_BYTES){await reader.cancel();break;}chunks.push(value);}
  if(complete){const bytes=new Uint8Array(received);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}responseText=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
 }catch{complete=false;}
 if(!complete){await recordResponse?.({responseText:null,responseBytes:received,httpStatus:response.status,complete:false,errorCode:received>PAID_RECEIPT_MAX_BYTES?'PAID_RESPONSE_TOO_LARGE':'PAID_RESPONSE_INCOMPLETE'});throw new ProviderError(received>PAID_RECEIPT_MAX_BYTES?'PAID_RESPONSE_TOO_LARGE':'PAID_PROVIDER_UNCERTAIN','제공자 응답 전체를 보존할 수 없습니다.');}
 if(!recordResponse)throw new ProviderError('PAID_RECEIPT_GUARD_MISSING','응답 보존 경로가 없습니다.');
 await recordResponse({responseText,responseBytes:received,httpStatus:response.status,complete:true});
 let data;try{data=JSON.parse(responseText);}catch{await recordEnvelope?.({state:'ENVELOPE_INVALID',errorCode:'PAID_RESPONSE_INVALID'});throw new ProviderError('PAID_RESPONSE_INVALID','제공자 응답 JSON을 검토하세요.');}
 const candidate=data.candidates?.[0],output=candidate?.content?.parts?.map(part=>part.text||'').join('')||'';
 const usage=data.usageMetadata??null;
 await recordEnvelope?.({state:response.status===200&&candidate?.finishReason==='STOP'&&output?'RECEIVED':'ENVELOPE_INVALID',errorCode:response.status===200&&candidate?.finishReason==='STOP'&&output?null:'PAID_PROVIDER_UNCERTAIN',modelVersion:data.modelVersion??null,finishReason:candidate?.finishReason??null,usage});
 if(response.status!==200||candidate?.finishReason!=='STOP'||!output)throw new ProviderError('PAID_PROVIDER_UNCERTAIN','종합 요약 완료 여부를 확인할 수 없습니다.');
 return {text:output,usage,modelVersion:data.modelVersion??null};
}
