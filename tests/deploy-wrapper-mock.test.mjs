import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..'),head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const loader='./tests/fixtures/deploy-wrapper-loader.mjs',entry='./scripts/deploy-production.mjs';
function execute(mode){
 const directory=mkdtempSync(join(tmpdir(),'deploy-wrapper-mock-')),log=join(directory,'calls.txt');
 try{
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,WORKERS_CI:'true',WORKERS_CI_BRANCH:'main',WORKERS_CI_COMMIT_SHA:head,WRANGLER_CI_MATCH_TAG:'tag',GROQ_CURRENT_STATE_REPLACEMENT_JSON:'MOCK',DEPLOY_MOCK_MODE:mode,DEPLOY_MOCK_LOG_FILE:log};
  const result=spawnSync(process.execPath,['--experimental-loader',loader,entry],{cwd:root,env,encoding:'utf8',timeout:15000});
  let calls=[];try{calls=readFileSync(log,'utf8').trim().split('\n').filter(Boolean);}catch{}
  return {status:result.status,stdout:result.stdout,stderr:result.stderr,calls};
 }finally{rmSync(directory,{recursive:true,force:true});}
}

test('real wrapper executes no Wrangler on preflight, final read, approval or last-state mismatch',()=>{
 for(const mode of ['preflight-fail','final-read-error','final-remote-drift','asset-drift','asset-read-error','approval-expired-final']){
  const result=execute(mode);
  assert.notEqual(result.status,0,mode);
  assert.equal(result.calls.filter(x=>x==='WRANGLER').length,0,mode);
  assert.ok(!result.calls.includes('POSTCHECK'),mode);
 }
});
test('real wrapper launches exactly one Wrangler on match and never retries ambiguous outcomes',()=>{
 const good=execute('success');assert.equal(good.status,0,good.stderr);assert.equal(good.calls.filter(x=>x==='WRANGLER').length,1);assert.equal(good.calls.filter(x=>x==='FINAL_READ').length,1);assert.equal(good.calls.filter(x=>x==='POSTCHECK').length,1);
 for(const mode of ['wrangler-error','post-error']){
  const result=execute(mode);assert.notEqual(result.status,0,mode);assert.equal(result.calls.filter(x=>x==='WRANGLER').length,1,mode);assert.equal(result.calls.filter(x=>x==='POSTCHECK').length,mode==='post-error'?1:0,mode);
 }
});
