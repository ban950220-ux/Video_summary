// Private owner-only site, no third-party scripts and no API keys in browser storage.
const $=(sel)=>document.querySelector(sel);
const state={view:'analyze',mode:'url',page:0,hasMore:false,provider:null,connections:[]};
const PROVIDER_INFO={
  supadata:{name:'Supadata',role:'기존 YouTube 자막 추출',link:'https://dash.supadata.ai'},
  gemini:{name:'Gemini',role:'한국어 번역·요약 / URL 보조 이해',link:'https://aistudio.google.com/api-keys'},
  groq:{name:'Groq',role:'사용자 제공 음성 Whisper 전사',link:'https://console.groq.com/keys'},
  assemblyai:{name:'AssemblyAI',role:'예비 음성 전사 (선택)',link:'https://www.assemblyai.com/dashboard'}
};
let toastTimer;
function toast(msg){const e=$('#toast');e.textContent=msg;e.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.hidden=true,5600);}
function el(tag,{className,text,attrs}={}){const x=document.createElement(tag);if(className)x.className=className;if(text!==undefined)x.textContent=String(text);if(attrs)for(const [k,v] of Object.entries(attrs))x.setAttribute(k,String(v));return x;}
function empty(x){x.replaceChildren();}
function fmtDate(s){if(!s)return '미확인';const d=new Date(s);return isNaN(+d)?'미확인':d.toLocaleString('ko-KR',{dateStyle:'medium',timeStyle:'short'});}
function safeError(e){return e?.message??'요청 처리 중 오류가 발생했습니다.';}
async function api(path,{method='GET',body}={}){
  const headers={Accept:'application/json'};
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',redirect:'follow',cache:'no-store'});
  const ct=response.headers.get('content-type')||'';
  if(!ct.includes('application/json'))throw Error('로그인 세션 또는 서버 응답을 확인하세요.');
  const data=await response.json();
  if(!response.ok)throw Error(data?.error?.message || data?.error?.code || `HTTP ${response.status}`);
  return data;
}
function switchView(view){
  if(!['analyze','library','usage','settings'].includes(view))view='analyze';
  state.view=view;
  document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===`view-${view}`));
  document.querySelectorAll('[data-view-link]').forEach(x=>x.classList.toggle('active',x.dataset.viewLink===view));
  $('#crumb').textContent=({analyze:'분석 / 새 영상',library:'분석 / 라이브러리',usage:'운영 / 리소스',settings:'보안 / API 설정'})[view];
  if(view==='library')loadLibrary().catch(e=>toast(safeError(e)));
  if(view==='usage')loadUsage().catch(e=>toast(safeError(e)));
  if(view==='settings')loadConnections().catch(e=>toast(safeError(e)));
}
function setInputMode(mode){state.mode=mode;$('#file-fields').hidden=mode!=='text';$('#url-fields').hidden=mode!=='url';document.querySelectorAll('[data-input-mode]').forEach(b=>{const active=b.dataset.inputMode===mode;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});}
function resultLine(container,label,value){const div=el('div',{className:'line'});div.append(el('span',{text:label}),el('strong',{text:value}));container.append(div);}
function showReport(job,container,persisted){empty(container);
  resultLine(container,'상태',job.status??'NOT_RUN');
  resultLine(container,'저장 상태',persisted?'D1 저장':'미저장 / DB 미설정');
  if(job.audit){resultLine(container,'전사 범위',job.audit.timelineRatio===null?'확인 불가':`${Math.round(job.audit.timelineRatio*1000)/10}% (시간축 추정)`);resultLine(container,'범위 설명',job.audit.reason??'확인 필요');}
  const report=job.report;
  if(report){
    const h=el('h3',{text:'원문 추출 · AI 요약 아님'});container.append(h);
    const list=el('ol');for(const sentence of report.summary??[])list.append(el('li',{text:sentence}));container.append(list);
    container.append(el('p',{className:'subtitle',text:report.warning??'실제 AI 모델 분석·번역은 수행되지 않았습니다.'}));
  }else container.append(el('p',{className:'subtitle',text:'URL만으로 영상 내용을 생성하지 않습니다. 자막 또는 적법하게 확보한 파일을 연결해야 합니다.'}));
}
async function handleAnalyze(ev){ev.preventDefault();const button=$('#run-button');
  const duration=Number($('#duration-min').value);
  if(!Number.isInteger(duration)||duration<1||duration>120){toast('영상 길이는 1~120분으로 입력해주세요.');return;}
  const title=$('#video-title').value.trim();let data;
  if(state.mode==='url'){
    const url=$('#youtube-url').value.trim();
    if(!/^https:\/\/(www\.|m\.)?youtube\.com\/(watch\?|shorts\/|live\/)|^https:\/\/youtu\.be\//i.test(url)){toast('HTTPS YouTube 링크만 지원합니다.');return;}
    data={sourceType:'url',url,durationSeconds:duration*60,title};
  }else{
    const file=$('#caption-file').files[0];if(!file){toast('SRT·VTT·TXT 자막 파일을 선택해주세요.');return;}
    if(!/\.(srt|vtt|txt)$/i.test(file.name)||file.size>2_000_000){toast('자막 파일은 SRT/VTT/TXT, 최대 2MB입니다.');return;}
    data={sourceType:'text',filename:file.name,transcript:await file.text(),durationSeconds:duration*60,title:title||file.name};
  }
  button.disabled=true;button.textContent='처리 중…';
  try{const pre=await api('/api/preflight',{method:'POST',body:data});
    if(!pre?.routes)throw Error('사전 점검에 실패했습니다.');
    const result=await api('/api/jobs',{method:'POST',body:data});
    $('#result-panel').hidden=false;showReport(result.job,$('#result-content'),result.persisted);
    $('#result-panel').scrollIntoView({behavior:'smooth',block:'start'});
    toast(result.persisted?'D1에 분석 결과를 저장했습니다.':'작업이 시작됐으나 이력 DB가 연결되지 않았습니다.');
  }catch(e){toast(safeError(e));}finally{button.disabled=false;button.textContent='분석 시작 ↗';}
}
function libraryCard(job){
  const card=el('article',{className:'library-item'}),top=el('div',{className:'library-top'}),info=el('div');
  info.append(el('div',{className:'library-title',text:job.title || job.video_id || '제목 없음'}),el('div',{className:'library-meta',text:`${fmtDate(job.created_at)} · ${Math.round(job.duration_seconds/60)}분 · ${job.source_type}`}));
  top.append(info,el('span',{className:'pill'+(job.status?.includes('PARTIAL')?' warning':''),text:job.status}));card.append(top);
  const actions=el('div',{className:'library-actions'}),open=el('button',{className:'btn secondary small',text:'리포트 열기'}),remove=el('button',{className:'btn secondary small',text:'삭제'});
  open.onclick=async()=>{try{const data=await api(`/api/jobs/${encodeURIComponent(job.id)}`);const target=$('#library-detail');empty(target);target.hidden=false;target.append(el('h2',{text:data.job.title??'분석 리포트'}));showReport({status:data.job.status,audit:data.job.audit,report:data.job.report},target,true);target.scrollIntoView({behavior:'smooth'});}catch(e){toast(safeError(e));}};
  remove.onclick=async()=>{if(!confirm('이 분석 기록과 저장된 리포트를 삭제할까요?'))return;try{await api(`/api/jobs/${encodeURIComponent(job.id)}`,{method:'DELETE'});await loadLibrary();toast('이력에서 삭제했습니다.');}catch(e){toast(safeError(e));}};
  actions.append(open,remove);card.append(actions);return card;
}
async function loadLibrary(){
  const q=$('#library-search').value.trim(),out=$('#library-list');empty(out);
  out.append(el('p',{className:'subtitle',text:'DB 기록을 확인하고 있습니다…'}));
  const params=new URLSearchParams({limit:'10',offset:String(state.page*10)});if(q)params.set('q',q);
  const data=await api(`/api/jobs?${params}`);
  empty(out);state.hasMore=data.hasMore;
  if(!data.jobs?.length)out.append(el('p',{className:'tip',text:'저장된 분석 기록이 없습니다. 새 분석 화면에서 자막을 입력해보세요.'}));
  for(const job of data.jobs)out.append(libraryCard(job));
  $('#library-prev').disabled=state.page===0;$('#library-next').disabled=!state.hasMore;$('#library-page').textContent=`${state.page+1} 페이지`;
}
function metricCard(p){const c=el('article',{className:'provider-card'});c.append(el('strong',{text:PROVIDER_INFO[p.id]?.name??p.id}),el('p',{text:PROVIDER_INFO[p.id]?.role??p.role}));
  const row=el('div',{className:'row'});row.append(el('span',{text:p.publishedFreeLimit==null?'공개 한도: 모델·티어별 상이':`공개 한도: ${p.publishedFreeLimit.toLocaleString()} ${p.id==='groq'?'음성초/일':'크레딧/월'}`}),el('span',{className:'pill warning',text:'계정 잔여 UNKNOWN'}));c.append(row);c.append(el('p',{text:'계정 사용량 미연동 · 현재 호출 가능 여부 미검증'}));return c;}
async function loadUsage(){const data=await api('/api/usage');const out=$('#usage-list');empty(out);for(const p of data.providers)out.append(metricCard(p));}
async function loadConnections(){const data=await api('/api/settings/providers');state.connections=data.providers??[];renderConnections();}
function renderConnections(){const out=$('#provider-settings');empty(out);for(const p of state.connections){const info=PROVIDER_INFO[p.provider];if(!info)continue;
    const box=el('div',{className:'connection'}),name=el('div');name.append(el('strong',{text:info.name}),el('small',{text:info.role}));
    const tools=el('div',{className:'tools'});tools.append(el('span',{className:'pill'+(p.configured?'':' warning'),text:p.configured?'암호화 저장됨 · 미검증':'미연결'}));
    const add=el('button',{className:'btn secondary small',text:p.configured?'교체':'등록'});add.type='button';add.onclick=()=>{state.provider=p.provider;$('#key-form').hidden=false;$('#provider-key').value='';$('#provider-key').focus();};tools.append(add);
    if(p.configured){const del=el('button',{className:'btn secondary small',text:'삭제'});del.type='button';del.onclick=async()=>{if(!confirm(`${info.name} API 키를 서버에서 삭제할까요?`))return;try{await api(`/api/settings/providers/${p.provider}/secret`,{method:'DELETE'});await loadConnections();toast('키를 삭제했습니다.');}catch(e){toast(safeError(e));}};tools.append(del);}
    const link=el('a',{className:'btn secondary small',text:'발급 사이트 ↗',attrs:{href:info.link,target:'_blank',rel:'noopener noreferrer'}});tools.append(link);box.append(name,tools);out.append(box);
  }}
async function saveKey(ev){ev.preventDefault();const provider=state.provider,key=$('#provider-key').value;
  if(!provider||key.length<8){toast('키 형식과 제공자를 확인하세요.');return;}
  const button=$('#save-key');button.disabled=true;
  try{await api(`/api/settings/providers/${provider}/secret`,{method:'PUT',body:{apiKey:key}});$('#provider-key').value='';$('#key-form').hidden=true;state.provider=null;await loadConnections();toast('키를 서버에서 암호화하여 저장했습니다. API 연결 테스트는 별도로 필요합니다.');}
  catch(e){toast(safeError(e));}finally{button.disabled=false;$('#provider-key').value='';}
}
function init(){
  window.addEventListener('hashchange',()=>switchView(location.hash.replace('#','')));
  document.querySelectorAll('[data-input-mode]').forEach(b=>b.addEventListener('click',()=>setInputMode(b.dataset.inputMode)));
  $('#analyze-form').addEventListener('submit',handleAnalyze);
  $('#library-search').addEventListener('input',()=>{clearTimeout(init.searchTimer);init.searchTimer=setTimeout(()=>{state.page=0;loadLibrary().catch(e=>toast(safeError(e)));},320);});
  $('#reload-library').onclick=()=>loadLibrary().catch(e=>toast(safeError(e)));
  $('#library-prev').onclick=()=>{state.page=Math.max(0,state.page-1);loadLibrary().catch(e=>toast(safeError(e)));};
  $('#library-next').onclick=()=>{if(state.hasMore){state.page++;loadLibrary().catch(e=>toast(safeError(e)));}};
  $('#key-form').addEventListener('submit',saveKey);
  $('#cancel-key').onclick=()=>{$('#key-form').hidden=true;$('#provider-key').value='';state.provider=null;};
  switchView(location.hash.replace('#',''));
}
init();
