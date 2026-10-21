import {test} from 'node:test';
import assert from 'node:assert/strict';
import {routeApi} from '../src/worker.mjs';
import {capacityIdentityForCredentialSnapshot} from '../src/observed-capacity.mjs';
import {encryptProviderKey} from '../src/vault.mjs';

const url='https://example.workers.dev/api/settings/providers/groq/binding-diagnostic';
const credential={cipher_version:1,iv_b64:'fake-iv',ciphertext_b64:'fake-ciphertext',updated_at:'2026-10-21T01:00:00.000Z'};
const db=row=>({prepare(sql){assert.match(sql,/SELECT cipher_version,iv_b64,ciphertext_b64,updated_at FROM provider_credentials/);return {bind(owner,provider){assert.equal(owner,'owner');assert.equal(provider,'groq');return {first:async()=>row};}};}});
test('owner-route diagnostic identifies the D1 credential actually preferred over a Worker Secret',async()=>{
 const env={DB:db(credential),GROQ_API_KEY:'different-fallback-secret'};
 const response=await routeApi(new Request(url),env),body=await response.json();
 assert.equal(response.status,200);
 assert.equal(body.source,'ENCRYPTED_D1');
 assert.equal(body.identity,await capacityIdentityForCredentialSnapshot(env,'groq',credential));
 assert.equal(body.updatedAt,credential.updated_at);
 assert.equal(body.organizationVerified,false);
 assert.equal(body.keyFingerprintSha256,null);
 assert.equal(body.keyNeverReturned,true);
 assert.doesNotMatch(JSON.stringify(body),/different-fallback-secret|fake-ciphertext|fake-iv/);
 assert.equal(response.headers.get('cache-control'),'no-store');
});
test('owner can compare the newly registered encrypted D1 key fingerprint without returning the key',async()=>{
 const key='local-test-project-key',root=new Uint8Array(32).fill(9),encrypted=await encryptProviderKey(root,'groq',key);
 const row={cipher_version:encrypted.version,iv_b64:encrypted.ivB64,ciphertext_b64:encrypted.ciphertextB64,updated_at:'2026-10-21T02:00:00.000Z'};
 const body=await (await routeApi(new Request(url),{DB:db(row),KEY_ENCRYPTION_KEY_B64:Buffer.from(root).toString('base64')})).json();
 const expected=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
 assert.equal(body.keyFingerprintSha256,expected);
 assert.equal(body.source,'ENCRYPTED_D1');
 assert.doesNotMatch(JSON.stringify(body),/local-test-project-key|ciphertext_b64/);
});
test('diagnostic names Worker fallback or no credential without claiming a Free organization',async()=>{
 const fallback=await (await routeApi(new Request(url),{DB:db(null),GROQ_API_KEY:'worker-secret-value'})).json();
 assert.equal(fallback.source,'WORKER_SECRET_FALLBACK');
 assert.match(fallback.identity,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(fallback),/worker-secret-value/);
 const missing=await (await routeApi(new Request(url),{DB:db(null)})).json();
 assert.equal(missing.source,'NONE');assert.equal(missing.identity,null);
 const tooShort=await (await routeApi(new Request(url),{DB:db(null),GROQ_API_KEY:'short'})).json();
 assert.equal(tooShort.source,'NONE');assert.equal(tooShort.identity,null);
});
