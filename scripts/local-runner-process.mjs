import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
import {dirname,isAbsolute,relative} from 'node:path';
import {acquisitionCommands,canonicalYouTubeUrl} from '../src/local-runner-contract.mjs';
import {conversionCommand} from './local-runner-commands.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const permitted=new Set(['yt-dlp','ffmpeg','ffprobe']);
async function assertCommandTemplate(command,cwd){
 const args=command.args;
 if(command.executable==='yt-dlp'){
  const url=args.at(-1),canonical=canonicalYouTubeUrl(url);
  if(canonical.url!==url||!acquisitionCommands({url,workDir:cwd,videoId:canonical.videoId}).some(item=>JSON.stringify(item.args)===JSON.stringify(args)))fail('RUNNER_COMMAND_TEMPLATE_INVALID');
 }else if(command.executable==='ffmpeg'){
  const expected=await conversionCommand({workDir:cwd,downloadedPath:args[3]});
  if(JSON.stringify(args)!==JSON.stringify(expected.args))fail('RUNNER_COMMAND_TEMPLATE_INVALID');
 }else{
  const expected=['-v','error','-show_entries','format=duration,size,format_name','-of','json'];
  if(args.length!==7||JSON.stringify(args.slice(0,6))!==JSON.stringify(expected))fail('RUNNER_COMMAND_TEMPLATE_INVALID');
  const [root,file]=await Promise.all([realpath(cwd),realpath(args[6])]),tail=relative(root,file);
  if(!tail||tail.startsWith('..')||isAbsolute(tail)||!(await stat(file)).isFile())fail('RUNNER_COMMAND_TEMPLATE_INVALID');
 }
}
// Caller supplies an argv description made by local-runner-commands. There is
// deliberately no shell, cookies, inherited config or token handling here.
export async function runLocalCommand(command,{cwd,toolPaths,toolHashes,spawnImpl=spawn,timeoutMs=120000,maxOutputBytes=65536}={}){
 if(!permitted.has(command?.executable)||!Array.isArray(command.args)||!command.args.length||command.args.some(arg=>typeof arg!=='string'||/[\r\n\0]/.test(arg))||typeof cwd!=='string'||!cwd||!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>7200000||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1024||maxOutputBytes>65536)fail('RUNNER_COMMAND_INVALID');
 await assertCommandTemplate(command,cwd);
 const proposed=toolPaths?.[command.executable],expected=toolHashes?.[command.executable];
 if(typeof proposed!=='string'||!isAbsolute(proposed)||typeof expected!=='string'||!/^[0-9a-f]{64}$/.test(expected))fail('RUNNER_TOOL_UNPINNED');
 const executable=await realpath(proposed);if(!(await stat(executable)).isFile())fail('RUNNER_TOOL_UNPINNED');
 const hash=createHash('sha256');for await(const block of createReadStream(executable))hash.update(block);
 if(hash.digest('hex')!==expected)fail('RUNNER_TOOL_CHANGED');
 const env={SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PATH:dirname(executable)};
 const child=spawnImpl(executable,command.args,{cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env});
 let output='',error='',bytes=0,settled=false;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();finish(Object.assign(new Error('RUNNER_COMMAND_TIMEOUT'),{code:'RUNNER_COMMAND_TIMEOUT'}));},timeoutMs);
  const finish=(failure,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(failure)reject(failure);else resolve(result);};
  const append=(part,which)=>{bytes+=part.length;if(bytes>maxOutputBytes){child.kill();finish(Object.assign(new Error('RUNNER_OUTPUT_TOO_LARGE'),{code:'RUNNER_OUTPUT_TOO_LARGE'}));return;}if(which==='stdout')output+=part.toString('utf8');else error+=part.toString('utf8');};
  child.stdout.on('data',part=>append(part,'stdout'));child.stderr.on('data',part=>append(part,'stderr'));
  child.once('error',failure=>finish(failure));child.once('close',code=>code===0?finish(null,{stdout:output,stderr:error,code}):finish(Object.assign(new Error('RUNNER_COMMAND_FAILED'),{code:'RUNNER_COMMAND_FAILED',exitCode:code})));
 });
}
