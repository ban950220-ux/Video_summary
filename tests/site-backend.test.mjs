import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import {encryptProviderKey,decryptProviderKey,configuredMasterKey} from '../src/vault.mjs';

const token='test-secret-with-at-least-24-chars';
const root=Buffer.alloc(32,57).toString('base64');
class FakeDB {
  jobs=new Map(); keys=new Map(); events=[]; markers=new Map();
  prepare(sql){
    const db=this;
    return {bind(...args){
      return {
        async run(){
          if(sql.startsWith('INSERT INTO jobs')){
            const [id,owner_id,video_id,title,source_url,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json]=args;
            db.jobs.set(id,{id,owner_id,video_id,title,source_url,source_type,status,duration_seconds,created_at,updated_at,report_json,audit_json});
          } else if(sql.startsWith('DELETE FROM jobs')){
            if(db.jobs.get(args[0])?.owner_id===args[1])db.jobs.delete(args[0]);
          } else if(sql.startsWith('INSERT INTO provider_credentials')){
            const [owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at]=args;
            db.keys.set(`${owner_id}:${provider}`,{owner_id,provider,cipher_version,iv_b64,ciphertext_b64,updated_at});
          } else if(sql.startsWith('INSERT OR IGNORE INTO yta_operations')){
            if(db.jobs.get(args[1])?.owner_id==='owner')db.markers.set(args[0],{provider:'deletion',state:'DELETING'});
          } else if(sql.startsWith('DELETE FROM provider_credentials')){
            db.keys.delete(`${args[0]}:${args[1]}`);
          } else if(sql.startsWith('INSERT INTO provider_credential_events')){
            db.events.push(args);
          } else if(sql.startsWith('DELETE FROM yta_')||sql.startsWith('UPDATE yta_operations')){} else throw new Error('Unsupported mock run: '+sql);
          return {success:true};
        },
        async first(){if(sql.includes('FROM sqlite_master'))return null;if(sql.startsWith('SELECT 1 AS ok FROM jobs'))return db.jobs.get(args[0])?.owner_id===args[1]?{ok:1}:null;if(sql.startsWith('SELECT provider,state FROM yta_operations'))return db.markers.get(args[0])??null;if(sql.startsWith('SELECT * FROM jobs'))return db.jobs.get(args[0])?.owner_id===args[1]?db.jobs.get(args[0]):null;throw new Error('Unsupported mock first: '+sql);},
        async all(){
          if(sql.includes('FROM sqlite_master'))return {results:['yta_sources','yta_quota','yta_operations','yta_audio'].map(name=>({name}))};
          if(sql.startsWith('SELECT provider,updated_at FROM provider_credentials'))return {results:[...db.keys.values()].filter(x=>x.owner_id===args[0])};
          if(sql.includes('FROM usage_events'))return {results:[]};
          if(sql.includes('FROM jobs')){
            let jobs=[...db.jobs.values()].filter(x=>x.owner_id===args[0]);
            if(sql.includes('LIKE'))jobs=jobs.filter(x=>[x.title??'',x.video_id??''].some(v=>v.includes(args[1].replace(/^%|%$/g,''))));
            jobs.sort((a,b)=>b.created_at.localeCompare(a.created_at));
            return {results:jobs.slice(args.at(-1),args.at(-1)+args.at(-2))};
          }
          throw new Error('Unsupported mock all: '+sql);
        }
      };
    }};
  }
}
const env={ADMIN_TOKEN:token,DB:new FakeDB(),KEY_ENCRYPTION_KEY_B64:root};
const request=(path,{method='GET',body,auth=token}={})=>new Request('https://private.invalid'+path,{method,headers:{Authorization:'Bearer '+auth,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
const call=async(path,opts={})=>worker.fetch(request(path,opts),env);

test('AES-GCM vault encrypt/decrypt, random IV, provider-bound authenticated data',async()=>{
  const key=configuredMasterKey(env);assert.equal(key.length,32);
  const a=await encryptProviderKey(key,'groq','gsk_test_example_never_real');
  const b=await encryptProviderKey(key,'groq','gsk_test_example_never_real');
  assert.notEqual(a.ciphertextB64,b.ciphertextB64);
  assert.notEqual(a.ivB64,b.ivB64);
  assert.equal(await decryptProviderKey(key,'groq',a),'gsk_test_example_never_real');
  await assert.rejects(decryptProviderKey(key,'gemini',a));
  await assert.rejects(decryptProviderKey(Buffer.alloc(32,1),'groq',a));
});
test('provider keys require auth + D1 + encryption root, never returned in any response',async()=>{
  assert.equal((await call('/api/settings/providers/groq/secret',{method:'PUT',auth:'incorrect',body:{apiKey:'gsk_never_real_example'}})).status,401);
  assert.equal((await worker.fetch(request('/api/settings/providers/groq/secret',{method:'PUT',body:{apiKey:'gsk_never_real_example'}}),{ADMIN_TOKEN:token})).status,503);
  assert.equal((await worker.fetch(request('/api/settings/providers/groq/secret',{method:'PUT',body:{apiKey:'gsk_never_real_example'}}),{ADMIN_TOKEN:token,DB:env.DB})).status,503);
  const res=await call('/api/settings/providers/groq/secret',{method:'PUT',body:{apiKey:'gsk_never_real_example'}});
  assert.equal(res.status,200);
  const txt=await res.text();assert.doesNotMatch(txt,/gsk_never_real_example/);
  const stored=env.DB.keys.get('owner:groq');
  assert.ok(stored);assert.doesNotMatch(JSON.stringify(stored),/gsk_never_real_example/);
  assert.equal(await decryptProviderKey(configuredMasterKey(env),'groq',{version:stored.cipher_version,ivB64:stored.iv_b64,ciphertextB64:stored.ciphertext_b64}),'gsk_never_real_example');
  const status=await (await call('/api/settings/providers')).json();
  assert.equal(status.providers.find(x=>x.provider==='groq').configured,true);
  assert.doesNotMatch(JSON.stringify(status),/gsk_never_real_example/);
  assert.equal((await call('/api/settings/providers/groq/secret',{method:'DELETE'})).status,200);
  assert.equal(env.DB.keys.has('owner:groq'),false);
  assert.deepEqual(env.DB.events.map(x=>x[3]),['SET_OR_ROTATE','DELETE']);
});
test('invalid provider, short keys, no authorization, default paid blocks',async()=>{
  assert.equal((await call('/api/settings/providers/other/secret',{method:'PUT',body:{apiKey:'bogusbogusbogus'}})).status,404);
  assert.equal((await call('/api/settings/providers/groq/secret',{method:'PUT',body:{apiKey:'123'}})).status,400);
  assert.equal((await call('/api/jobs?limit=100&offset=0',{auth:'bad'})).status,401);
  const u=await (await call('/api/usage')).json();
  assert.equal(u.policy.maxMonthlyPaidUSD??u.policy.monthlyPaidUSD??0,0);
});
test('history list, search, reopen and delete stored reports with no raw transcript',async()=>{
  const r=await call('/api/jobs',{method:'POST',body:{sourceType:'text',title:'내 투자영상',filename:'captions.srt',durationSeconds:3600,transcript:'1\n00:00:00,000 --> 00:30:00,000\n실적 전망에 대해서 설명합니다.'}});
  assert.equal(r.status,201);
  const j=await r.json();assert.equal(j.persisted,true);
  assert.equal(j.job.status,'PARTIAL_TRANSCRIPT');
  const list=await (await call('/api/jobs?limit=10')).json();
  assert.equal(list.jobs.length,1);assert.equal(list.jobs[0].title,'내 투자영상');
  assert.deepEqual(list.jobs[0].summary,['실적 전망에 대해서 설명합니다.']);
  const searched=await (await call('/api/jobs?q=%ED%88%AC%EC%9E%90')).json();
  assert.equal(searched.jobs.length,1);
  const stored=await (await call('/api/jobs/'+j.job.id)).json();
  assert.equal(stored.job.report.summary.length,1);
  assert.equal(stored.job.transcript_json,undefined);
  assert.equal((await call('/api/jobs/'+j.job.id,{method:'DELETE'})).status,200);
  const left=await (await call('/api/jobs')).json();assert.equal(left.jobs.length,0);
});
