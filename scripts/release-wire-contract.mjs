// Pure request preparation only. No fetch, credential loader or production wiring.
import {target,hash,packageCandidate} from './exact-version-release-proposal.mjs';
import {inspectBindingSet} from './remote-state-policy.mjs';
import {extname} from 'node:path';

export const reviewedModuleDigest='e8b67790b2e6eae73d7194c49d2a4f07a52f919816664d4a701c1c75c74e48e1';
const fail=()=>{throw Error('RELEASE_WIRE_CONTRACT_REJECTED');};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const same=(a,b)=>stable(a)===stable(b);
const exact=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||!same(Object.keys(value).sort(),[...keys].sort()))fail();};
const tag=value=>typeof value==='string'&&value.startsWith('release-')&&uuid(value.slice(8));
const token=value=>typeof value==='string'&&value.length>0&&value.length<=16384&&/^[A-Za-z0-9._~-]+$/.test(value);
const base=`/accounts/${target.accountId}/workers`;
const assetContentTypes=Object.freeze({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8'});

class PreparedRequest {
  #request;
  #audit;
  constructor(request,audit){this.#request=request;this.#audit=Object.freeze({...audit,query:Object.freeze({...audit.query}),productionExecutionSupported:false});Object.freeze(this);}
  // This does not authorize transmission. A future reviewed transport must still
  // enforce the existing journal, approval, fresh observation and writer window.
  takeForReviewedTransport(){if(!this.#request)fail();const request=this.#request;this.#request=null;return request;}
  toJSON(){return this.#audit;}
  [Symbol.for('nodejs.util.inspect.custom')](){return this.#audit;}
}

export function releaseWireCompiler({candidate,workerReference,baselineBindings}){
  // Pin the actual reviewed production bundle, not the synthetic v4 module fixture.
  const pkg=packageCandidate({files:candidate.assets.rows.map(row=>({path:row.path,bytes:row.bytes})),modules:candidate.modules,main_module:candidate.main_module});
  if(pkg.moduleDigest!==reviewedModuleDigest||candidate.moduleDigest!==pkg.moduleDigest||!same(candidate.assets.apiManifest,pkg.assets.apiManifest))fail();
  // The upload part's Content-Type is preserved when Cloudflare serves the asset.
  // Pin each hash to the reviewed extension's browser type; never use a fallback.
  const contentTypeByHash=new Map();
  for(const row of pkg.assets.rows){
    const contentType=assetContentTypes[extname(row.path)];
    if(!contentType||(contentTypeByHash.has(row.apiHash)&&contentTypeByHash.get(row.apiHash)!==contentType))fail();
    contentTypeByHash.set(row.apiHash,contentType);
  }
  if(typeof workerReference!=='string'||(workerReference!==target.workerName&&!uuid(workerReference)&&!(/^[a-f0-9]{32}$/).test(workerReference)))fail();
  if(!inspectBindingSet(baselineBindings,{expectAssets:true}).complete)fail();
  for(const binding of baselineBindings){exact(binding,binding.name==='DB'?['name','type','id']:['name','type']);if(binding.name==='DB'&&binding.id!==target.databaseId)fail();}
  const bindings=structuredClone(baselineBindings);
  const inherited=bindings.map(binding=>binding.type==='assets'?{name:binding.name,type:'assets'}:{name:binding.name,type:'inherit',version_id:target.baselineVersionId});
  const sortedBindings=value=>[...value].sort((a,b)=>a.name.localeCompare(b.name));
  const createPath=`${base}/workers/${workerReference}/versions`;
  return Object.freeze({productionExecutionSupported:false,
    compile(descriptor,{verifiedCreatedVersionId=null}={}){
      let phase,body,query,headers;
      if(descriptor?.method!=='POST')fail();
      if(descriptor.path===`${base}/scripts/${target.workerName}/assets-upload-session`){
        exact(descriptor,['method','path','body']);exact(descriptor.body,['manifest']);
        if(!same(descriptor.body.manifest,pkg.assets.apiManifest))fail();
        phase='ASSET_SESSION';body=JSON.stringify(descriptor.body);headers={'Content-Type':'application/json'};
      }else if(descriptor.path===`${base}/assets/upload`){
        exact(descriptor,['method','path','query','headers','multipart']);exact(descriptor.query,['base64']);exact(descriptor.headers,['Authorization']);
        if(descriptor.query.base64!==true||typeof descriptor.headers.Authorization!=='string'||!descriptor.headers.Authorization.startsWith('Bearer ')||!token(descriptor.headers.Authorization.slice(7)))fail();
        if(!descriptor.multipart||typeof descriptor.multipart!=='object'||Array.isArray(descriptor.multipart)||!Object.keys(descriptor.multipart).length)fail();
        body=new FormData();
        for(const [fileHash,encoded] of Object.entries(descriptor.multipart)){
          const rows=pkg.assets.rows.filter(row=>row.apiHash===fileHash);
          if(!rows.length||rows.some(row=>!row.bytes.equals(rows[0].bytes))||encoded!==rows[0].bytes.toString('base64'))fail();
          body.append(fileHash,new Blob([encoded],{type:contentTypeByHash.get(fileHash)}),fileHash);
        }
        phase='ASSET_UPLOAD';query={base64:'true'};headers={Authorization:descriptor.headers.Authorization};
      }else if(descriptor.path===createPath){
        exact(descriptor,['method','path','query','body']);exact(descriptor.query,['deploy']);
        const b=descriptor.body;exact(b,['annotations','bindings','compatibility_date','compatibility_flags','assets','main_module','modules']);exact(b.annotations,['workers/message','workers/tag']);exact(b.assets,['config','jwt']);
        if(descriptor.query.deploy!==false||b.annotations['workers/message']!==`source-commit:${target.candidateCommit}`||!tag(b.annotations['workers/tag'])||!Array.isArray(b.bindings)||!same(sortedBindings(b.bindings),sortedBindings(inherited))||b.compatibility_date!=='2026-10-10'||!same(b.compatibility_flags,[])||!same(b.assets.config,{run_worker_first:true})||!token(b.assets.jwt)||b.main_module!==pkg.main_module||!same(b.modules,pkg.modules))fail();
        phase='VERSION_CREATE';query={deploy:'false'};body=JSON.stringify(b);headers={'Content-Type':'application/json'};
      }else if(descriptor.path===`${base}/scripts/${target.workerName}/deployments`){
        exact(descriptor,['method','path','query','body']);exact(descriptor.query,['force']);exact(descriptor.body,['strategy','versions','annotations']);exact(descriptor.body.annotations,['workers/message']);
        if(descriptor.query.force!==false||!uuid(verifiedCreatedVersionId)||verifiedCreatedVersionId===target.baselineVersionId||descriptor.body.strategy!=='percentage'||!same(descriptor.body.versions,[{version_id:verifiedCreatedVersionId,percentage:100}])||!tag(descriptor.body.annotations['workers/message']))fail();
        phase='TRAFFIC_PROMOTION';query={force:'false'};body=JSON.stringify(descriptor.body);headers={'Content-Type':'application/json'};
      }else fail();
      const url=new URL('https://api.cloudflare.com/client/v4'+descriptor.path);
      for(const [key,value] of Object.entries(query??{}))url.searchParams.set(key,value);
      // Request/FormData construction is local. It does not invoke the network.
      const request=new Request(url,{method:'POST',headers,body,redirect:'error'});
      return new PreparedRequest(request,{phase,method:'POST',pathname:url.pathname,query:Object.fromEntries(url.searchParams),assetDigest:pkg.assets.assetDigest,moduleDigest:pkg.moduleDigest,descriptorDigest:hash(stable(descriptor)),oauthAuthorizationAttached:false});
    },
  });
}
