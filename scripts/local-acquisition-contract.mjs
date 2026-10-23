import {join,isAbsolute} from 'node:path';
import {canonicalYouTubeUrl} from '../src/local-runner-contract.mjs';

export const acquisitionLimits=Object.freeze({maxDurationSeconds:7200,maxSourceBytes:134217728});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const common=['--no-config','--no-cache-dir','--no-plugin-dirs','--no-cookies-from-browser','--no-playlist','--no-progress','--retries','0','--fragment-retries','0','--extractor-retries','0','--file-access-retries','0'];
export const acquisitionVersionCommands=[{executable:'yt-dlp',args:['--no-config','--no-cache-dir','--no-plugin-dirs','--version']},{executable:'ffmpeg',args:['-version']}];
export function boundedAcquisitionCommands({url,workDir}){
 const {videoId,url:canonical}=canonicalYouTubeUrl(url);
 if(typeof workDir!=='string'||!isAbsolute(workDir)||/[\r\n\0%]/.test(workDir))throw Error('RUNNER_PATH_INVALID');
 const filter=`id = '${videoId}' & availability = 'public' & live_status = 'not_live' & duration <= 7200`;
 return [
  {executable:'yt-dlp',args:[...common,'--skip-download','--print','%(.{id,duration,is_live,live_status,availability,_type})j',canonical]},
  {executable:'yt-dlp',args:[...common,'--no-overwrites','--no-continue','--abort-on-error','--fixup','never','--match-filters',filter,'--max-filesize',String(acquisitionLimits.maxSourceBytes),'-f','bestaudio','--print','after_move:filepath','-o',join(workDir,'source.%(ext)s'),canonical]}
 ];
}
// Exact argv only; no caller-defined flags, executables, cookies or shell text.
export function isBoundedAcquisitionCommand(command,cwd){
 if(acquisitionVersionCommands.some(item=>item.executable===command.executable&&same(item.args,command.args)))return true;
 if(command.executable!=='yt-dlp')return false;
 try{return boundedAcquisitionCommands({url:command.args.at(-1),workDir:cwd}).some(item=>same(item.args,command.args));}catch{return false;}
}
