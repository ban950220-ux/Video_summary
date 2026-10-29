import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const root=new URL('../web/site/',import.meta.url);
const read=path=>readFileSync(new URL(path,root));

test('install manifest opens the authenticated root in a standalone window',()=>{
  const manifest=JSON.parse(read('app.webmanifest'));
  assert.equal(manifest.id,'/');
  assert.equal(manifest.start_url,'/');
  assert.equal(manifest.scope,'/');
  assert.equal(manifest.display,'standalone');
  assert.notEqual(manifest.prefer_related_applications,true);
  for(const size of [192,512]){
    const icon=manifest.icons.find(item=>item.sizes===`${size}x${size}`&&item.type==='image/png');
    assert.ok(icon);
    const bytes=read(icon.src.slice(1));
    assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16),size);
    assert.equal(bytes.readUInt32BE(20),size);
  }
});

test('HTML supplies credentialed manifest and authenticated installation guidance',()=>{
  const html=read('index.html').toString('utf8');
  assert.match(html,/<link rel="manifest" href="\/app\.webmanifest" crossorigin="use-credentials">/);
  assert.match(html,/id="install-app"[^>]*hidden/);
  assert.match(html,/Android 앱 설치/);
  assert.match(html,/설치 후에도 인터넷 연결과 본인 인증이 필요합니다/);
  assert.equal(existsSync(new URL('sw.js',root)),false);
  assert.doesNotMatch(read('pwa-install.js').toString('utf8'),/serviceWorker|caches\.|localStorage|sessionStorage/);
});

test('install prompt is user initiated and hidden after installation',async()=>{
  const listeners=new Map();
  const button={hidden:true,addEventListener(name,fn){listeners.set('button:'+name,fn);}};
  let standalone=false;
  const window={navigator:{},matchMedia:()=>({matches:standalone}),addEventListener(name,fn){listeners.set(name,fn);}};
  runInNewContext(read('pwa-install.js').toString('utf8'),{document:{getElementById:()=>button},window});
  assert.equal(button.hidden,true);
  let prompts=0;
  listeners.get('beforeinstallprompt')({preventDefault(){},async prompt(){prompts++;},userChoice:Promise.resolve({outcome:'accepted'})});
  assert.equal(button.hidden,false);
  await listeners.get('button:click')();
  assert.equal(prompts,1);
  assert.equal(button.hidden,true);
  listeners.get('appinstalled')();
  assert.equal(button.hidden,true);
  standalone=true;
  listeners.get('beforeinstallprompt')({preventDefault(){},prompt(){throw Error('already installed');}});
  assert.equal(button.hidden,true);
});
