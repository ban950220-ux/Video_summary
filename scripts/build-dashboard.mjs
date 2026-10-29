// Dependency-free bundler for this fixed, reviewed module graph.
// Produces a single Cloudflare Dashboard ESM Worker including protected assets.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const names=['core','vault','access','groq-summary-contract','adapters','provider-keys','audio','approved-summary-format','report','summary-plan','observed-capacity','groq-year-recovery','groq-complete-synthesis','groq-usage-reconciliation','groq-d1-budget','groq-synthesis-execution','groq-summary','groq-full-coverage','groq-full-coverage-d1','groq-full-coverage-live','groq-full-coverage-global','groq-full-coverage-global-live','groq-full-coverage-fresh','paid-summary-contract','paid-summary-budget','paid-summary-trial','paid-summary-receipt','paid-summary-adapter','two-pass-windows','gemini-two-pass-contract','gemini-source-assessment','gemini-quote-renewal','source-summary-attempt','gemini-two-pass','paid-summary','manual-summary-import','live','asr-result-bridge','worker','site-worker'];
let output='// Generated from v0.7 source. No secrets. Live calls require owner free-account grants.\n';
for(const name of names){
  let source=readFileSync(new URL('../src/'+name+'.mjs',import.meta.url),'utf8');
  const exports=[...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/g)].map(m=>m[1]);
  source=source.replace(/import\s*\{([^}]+)\}\s*from\s*'\.\/([^']+)\.mjs';/g,(_,fields,dep)=>'const {'+fields+'}=modules['+JSON.stringify(dep)+'];');
  source=source.replace(/export default /g,'const defaultExport=').replace(/export (?=(?:async )?(?:function|class|const))/g,'');
  if(/\bimport\b.*from|\bexport\s/.test(source.replace(/\/\/[^\n]*/g,'')))throw Error('Unsupported module syntax: '+name);
  output+='modules['+JSON.stringify(name)+']=(()=>{\n'+source+'\nreturn {'+exports.join(',')+(source.includes('const defaultExport=')?',default:defaultExport':'')+'};})();\n';
}
output='const modules={};\n'+output;
const assets={};
for(const [path,file,type] of [['/','index.html','text/html'],['/index.html','index.html','text/html'],['/app.js','app.js','application/javascript'],['/style.css','style.css','text/css'],['/app.webmanifest','app.webmanifest','application/manifest+json'],['/pwa-install.js','pwa-install.js','application/javascript'],['/audio.mjs','audio.mjs','application/javascript'],['/audio-runner.mjs','audio-runner.mjs','application/javascript'],['/audio-progress-plan.mjs','audio-progress-plan.mjs','application/javascript'],['/groq-summary-progress.mjs','groq-summary-progress.mjs','application/javascript'],['/context-review.mjs','context-review.mjs','application/javascript'],['/manual-summary-import.mjs','manual-summary-import.mjs','application/javascript'],['/approved-summary-format.mjs','approved-summary-format.mjs','application/javascript'],['/asr-result-bridge.mjs','asr-result-bridge.mjs','application/javascript']]){
  assets[path]={body:readFileSync(new URL('../web/site/'+file,import.meta.url),'utf8'),type};
}
for(const size of [192,512]){
  assets[`/icons/app-${size}.png`]={body:readFileSync(new URL(`../web/site/icons/app-${size}.png`,import.meta.url)).toString('base64'),type:'image/png',binary:true};
}
output+='const assets='+JSON.stringify(assets)+';\n';
output+=`export default {async fetch(request,env){return modules['site-worker'].handleSiteRequest(request,{...env,ASSETS:{async fetch(req){const path=new URL(req.url).pathname;const asset=assets[path];if(!asset)return new Response('Not found',{status:404});const body=asset.binary?Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0)):asset.body;return new Response(req.method==='HEAD'?null:body,{headers:{'content-type':asset.type+(asset.binary?'':'; charset=utf-8'),'cache-control':'private, no-store'}});}}});}};\n`;
mkdirSync(new URL('../dist/',import.meta.url),{recursive:true});
writeFileSync(new URL('../dist/dashboard-worker.mjs',import.meta.url),output);
console.log('Dashboard Worker generated; authentication applies to every embedded asset.');
