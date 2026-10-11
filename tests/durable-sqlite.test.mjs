import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {routeApi} from '../src/worker.mjs';
import {configuredMasterKey,decryptProviderKey} from '../src/vault.mjs';
import dashboard from '../dist/dashboard-worker.mjs';
import {generateKeyPairSync,sign} from 'node:crypto';

function binding(db){return {prepare(sql){return {bind(...args){return {
 async run(){db.prepare(sql).run(...args);return {success:true};},
 async first(){return db.prepare(sql).get(...args)??null;},
 async all(){return {results:db.prepare(sql).all(...args)};}
};}};}};}
const req=(path,method='GET',body)=>new Request('https://analyzer.invalid'+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
test('LOCAL SQLite file persists reports and encrypted keys across DB close/reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'yta-sqlite-'));
 let db=new DatabaseSync(join(dir,'store.sqlite'));
 try{
  db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_live.sql',import.meta.url),'utf8'));
  const root=crypto.getRandomValues(new Uint8Array(32));
  const env={DB:binding(db),KEY_ENCRYPTION_KEY_B64:Buffer.from(root).toString('base64')};
  const created=await routeApi(req('/api/jobs','POST',{sourceType:'text',title:'지속저장 검증',filename:'sample.srt',durationSeconds:5892.864,transcript:'1\n00:00:00,000 --> 00:30:00,000\n부분 전사 테스트'}),env);
  assert.equal(created.status,201);const job=(await created.json()).job;
  assert.equal(job.status,'PARTIAL_TRANSCRIPT');
  const dummy='NON_REAL_API_KEY_STORAGE_TEST';
  const saved=await routeApi(req('/api/settings/providers/groq/secret','PUT',{apiKey:dummy}),env);
  assert.equal(saved.status,200);assert.ok(!(await saved.text()).includes(dummy));
  db.close();db=new DatabaseSync(join(dir,'store.sqlite'));env.DB=binding(db);
  const report=(await (await routeApi(req('/api/jobs/'+job.id),env)).json()).job;
  assert.deepEqual(report.report.summary,['부분 전사 테스트']);
  const listed=await (await routeApi(req('/api/jobs?q='+encodeURIComponent('지속저장')),env)).json();
  assert.equal(listed.jobs.length,1);
  const record=db.prepare('SELECT * FROM provider_credentials').get();
  assert.ok(!JSON.stringify(record).includes(dummy));
  assert.equal(await decryptProviderKey(configuredMasterKey(env),'groq',{version:record.cipher_version,ivB64:record.iv_b64,ciphertextB64:record.ciphertext_b64}),dummy);
  assert.ok(!(await (await routeApi(req('/api/settings/providers'),env)).text()).includes(dummy));
  assert.equal((await routeApi(req('/api/settings/providers/groq/secret','DELETE'),env)).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM provider_credentials').get().n,0);
  assert.equal((await routeApi(req('/api/jobs/'+job.id,'DELETE'),env)).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('Dashboard bundle fails closed before configuration, assets and API included',async()=>{
 for(const path of ['/','/app.js','/style.css','/api/health']){
  assert.equal((await dashboard.fetch(req(path),{})).status,503);
  assert.equal((await dashboard.fetch(req(path),{ACCESS_TEAM_DOMAIN:'https://test.cloudflareaccess.com',ACCESS_AUD:'test-application-audience',ACCESS_OWNER_EMAIL:'owner@example.invalid'})).status,401);
 }
});
test('Dashboard embedded assets require a cryptographically signed owner JWT; foreign writes blocked',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const env={ACCESS_TEAM_DOMAIN:'https://bundle-test.cloudflareaccess.com',ACCESS_AUD:'bundle-test-audience',ACCESS_OWNER_EMAIL:'owner@example.invalid'};
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const now=Math.floor(Date.now()/1000);
 const header=encode({alg:'RS256',kid:'bundle-key'});
 const payload=encode({iss:env.ACCESS_TEAM_DOMAIN,aud:[env.ACCESS_AUD],iat:now-1,exp:now+600,email:env.ACCESS_OWNER_EMAIL});
 const jwt=header+'.'+payload+'.'+sign('RSA-SHA256',Buffer.from(header+'.'+payload),privateKey).toString('base64url');
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async url=>{assert.equal(url,env.ACCESS_TEAM_DOMAIN+'/cdn-cgi/access/certs');return Response.json({keys:[{...publicKey.export({format:'jwk'}),kid:'bundle-key',alg:'RS256'}]});};
 try{
  for(const path of ['/','/app.js','/style.css']){
   const response=await dashboard.fetch(new Request('https://analyzer.invalid'+path,{headers:{'cf-access-jwt-assertion':jwt}}),env);
   assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
   assert.ok((await response.text()).length>100);
  }
  const response=await dashboard.fetch(new Request('https://analyzer.invalid/api/jobs',{method:'POST',headers:{'cf-access-jwt-assertion':jwt,Origin:'https://foreign.invalid','content-type':'application/json'},body:'{}'}),env);
  assert.equal(response.status,403);
 }finally{globalThis.fetch=originalFetch;}
});
