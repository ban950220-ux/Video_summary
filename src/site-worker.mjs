import {verifyOwnerAccess,sameOriginMutation,authConfigured} from './access.mjs';
import {routeApi} from './worker.mjs';

const HEADERS={
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer',
  'x-frame-options':'DENY',
  'permissions-policy':'camera=(), microphone=(), geolocation=()',
  'strict-transport-security':'max-age=31536000; includeSubDomains',
  'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
function respond(obj,status=401){return new Response(JSON.stringify({error:obj}),{status,headers:{...HEADERS,'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
function secured(response,html=false,manifest=false){
  const headers=new Headers(response.headers);
  for(const [key,value] of Object.entries(HEADERS))headers.set(key,value);
  if(html)headers.set('cache-control','private, no-store');
  if(manifest)headers.set('content-type','application/manifest+json; charset=utf-8');
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}

export async function handleSiteRequest(request,env,dependencies){
  if(!authConfigured(env))return respond({code:'ACCESS_NOT_CONFIGURED',message:'Access 이메일·도메인·AUD 설정이 필요합니다.'},503);
  const access=await verifyOwnerAccess(request,env,dependencies);
  if(!access.ok)return respond({code:access.reason,message:'본인 인증이 필요합니다.'},401);
  if(!sameOriginMutation(request))return respond({code:'CSRF_BLOCKED',message:'현재 사이트에서 보낸 JSON 요청만 허용합니다.'},403);
  const url=new URL(request.url);
  if(url.pathname.startsWith('/api/'))return secured(await routeApi(request,env));
  if(request.method!=='GET' && request.method!=='HEAD')return respond({code:'METHOD_NOT_ALLOWED'},405);
  if(!env.ASSETS?.fetch)return respond({code:'ASSETS_NOT_CONFIGURED'},503);
  const asset=await env.ASSETS.fetch(request);
  const protectedDocument=url.pathname==='/' || url.pathname.endsWith('.html') || url.pathname==='/app.webmanifest';
  return secured(asset,protectedDocument,url.pathname==='/app.webmanifest');
}
export default {fetch:handleSiteRequest};
