import {realpath,stat,lstat} from 'node:fs/promises';
import {join,extname,relative,isAbsolute} from 'node:path';
import {canonicalYouTubeUrl,checkPublicVideoMetadata,acquisitionCommands} from '../src/local-runner-contract.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
// This module only constructs argv arrays. It never spawns a process or connects
// to a provider. Authentication and the bounded batch approval are separate.
export function plannedAcquisition({url,workDir,metadata}){
 const canonical=canonicalYouTubeUrl(url);checkPublicVideoMetadata(metadata,canonical.videoId);
 return {videoId:canonical.videoId,canonicalUrl:canonical.url,commands:acquisitionCommands({url,workDir,videoId:canonical.videoId})};
}
export async function conversionCommand({workDir,downloadedPath}){
 const root=await realpath(workDir),source=await realpath(downloadedPath),tail=relative(root,source);
 if(!tail||tail.startsWith('..')||isAbsolute(tail)||!['.m4a','.mp3','.webm','.ogg','.opus','.mp4'].includes(extname(source).toLowerCase())||!(await stat(source)).isFile())fail('RUNNER_SOURCE_PATH_INVALID');
 const output=join(root,'audio.mp3');try{await lstat(output);fail('RUNNER_OUTPUT_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
 return {executable:'ffmpeg',args:['-nostdin','-n','-i',source,'-vn','-ac','1','-ar','16000','-codec:a','libmp3lame','-f','mp3',output],output};
}
