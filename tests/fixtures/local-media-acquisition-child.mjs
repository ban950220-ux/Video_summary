// Local-process contention fixture. No real media executable or network call.
import {prepareLocalMedia} from '../../scripts/local-media-acquisition.mjs';
import {acquisitionLimits} from '../../scripts/local-acquisition-contract.mjs';
import {planMp3} from '../../src/audio.mjs';
import {writeFile,appendFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
const [root,mode]=process.argv.slice(2),url='https://www.youtube.com/watch?v=2hUkTmwYm3A';
const jobId='44444444-4444-4444-8444-444444444444',requestId='55555555-5555-4555-8555-555555555555';
const bytes=Buffer.alloc(12500*288);for(let i=0;i<12500;i++)bytes.set([255,243,136,192],i*288);
let first=true;
try{
 const result=await prepareLocalMedia({workDir:root,url,jobId,requestId,foreground:()=>true,
  consent:{kind:'LOCAL_MEDIA_ACQUISITION_CONSENT_V1',jobId,requestId,canonicalUrl:url,rightsConfirmed:true,...acquisitionLimits,expiresAt:Date.now()+600000},
  toolPaths:{'yt-dlp':process.execPath,ffmpeg:process.execPath},toolHashes:{'yt-dlp':'a'.repeat(64),ffmpeg:'b'.repeat(64)},
  commandRunner:async(command,settings)=>{
   if(first&&mode==='hold'){first=false;process.send('LOCKED');await new Promise(r=>process.once('message',r));}
   settings.beforeSpawn();
   if(command.args.includes('--version'))return {code:0,stdout:'2026.10.01'};
   if(command.args[0]==='-version')return {code:0,stdout:'ffmpeg version 7.1 fixture'};
   if(command.args.includes('--skip-download'))return {code:0,stdout:JSON.stringify({id:'2hUkTmwYm3A',duration:planMp3(bytes).durationSeconds,is_live:false,live_status:'not_live',availability:'public'})};
   if(command.executable==='yt-dlp'){await appendFile(join(dirname(root),'download.log'),'fixture-download\n');await writeFile(join(root,'source.m4a'),'synthetic source');return {code:0,stdout:join(root,'source.m4a')};}
   await writeFile(join(root,'audio.mp3'),bytes);return {code:0,stdout:''};
  }});
 process.stdout.write(JSON.stringify({state:result.state,reused:result.reused}));
}catch(error){process.stdout.write(JSON.stringify({error:error.code}));process.exitCode=2;}
finally{if(process.connected)process.disconnect();}
