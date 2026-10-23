// Fixed-target Cloudflare API transport. Credential acquisition/storage and
// OAuth refresh are deliberately absent. The caller supplies an already approved
// credential in memory. Dependency injection is for trusted local tests only.
import {target} from './schema-baseline-registration.mjs';
const origin='https://api.cloudflare.com';
const base=`${origin}/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}`;
const fail=code=>{throw Object.assign(new Error(code),{code});};

// REST documents string params. Preserve integer comparison semantics instead
// of silently binding a JS timestamp as SQLite TEXT. Never interpolate values.
export function restStatement(sql,args){
 if(typeof sql!=='string'||!Array.isArray(args)||args.some(x=>typeof x!=='string'&&!Number.isSafeInteger(x)))fail('BASELINE_SQL_BINDING_INVALID');
 let out='',index=0;
 for(let i=0;i<sql.length;i++){
  const ch=sql[i];
  if(ch==='\''||ch==='"'||ch==='`'||ch==='['){
   const end=ch==='['?']':ch;out+=ch;let closed=false;
   while(++i<sql.length){out+=sql[i];if(sql[i]!==end)continue;if(end!==']'&&sql[i+1]===end){out+=sql[++i];continue;}closed=true;break;}
   if(!closed)fail('BASELINE_SQL_BINDING_INVALID');
  }else if(ch==='?'){
   if(index>=args.length||/\d/.test(sql[i+1]??''))fail('BASELINE_SQL_BINDING_INVALID');
   out+=typeof args[index++]==='number'?'CAST(? AS INTEGER)':'?';
  }else out+=ch;
 }
 if(index!==args.length)fail('BASELINE_SQL_BINDING_INVALID');
 return {sql:out,params:args.map(String)};
}

export function createBaselineCloudflareTransport({credential,fetcher=fetch,signal}={}){
 if(typeof credential!=='string'||credential.length<16||credential.length>8192||/[\s\r\n\0]/.test(credential))fail('BASELINE_EXISTING_CREDENTIAL_REQUIRED');
 let bearer=credential,closed=false;
 async function call(suffix,body){
  if(closed||signal?.aborted)fail('BASELINE_TRANSPORT_CLOSED');
  const url=base+suffix,timeout=AbortSignal.timeout(15000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  try{
   const response=await fetcher(url,{method:body===undefined?'GET':'POST',redirect:'error',credentials:'omit',cache:'no-store',signal:combined,headers:{Authorization:`Bearer ${bearer}`,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
   if(!response.ok||response.redirected||(response.url&&response.url!==url)||!/^application\/json(?:;|$)/i.test(response.headers.get('content-type')??''))fail('BASELINE_REMOTE_RESPONSE_INVALID');
   const reader=response.body?.getReader();if(!reader)fail('BASELINE_REMOTE_RESPONSE_INVALID');
   const chunks=[];let length=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2_000_000){await reader.cancel();fail('BASELINE_REMOTE_RESPONSE_INVALID');}chunks.push(value);}}finally{reader.releaseLock();}
   const bytes=Buffer.concat(chunks),data=JSON.parse(bytes.toString('utf8'));
   if(data.success!==true||!Object.hasOwn(data,'result'))fail('BASELINE_REMOTE_RESPONSE_INVALID');
   return data.result;
  }catch{fail('BASELINE_REMOTE_REQUEST_UNCONFIRMED');} // No remote text/token in errors.
 }
 async function identity(){
  const data=await call('?fields=uuid,name');
  if(data?.uuid!==target.databaseId||data?.name!=='youtube-ai-analyzer-private-db')fail('BASELINE_REMOTE_TARGET_MISMATCH');
  return {...target,databaseName:data.name};
 }
 async function bookmark(at){
  if(typeof at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at)||!Number.isFinite(Date.parse(at)))fail('BASELINE_BOOKMARK_TIME_INVALID');
  const data=await call('/time_travel/bookmark?timestamp='+encodeURIComponent(at));
  if(typeof data?.bookmark!=='string'||!/^[0-9a-f-]{16,256}$/.test(data.bookmark))fail('BASELINE_BOOKMARK_INVALID');
  return data.bookmark;
 }
 async function queries(statements){
  const result=await call('/query',{batch:statements.map(s=>restStatement(s.sql,s.args))});
  if(!Array.isArray(result)||result.length!==statements.length||result.some(r=>r?.success!==true||!Array.isArray(r.results)))fail('BASELINE_QUERY_RESULT_INVALID');
  return result;
 }
 return Object.freeze({identity,bookmark,queries,close(){closed=true;bearer='';}});
}
