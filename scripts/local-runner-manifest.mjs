import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
import {relative,isAbsolute} from 'node:path';
import {validateAcquisitionManifest} from '../src/local-runner-contract.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
async function checkedFile(root,path){
 const [base,file]=await Promise.all([realpath(root),realpath(path)]),tail=relative(base,file);
 if(!tail||tail.startsWith('..')||isAbsolute(tail)||!(await stat(file)).isFile())fail('RUNNER_FILE_OUTSIDE_WORKDIR');
 return file;
}
async function measure(path){
 const hash=createHash('sha256');let bytes=0;
 for await(const block of createReadStream(path)){hash.update(block);bytes+=block.length;}
 if(bytes<1)fail('RUNNER_EMPTY_FILE');return {sha256:hash.digest('hex'),bytes};
}
// Read-only manifest construction from files already produced in the local
// work directory. No downloader, transcriber or provider is invoked here.
export async function buildVerifiedManifest({workDir,jobId,requestId,videoId,audioPath,durationSeconds,ytDlpVersion,ffmpegVersion,chunks}){
 const file=await checkedFile(workDir,audioPath),audio=await measure(file),measured=[];
 for(const chunk of chunks){const path=await checkedFile(workDir,chunk.path),value=await measure(path);measured.push({index:chunk.index,start:chunk.start,end:chunk.end,sha256:value.sha256,bytes:value.bytes});}
 const manifest={kind:'LOCAL_AUDIO_ACQUISITION_V1',jobId,requestId,videoId,canonicalUrl:`https://www.youtube.com/watch?v=${videoId}`,method:'YT_DLP_BESTAUDIO_FFMPEG',ytDlpVersion,ffmpegVersion,fileSha256:audio.sha256,fileBytes:audio.bytes,durationSeconds,conversion:{audioChannels:1,sampleRate:16000,format:'mp3'},chunks:measured};
 return validateAcquisitionManifest(manifest,{videoId,jobId});
}
