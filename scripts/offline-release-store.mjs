// Local executor exclusion only. This is not a Cloudflare/server-side lock.
import {mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync,readFileSync,readdirSync,lstatSync,realpathSync,rmdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';

const fail=code=>{throw Error(code);};
export function localReleaseStore(directory){
 const root=resolve(directory);
 mkdirSync(root,{recursive:true});
 if(lstatSync(root).isSymbolicLink()||realpathSync(root)!==root)fail('STORE_PATH_NOT_CANONICAL');
 const location=key=>{if(!/^[a-f0-9]{64}$/.test(key))fail('OPERATION_KEY_INVALID');return join(root,key);};
 return {async locked(key,run){
  const folder=location(key);mkdirSync(folder,{recursive:true});
  if(lstatSync(folder).isSymbolicLink())fail('STORE_PATH_NOT_CANONICAL');
  const lock=join(folder,'writer.lock');
  try{mkdirSync(lock);}catch(error){if(error.code==='EEXIST')fail('LOCAL_WRITER_LOCKED');throw error;}
  // Crash leaves the lock deliberately. No stale-lock timeout or automatic deletion.
  try{
   const names=readdirSync(folder).filter(n=>/^\d{6}\.json$/.test(n)).sort();
   let current=null;
   for(let i=0;i<names.length;i++){
    if(names[i]!==String(i).padStart(6,'0')+'.json')fail('JOURNAL_GAP');
    const path=join(folder,names[i]);if(lstatSync(path).isSymbolicLink())fail('JOURNAL_SYMLINK');
    const row=JSON.parse(readFileSync(path,'utf8'));
    if(row.operationKey!==key||row.sequence!==i)fail('JOURNAL_INVALID');current=row;
   }
   const append=fields=>{
    const row={...fields,operationKey:key,sequence:current?current.sequence+1:0};
    const temp=join(folder,randomUUID()+'.tmp'),destination=join(folder,String(row.sequence).padStart(6,'0')+'.json');
    const fd=openSync(temp,'wx',0o600);
    try{writeFileSync(fd,JSON.stringify(row));fsyncSync(fd);}finally{closeSync(fd);}
    // Same-directory hard-link publication is atomic and refuses replacement.
    // The temp file and original journal survive any failed/uncertain publication.
    linkSync(temp,destination);current=row;unlinkSync(temp);return row;
   };
   return await run({get current(){return current;},append});
  }finally{rmdirSync(lock);}
 }};
}
