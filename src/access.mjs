// Fail-closed Cloudflare Access JWT verifier, no browser bearer tokens.
// Confirmed login is checked cryptographically even if the Access proxy is bypassed.
const jwksCache=new Map();
const utf8=new TextEncoder();
const decoder=new TextDecoder();

function decodePart(value){
  if(typeof value!=='string'||value.length>24_000||!/^[A-Za-z0-9_-]+$/.test(value))throw Error('INVALID_JWT');
  const bytes=Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)),c=>c.charCodeAt(0));
  return bytes;
}
function parsedJson(bytes){
  return JSON.parse(decoder.decode(bytes));
}
export function authConfigured(env){
  return typeof env.ACCESS_TEAM_DOMAIN==='string'&&/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN)&&
    typeof env.ACCESS_AUD==='string'&&env.ACCESS_AUD.length>=12&&
    typeof env.ACCESS_OWNER_EMAIL==='string'&&/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.ACCESS_OWNER_EMAIL);
}
async function fetchKeys(domain,kid,fetcher,nowMs){
  let cache=jwksCache.get(domain);
  if(cache && cache.expires>nowMs && cache.keys.some(k=>k.kid===kid))return cache.keys;
  const response=await fetcher(`${domain}/cdn-cgi/access/certs`,{headers:{Accept:'application/json'}});
  if(!response.ok)throw Error('ACCESS_JWKS_UNAVAILABLE');
  const obj=await response.json();
  if(!Array.isArray(obj.keys)||obj.keys.length>100)throw Error('ACCESS_JWKS_INVALID');
  const keys=obj.keys.filter(k=>k.kty==='RSA'&&k.alg!=='none'&&typeof k.n==='string'&&typeof k.e==='string'&&typeof k.kid==='string');
  jwksCache.set(domain,{keys,expires:nowMs+5*60_000});
  return keys;
}
function readJwt(request){
  const assertion=request.headers.get('cf-access-jwt-assertion');
  if(assertion)return assertion;
  const cookie=request.headers.get('cookie')??'';
  const match=cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match?match[1]:null;
}
export async function verifyOwnerAccess(request,env,{fetcher=fetch,nowMs=Date.now()}={}){
  if(!authConfigured(env))return {ok:false,reason:'ACCESS_NOT_CONFIGURED'};
  const jwt=readJwt(request);
  if(!jwt || jwt.length>18000)return {ok:false,reason:'ACCESS_LOGIN_REQUIRED'};
  try{
    const parts=jwt.split('.');
    if(parts.length!==3)return {ok:false,reason:'INVALID_JWT'};
    const header=parsedJson(decodePart(parts[0]));
    const claims=parsedJson(decodePart(parts[1]));
    if(header.alg!=='RS256'||!header.kid||typeof header.kid!=='string')throw Error('UNSUPPORTED_ALGORITHM');
    if(claims.iss!==env.ACCESS_TEAM_DOMAIN)throw Error('ISSUER_MISMATCH');
    if(!(Array.isArray(claims.aud)?claims.aud.includes(env.ACCESS_AUD):claims.aud===env.ACCESS_AUD))throw Error('AUDIENCE_MISMATCH');
    const now=Math.floor(nowMs/1000);
    if(!Number.isSafeInteger(claims.exp)||claims.exp<=now)throw Error('EXPIRED');
    if(!Number.isSafeInteger(claims.iat)||claims.iat>now+60)throw Error('FUTURE_IAT');
    if(claims.nbf!==undefined&&(!Number.isSafeInteger(claims.nbf)||claims.nbf>now+60))throw Error('FUTURE_NBF');
    if(typeof claims.email!=='string'||claims.email.toLowerCase()!==env.ACCESS_OWNER_EMAIL.toLowerCase())throw Error('NOT_OWNER');
    const keys=await fetchKeys(env.ACCESS_TEAM_DOMAIN,header.kid,fetcher,nowMs);
    const jwk=keys.find(k=>k.kid===header.kid);
    if(!jwk)throw Error('UNKNOWN_KEY');
    const key=await crypto.subtle.importKey('jwk',{kty:'RSA',n:jwk.n,e:jwk.e,ext:true}, {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const signed=utf8.encode(parts[0]+'.'+parts[1]);
    const verified=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decodePart(parts[2]),signed);
    if(!verified)throw Error('INVALID_SIGNATURE');
    return {ok:true,email:claims.email.toLowerCase(),subject:claims.sub??null};
  }catch{return {ok:false,reason:'ACCESS_DENIED'};}
}
export function sameOriginMutation(request){
  if(['GET','HEAD','OPTIONS'].includes(request.method))return true;
  const requestOrigin=new URL(request.url).origin;
  const origin=request.headers.get('Origin');
  if(origin!==requestOrigin)return false;
  if(['POST','PUT','PATCH'].includes(request.method))return /^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'');
  return true;
}
