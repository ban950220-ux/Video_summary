import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {verifyOwnerAccess,sameOriginMutation,authConfigured} from '../src/access.mjs';
import {handleSiteRequest} from '../src/site-worker.mjs';

const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk=publicKey.export({format:'jwk'});
const domain='https://unit-test.cloudflareaccess.com';
const aud='unit-test-audience-1234';
const email='owner@example.com';
const env={ACCESS_TEAM_DOMAIN:domain,ACCESS_AUD:aud,ACCESS_OWNER_EMAIL:email,ASSETS:{fetch:async(req)=>new Response('<html>test</html>',{headers:{'content-type':'text/html'}})}};
const enc=(x)=>Buffer.from(JSON.stringify(x)).toString('base64url');
const now=Math.floor(Date.now()/1000);
const jwt=(claims={},kid='test-key')=>{
  const head=enc({alg:'RS256',typ:'JWT',kid}),body=enc({iss:domain,aud:[aud],iat:now-10,exp:now+3600,email,sub:'test-sub',...claims});
  const sig=sign('RSA-SHA256',Buffer.from(`${head}.${body}`),privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
};
const fetcher=async(url)=>{assert.equal(url,domain+'/cdn-cgi/access/certs');return Response.json({keys:[{...jwk,kid:'test-key',alg:'RS256'}]});};
const request=(path='/',auth=jwt(),{method='GET',origin,body}={})=>new Request('https://private.example.com'+path,{
  method,headers:{'Cf-Access-Jwt-Assertion':auth,...(origin===undefined?{}:{Origin:origin}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)
});
const call=(path,auth,opts)=>handleSiteRequest(request(path,auth,opts),env,{fetcher,nowMs:Date.now()});

test('Access fails closed without configured owner and AUD',async()=>{
  assert.equal(authConfigured({}),false);
  const r=await handleSiteRequest(request(),{ASSETS:env.ASSETS},{fetcher});
  assert.equal(r.status,503);
});
test('RSA-signed Cloudflare Access owner token permits protected HTML only',async()=>{
  const r=await call('/');assert.equal(r.status,200);
  assert.match(await r.text(),/test/);
  assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal(r.headers.get('cache-control'),'private, no-store');
});
test('reject forged header/expired token/wrong email/wrong AUD and wrong issuer',async()=>{
  const cases=[jwt({email:'intruder@example.com'}),jwt({aud:['other']}),jwt({iss:'https://evil.cloudflareaccess.com'}),jwt({exp:now-1}),jwt({iat:now+5000}),jwt({nbf:now+5000}),jwt().slice(0,-5)+'aaaaa'];
  for(const token of cases){const r=await call('/',token);assert.equal(r.status,401);}
});
test('auth cookie accepted only with real signature',async()=>{
  const req=new Request('https://private.example.com/',{headers:{Cookie:`CF_Authorization=${jwt()}`}});
  const verified=await verifyOwnerAccess(req,env,{fetcher,nowMs:Date.now()});
  assert.equal(verified.ok,true);
});
test('site API health protected and identifies MOCK_ONLY not production PASS',async()=>{
  assert.equal((await call('/api/health','invalid')).status,401);
  const r=await call('/api/health');assert.equal(r.status,200);
  const d=await r.json();assert.equal(d.mode,'MOCK_ONLY');assert.equal(d.realCalls,false);
});
test('Groq summary ledger status stays behind owner Access',async()=>{
 for(const action of ['groq-summary-status','groq-summary-failure-diagnostic','groq-summary-pilot']){
  const path='/api/jobs/11111111-1111-4111-8111-111111111111/'+action;
  assert.equal((await call(path,'invalid')).status,401);
  assert.equal((await call(path,jwt({email:'intruder@example.com'}))).status,401);
 }
});
test('Groq credential binding diagnostic stays behind owner Access',async()=>{
 const path='/api/settings/providers/groq/binding-diagnostic';
 assert.equal((await call(path,'invalid')).status,401);
 assert.equal((await call(path,jwt({email:'intruder@example.com'}))).status,401);
});
test('CSRF denies missing and foreign Origin for write APIs',async()=>{
  const payload={sourceType:'url',url:'https://youtu.be/2hUkTmwYm3A',durationSeconds:60};
  assert.equal(sameOriginMutation(request('/api/jobs',jwt(),{method:'POST',body:payload})),false);
  const bad=await call('/api/jobs',jwt(),{method:'POST',body:payload});assert.equal(bad.status,403);
  const foreign=await call('/api/jobs',jwt(),{method:'POST',origin:'https://evil.invalid',body:payload});assert.equal(foreign.status,403);
  const good=await call('/api/jobs',jwt(),{method:'POST',origin:'https://private.example.com',body:payload});assert.equal(good.status,202);
  const data=await good.json();assert.equal(data.job.status,'NEED_UPLOAD');
});
test('key write request is denied without verified access and without same-site Origin',async()=>{
  const options={method:'PUT',origin:'https://evil.invalid',body:{apiKey:'some-invented-key'}};
  const r=await call('/api/settings/providers/groq/secret',jwt(),options);
  assert.equal(r.status,403);
  assert.equal((await call('/api/settings/providers/groq/secret',jwt(),{method:'PUT',origin:'https://private.example.com',body:options.body})).status,503);
});
test('static asset cannot be served without owner JWT',async()=>{
  assert.equal((await call('/style.css','')).status,401);
  const ok=await call('/style.css');assert.equal(ok.status,200);
  assert.equal(ok.headers.get('x-frame-options'),'DENY');
});
