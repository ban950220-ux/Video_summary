import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {conversionCommand} from '../scripts/local-runner-commands.mjs';
import {runLocalCommand} from '../scripts/local-runner-process.mjs';

test('frame-safe conversion is pinned and weakened options never reach a process',async()=>{
 const parent=await realpath(tmpdir()),root=await mkdtemp(join(parent,'video-conversion-contract-'));
 try{
  const source=join(root,'source.mp3'),tool=join(root,'fixture-ffmpeg.exe'),toolBytes='non-executable fixture';
  await writeFile(source,'original media fixture');await writeFile(tool,toolBytes);
  const command=await conversionCommand({workDir:root,downloadedPath:source});
  assert.deepEqual(command.args,['-nostdin','-n','-i',source,'-vn','-ac','1','-ar','16000','-codec:a','libmp3lame','-b:a','64k','-reservoir','0','-write_xing','0','-f','mp3',join(root,'audio.mp3')]);
  let calls=0;
  const spawnImpl=(executable,args,options)=>{
   calls++;assert.equal(executable,tool);assert.deepEqual(args,command.args);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
   const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
   queueMicrotask(()=>child.emit('close',0));return child;
  };
  const settings={cwd:root,toolPaths:{ffmpeg:tool},toolHashes:{ffmpeg:createHash('sha256').update(toolBytes).digest('hex')},spawnImpl};
  await runLocalCommand(command,settings);assert.equal(calls,1);
  for(const [flag,value] of [['-b:a','24k'],['-reservoir','1'],['-write_xing','1']]){
   const index=command.args.indexOf(flag),changed=[...command.args],missing=[...command.args];
   changed[index+1]=value;missing.splice(index,2);
   for(const args of [changed,missing])await assert.rejects(runLocalCommand({...command,args},settings),{code:'RUNNER_COMMAND_TEMPLATE_INVALID'});
  }
  assert.equal(calls,1);assert.equal(await readFile(source,'utf8'),'original media fixture');
  await writeFile(join(root,'audio.mp3'),'existing output');
  await assert.rejects(conversionCommand({workDir:root,downloadedPath:source}),{code:'RUNNER_OUTPUT_EXISTS'});
  assert.equal(await readFile(join(root,'audio.mp3'),'utf8'),'existing output');
 }finally{
  const resolved=await realpath(root),tail=relative(parent,resolved);
  assert.ok(tail&&!tail.startsWith('..')&&!isAbsolute(tail));assert.ok(tail.startsWith('video-conversion-contract-'));
  await rm(resolved,{recursive:true,force:true});
 }
});
