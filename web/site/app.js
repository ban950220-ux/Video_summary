import {planMp3,prepareMp3Chunk} from '/audio.mjs';
import {runAudioChunks,runSummaryStages} from '/audio-runner.mjs';
// Private owner-only site, no third-party scripts and no API keys in browser storage.
const $=(sel)=>document.querySelector(sel);
const state={view:'analyze',mode:'url',page:0,hasMore:false,provider:null,connections:[]};
const PROVIDER_INFO={
  supadata:{name:'Supadata',role:'기존 YouTube 자막 추출',link:'https://dash.supadata.ai'},
  gemini:{name:'Gemini',role:'한국어 번역·요약 / 보유 음성 대체 전사',link:'https://aistudio.google.com/api-keys'},
  groq:{name:'Groq',role:'사용자 제공 음성 Whisper 전사',link:'https://console.groq.com/keys'},
  assemblyai:{name:'AssemblyAI',role:'예비 음성 전사 (선택)',link:'https://www.assemblyai.com/dashboard'}
};
let toastTimer;
let libraryDetailRequest=0;
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
  if(!response.ok)throw Object.assign(Error(data?.error?.message || data?.error?.code || `HTTP ${response.status}`),{code:data?.error?.code});
  return data;
}
async function waitForeground(ms){if(document.hidden)throw Error('브라우저 화면이 비활성화됐습니다. 이력에서 다시 확인하세요.');await new Promise(resolve=>setTimeout(resolve,ms));if(document.hidden)throw Error('브라우저 화면이 비활성화됐습니다. 이력에서 다시 확인하세요.');}
function switchView(view){
  if(!['analyze','library','usage','settings'].includes(view))view='analyze';
  state.view=view;
  document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===`view-${view}`));
  document.querySelectorAll('[data-view-link]').forEach(x=>x.classList.toggle('active',x.dataset.viewLink===view));
  $('#crumb').textContent=({analyze:'분석 / 새 영상',library:'분석 / 라이브러리',usage:'운영 / 리소스',settings:'보안 / API 설정'})[view];
  if(view==='library')loadLibrary().catch(e=>toast(safeError(e)));
  if(view==='usage')loadUsage().catch(e=>toast(safeError(e)));
  if(view==='settings'){loadQuota().catch(e=>toast(safeError(e)));loadCapacity().catch(e=>toast(safeError(e)));}if(view==='settings')loadConnections().catch(e=>toast(safeError(e)));
}
function setInputMode(mode){state.mode=mode;$('#file-fields').hidden=mode!=='text';$('#url-fields').hidden=mode!=='url';$('#audio-fields').hidden=mode!=='audio';document.querySelectorAll('[data-input-mode]').forEach(b=>{const active=b.dataset.inputMode===mode;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});}
function resultLine(container,label,value){const div=el('div',{className:'line'});div.append(el('span',{text:label}),el('strong',{text:value}));container.append(div);}
function showReport(job,container,persisted){empty(container);
  resultLine(container,'상태',job.status??'NOT_RUN');if(job.id)resultLine(container,'분석 ID',job.id);
  resultLine(container,'저장 상태',persisted?'D1 저장':'미저장 / DB 미설정');
  if(job.audit){resultLine(container,'전사 범위',Number.isFinite(job.audit.timelineRatio)?`${Math.round(job.audit.timelineRatio*1000)/10}% (시간축 추정)`:'확인 불가');resultLine(container,'범위 설명',job.audit.reason??'확인 필요');}
  const report=job.report;
  if(report){
    if(report.kind==='GEMINI_EVIDENCE_LINKED'){for(const [key,label] of [['summary','핵심 요약'],['chapters','시간대별 요약'],['claims','주장과 근거'],['numbers','수치와 확인 항목'],['critical','비판적 분석']]){container.append(el('h3',{text:label}));const list=el('ul');for(const item of report[key]||[])list.append(el('li',{text:item.text+' (원문 #'+item.evidenceIds.join(', #')+')'}));container.append(list);}container.append(el('h3',{text:'결론'}),el('p',{text:report.conclusion}),el('p',{className:'tip',text:report.warning}));}else{const h=el('h3',{text:'원문 추출 · AI 요약 아님'});container.append(h);
    const list=el('ol');for(const sentence of report.summary??[])list.append(el('li',{text:sentence}));container.append(list);
    container.append(el('p',{className:'subtitle',text:report.warning??'실제 AI 모델 분석·번역은 수행되지 않았습니다.'}));}
  }else container.append(el('p',{className:'subtitle',text:'AI 요약은 아직 없습니다. 전사 완료 후 저장된 원문과 내보내기를 확인할 수 있습니다.'}));
  if(job.id){const tools=el('div',{className:'library-actions'});for(const format of ['md','txt'])tools.append(el('a',{className:'btn secondary small',text:format.toUpperCase()+' 내보내기',attrs:{href:'/api/jobs/'+job.id+'/export?format='+format}}));const source=el('button',{className:'btn secondary small',text:'원문·근거 보기'});source.onclick=async()=>{try{const data=await api('/api/jobs/'+job.id+'/source');const pre=el('pre',{text:data.source?.segments?.length?(data.source.segments).map(x=>'#'+x.id+' ['+(x.startMs===null?'시각 미확인':Math.floor(x.startMs/1000)+'초')+'] '+x.text).join('\n'):'저장된 전체 전사가 아직 없습니다.'});container.append(pre);source.disabled=true;}catch(e){toast(safeError(e));}};tools.append(source);if(report?.kind!=='GEMINI_EVIDENCE_LINKED'){const review=el('button',{className:'btn secondary small',text:'요약 부분 출력 검토'});review.onclick=async()=>{try{const data=await api('/api/jobs/'+job.id+'/summary-review');container.append(el('pre',{text:data.partialText}));review.disabled=true;}catch(error){toast(safeError(error));}};tools.append(review);}container.append(tools);}
}
async function handleAnalyze(ev){ev.preventDefault();const button=$('#run-button'),progress=$('#analysis-progress');let data,bytes,plan;
 const live=$('#live-analysis').checked;const title=$('#video-title').value.trim();const duration=Number($('#duration-min').value);
 if(!Number.isInteger(duration)||duration<1||duration>120){toast('영상 길이는 1~120분입니다.');return;}
 button.disabled=true;
 try{
  if(state.mode==='url')data={sourceType:'url',url:$('#youtube-url').value.trim(),durationSeconds:duration*60,title};
  else if(state.mode==='text'){const file=$('#caption-file').files[0];if(!file||!/\.(srt|vtt|txt)$/i.test(file.name)||file.size>2000000)throw Error('2MB 이하 SRT/VTT/TXT를 선택하세요.');data={sourceType:'text',filename:file.name,transcript:await file.text(),durationSeconds:duration*60,title:title||file.name,persistTranscript:true};}
  else{const file=$('#audio-file').files[0];if(!file||!/\.mp3$/i.test(file.name)||file.size>200000000)throw Error('200MB 이하 MP3를 선택하세요.');if(!live||!$('#audio-rights').checked)throw Error('무료 API 처리와 적법한 보유 음성 업로드 동의가 필요합니다.');progress.textContent='MP3 시간축 및 조각 계획 확인 중…';bytes=new Uint8Array(await file.arrayBuffer());plan=planMp3(bytes);data={sourceType:'audio',durationSeconds:plan.durationSeconds,title:title||file.name};}
  await api('/api/preflight',{method:'POST',body:data});progress.textContent='분석 기록 생성 중…';let result;const resume=state.mode==='audio'?$('#resume-job').value.trim():'';if(resume){result=await api('/api/jobs/'+encodeURIComponent(resume));if(result.job.source_type!=='audio'||Math.abs(result.job.duration_seconds-plan.durationSeconds)>1)throw Error('선택한 음성과 이전 분석이 다릅니다.');result.persisted=true;}else result=await api('/api/jobs',{method:'POST',body:data});const id=result.job.id;
  $('#result-panel').hidden=false;showReport(result.job,$('#result-content'),result.persisted);
  if(live){
   if(state.mode==='url'){progress.textContent='기존 자막 조회 중…';result=await api('/api/jobs/'+id+'/native',{method:'POST',body:{}});if(['NEED_UPLOAD','NATIVE_PENDING'].includes(result.job.status)){showReport(result.job,$('#result-content'),true);throw Error(result.job.status==='NATIVE_PENDING'?'제공자 처리 대기: 이력에서 자막 결과 조회를 사용하세요.':'기존 자막이 없습니다. 보유 음성/자막을 사용하세요.');}}
   if(state.mode==='audio'){
    const fileSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
    await api('/api/jobs/'+id+'/audio-plan',{method:'POST',body:{rightsConfirmed:true,fileSha256,chunks:plan.chunks.map(({index,start,end})=>({index,start,end}))}});
    if($('#audio-gemini-confirm').checked)await api('/api/jobs/'+id+'/audio-consent',{method:'POST',body:{provider:'gemini',fileSha256,consent:true}});
    const run=await runAudioChunks({chunks:plan.chunks,getProgress:()=>api('/api/jobs/'+id+'/audio-progress'),getCapacity:()=>api('/api/live/capacity'),getQuota:()=>api('/api/live/quota'),now:Date.now,
     chooseProvider:()=>$('#audio-provider').value,authorizedProviders:()=>['groq',...($('#audio-gemini-confirm').checked?['gemini']:[])],
     review429:async(c,saved)=>confirm('조각 '+(c.index+1)+'의 '+saved.reviewProvider+' 공식 요청 로그에서 429 거절과 출력 없음, 재시도 가능 시각을 확인했나요?')?saved.reviewOperationId:null,
     wait:waitForeground,
     onUpdate:status=>{progress.textContent=status.waitingUntil?'제공자 호출 간격 대기 중 · '+fmtDate(status.waitingUntil):'음성 전사 '+(status.index+1)+' / '+plan.chunks.length+' · 기록 '+id;},
     sendChunk:async(c,provider,reviewedId)=>{const prepared=prepareMp3Chunk(bytes.subarray(c.byteStart,c.byteEnd));const response=await fetch('/api/jobs/'+id+'/audio-chunk?index='+c.index+'&provider='+provider+'&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream',...(reviewedId?{'x-provider-log-429-no-output-confirmed':'true','x-provider-log-429-operation-id':reviewedId}:{})},credentials:'same-origin',body:prepared.bytes});const result=await response.json();return response.ok?result:{code:result.error?.code||'AUDIO_SEND_FAILED'};}});
    if(!run.complete)throw Error('음성 전사를 일시 중단했습니다: '+run.reason+' · 조각 '+((run.index??0)+1)+' · 기록 '+id+'. 제공자 관측치와 이력을 확인한 뒤 같은 파일로 재개하세요.');
    result=await api('/api/jobs/'+id+'/audio-finish',{method:'POST',body:{}});showReport(result.job,$('#result-content'),true);
   }
   const summaryPlan=await api('/api/jobs/'+id+'/summary-plan');
   progress.textContent='원문 근거 연결 요약 '+summaryPlan.stages+'개 구간 작성 중… 첫 단계 예약 상한 '+summaryPlan.firstPassUnits+' 단위. 할당이 부족하면 완료 단계만 보관하고 중단합니다.';
   const staged=summaryPlan.firstPassUnits>250000;if(staged&&!confirm('이 원문은 첫 단계만 '+summaryPlan.firstPassUnits+' 단위가 필요합니다. 여러 차례 무료 할당 확인이 필요할 수 있고 최종 합성 비용은 아직 모릅니다. 단계별로 진행할까요?'))throw Error('단계별 요약을 시작하지 않았습니다.');
   const summary=await runSummaryStages({getProgress:()=>api('/api/jobs/'+id+'/audio-progress'),getCapacity:()=>api('/api/live/capacity'),getQuota:()=>api('/api/live/quota'),sendSummary:()=>api('/api/jobs/'+id+'/summary',{method:'POST',body:{allowStaged:staged}}),wait:waitForeground,onUpdate:status=>{progress.textContent=status.waitingUntil?'Gemini 요약 호출 간격 대기 중 · '+fmtDate(status.waitingUntil):'요약 단계 '+(status.stage+1)+' 저장됨 · 기록 '+id;}});
   if(!summary.complete)throw Error('요약을 일시 중단했습니다: '+summary.reason+' · 기록 '+id+'. 공급자 관측치와 사용량을 확인한 뒤 이력에서 계속하세요.');
   result=summary.result;
  }
  showReport(result.job,$('#result-content'),result.persisted);progress.textContent='처리 결과를 저장했습니다. 완전 전사·외부 사실 검증 상태는 리포트를 확인하세요.';toast('분석 결과 저장 완료');
 }catch(e){progress.textContent=safeError(e)+' — 완료된 원문과 조각은 이력에 보관됩니다. 불명확한 API 요청은 자동 재시도하지 않습니다.';toast(safeError(e));}finally{button.disabled=false;}
}
function libraryCard(job){
  const card=el('article',{className:'library-item'}),top=el('div',{className:'library-top'}),info=el('div');
  info.append(el('div',{className:'library-title',text:job.title || job.video_id || '제목 없음'}),el('div',{className:'library-meta',text:`${fmtDate(job.created_at)} · ${Math.round(job.duration_seconds/60)}분 · ${job.source_type}`}));
  top.append(info,el('span',{className:'pill'+(job.status?.includes('PARTIAL')?' warning':''),text:job.status}));card.append(top);
  const actions=el('div',{className:'library-actions'}),open=el('button',{className:'btn secondary small',text:'리포트 열기'}),remove=el('button',{className:'btn secondary small',text:'삭제'});
  open.onclick=async()=>{const detailRequest=++libraryDetailRequest;try{const data=await api(`/api/jobs/${encodeURIComponent(job.id)}`);if(detailRequest!==libraryDetailRequest)return;const target=$('#library-detail');empty(target);target.hidden=false;target.append(el('h2',{text:data.job.title??'분석 리포트'}));showReport(data.job,target,true);if(data.job.source_type==='audio'){const p=await api('/api/jobs/'+job.id+'/audio-progress');if(detailRequest!==libraryDetailRequest)return;if(p.chunks.length)resultLine(target,'음성 처리 확인',p.chunks.filter(c=>c.state==='DONE').length+' / '+p.chunks.length+' 조각 · '+p.coveragePercent+'% 시간 구간 (전체 전사 검증 아님)');for(const chunk of p.chunks.filter(c=>c.uncertainFailure)){const button=el('button',{className:'btn secondary small',text:'조각 '+(chunk.index+1)+' 부분 출력 검토'});button.onclick=async()=>{try{const review=await api('/api/jobs/'+job.id+'/audio-review?index='+chunk.index);target.append(el('pre',{text:review.partialText}));}catch(error){toast(safeError(error));}};target.append(button);}}target.scrollIntoView({behavior:'smooth'});}catch(e){if(detailRequest===libraryDetailRequest)toast(safeError(e));}};
  remove.onclick=async()=>{if(!confirm('이 분석 기록과 저장된 리포트를 삭제할까요?'))return;try{await api(`/api/jobs/${encodeURIComponent(job.id)}`,{method:'DELETE'});await loadLibrary();toast('이력에서 삭제했습니다.');}catch(e){toast(safeError(e));}};
  for(const [action,label] of [['native-poll','자막 결과 조회'],['summary','요약 생성'],['audio-finish','전사 병합'],...(job.source_type==='audio'?[['audio-cleanup','임시 전사 조각 정리']]:[])]){const b=el('button',{className:'btn secondary small',text:label});b.onclick=async()=>{b.disabled=true;try{let body={};if(action==='summary'){const p=await api('/api/jobs/'+job.id+'/summary-plan');if(p.firstPassUnits>250000){if(!confirm('첫 단계 예약 상한 '+p.firstPassUnits+' 단위, 최종 합성 비용은 미정입니다. 무료 할당을 단계별로 확인하며 계속할까요?'))return;body={allowStaged:true};}}if(action==='audio-cleanup'){if(!confirm('저장된 TXT 전사를 확인한 뒤 서비스의 임시 조각 전사 기록만 정리할까요? PC와 Library 원본은 유지됩니다.'))return;body={confirmTemporaryTranscriptCleanup:true};}const d=await api('/api/jobs/'+job.id+'/'+action,{method:'POST',body});const target=$('#library-detail');target.hidden=false;showReport(d.job,target,true);if(d.pending)toast('요약 단계 저장됨. 약 '+d.minimumWaitSeconds+'초 뒤 다시 누르세요.');else if(action==='audio-cleanup')toast(d.alreadyCleaned?'이미 정리됐습니다.':'임시 조각 전사 기록을 정리했습니다.');}catch(e){toast(safeError(e));}finally{b.disabled=false;}};actions.append(b);}actions.append(open,remove);card.append(actions);return card;
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
async function loadUsage(){const data=await api('/api/usage');$('#observed-calls').textContent=data.appObserved.reduce((sum,x)=>sum+x.events,0);const out=$('#usage-list');empty(out);for(const p of data.providers)out.append(metricCard(p));}
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
async function loadQuota(){const d=await api('/api/live/quota'),out=$('#quota-status');empty(out);out.append(el('p',{text:d.liveEnabled?'무료 호출 설정 활성':'Worker ENABLE_LIVE_FREE=true 설정이 필요합니다.'}));for(const q of d.grants){const row=el('div',{className:'line'});row.append(el('span',{text:q.provider+' · 앱 할당 잔여 '+Math.max(0,q.allowance-q.consumed)+' · '+(q.expires_at>Date.now()?'유효':'만료')}));const revoke=el('button',{text:'할당 취소'});revoke.onclick=async()=>{await api('/api/live/quota',{method:'DELETE',body:{provider:q.provider}});await loadQuota();};row.append(revoke);out.append(row);}}
async function loadCapacity(){const data=await api('/api/live/capacity'),out=$('#capacity-status');empty(out);for(const snapshot of data.snapshots){out.append(el('p',{text:snapshot.provider+' · '+snapshot.model+' · '+(snapshot.valid_until>Date.now()?'관측 유효':'관측 만료')+' · '+fmtDate(snapshot.observed_at)}));}}
function capacityPayload(){const provider=$('#capacity-provider').value,now=Date.now(),minute=Date.parse($('#cap-reset-minute').value),hour=Date.parse($('#cap-reset-hour').value),day=Date.parse($('#cap-reset-day').value);const remaining=provider==='gemini'?{requestsMinute:Number($('#cap-rpm').value),tokensMinute:Number($('#cap-tpm').value),requestsDay:Number($('#cap-rpd').value)}:{requestsMinute:Number($('#cap-rpm').value),audioSecondsHour:Number($('#cap-audio-hour').value),audioSecondsDay:Number($('#cap-audio-day').value)};const resetAt=provider==='gemini'?{requestsMinute:minute,tokensMinute:minute,requestsDay:day}:{requestsMinute:minute,audioSecondsHour:hour,audioSecondsDay:day};return {provider,model:provider==='gemini'?'gemini-2.5-flash':'whisper-large-v3-turbo',source:provider==='gemini'?'AI_STUDIO_LIVE':'GROQ_CONSOLE_LIVE',observedAt:now,remaining,resetAt,externalActivity:!$('#cap-confirm').checked,billingDisabled:$('#cap-confirm').checked,freeOnly:$('#cap-confirm').checked};}
function init(){
  window.addEventListener('hashchange',()=>switchView(location.hash.replace('#','')));
  document.querySelectorAll('[data-input-mode]').forEach(b=>b.addEventListener('click',()=>setInputMode(b.dataset.inputMode)));
  $('#quota-form').onsubmit=async ev=>{ev.preventDefault();try{await api('/api/live/quota',{method:'PUT',body:{provider:$('#quota-provider').value,allowance:Number($('#quota-allowance').value),requestLimit:Number($('#quota-requests').value),billingDisabled:$('#quota-confirm').checked,freeOnly:$('#quota-confirm').checked}});await loadQuota();toast('본인 확인 기반 무료 할당을 저장했습니다.');}catch(e){toast(safeError(e));}};
  $('#capacity-form').onsubmit=async ev=>{ev.preventDefault();try{await api('/api/live/capacity',{method:'PUT',body:capacityPayload()});await loadCapacity();toast('공급자 잔여량 관측을 저장했습니다. 60초 뒤 다시 확인해야 합니다.');}catch(e){toast(safeError(e));}};
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
