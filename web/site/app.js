import {planMp3,prepareMp3Chunk} from '/audio.mjs';
import {runAudioChunks,runSummaryStages,runApprovedFreeBatch,runApprovedGroqSummary,detailRequestIsCurrent,beginDetailAction} from '/audio-runner.mjs';
import {audioProgressPlan,cleanedAudioComplete,fmtRetryDate} from '/audio-progress-plan.mjs';
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
function audioPlanView(job,progress,target){
 if(progress?.temporaryResultsCleaned){target.append(el('p',{className:'tip',text:cleanedAudioComplete(progress,job)?'임시 조각은 정리됐습니다. 저장된 전체 전사 완료 기록이 있으며 TXT와 리포트에서 결과를 확인하세요.':'임시 조각 정보가 없습니다. 저장된 완료 기록을 확인할 수 없어 진행률과 견적을 표시하지 않습니다.'}));return;}
 const plan=audioProgressPlan(progress,job.duration_seconds);
 if(!plan.valid){if(plan.planIncomplete)target.append(el('p',{className:'tip',text:`저장 확인된 원본 시간축 ${Math.round(plan.coveredSeconds/60*10)/10} / ${Math.round(job.duration_seconds/60*10)/10}분. 조각 계획이 전체 원본을 덮지 않아 남은 조각 수와 견적은 확인할 수 없습니다.`}));else target.append(el('p',{className:'tip',text:'조각 계획이나 시간 정보가 없어 진행률과 견적을 확인할 수 없습니다.'}));return;}
 const seconds=value=>`${Math.round(value/60*10)/10}분`;
 resultLine(target,'저장된 원본 시간축',`${seconds(plan.coveredSeconds)} / ${seconds(job.duration_seconds)} (중복 구간 제외, 내용 검증 아님)`);
 resultLine(target,'남은 전사 작업',`${plan.remainingChunks} / ${plan.totalChunks} 조각 · 미확인 시간축 ${seconds(plan.remainingSeconds)}`);
 if(plan.complete){target.append(el('p',{className:'tip',text:'모든 조각이 저장됐습니다. 저장된 전사·요약을 별도로 확인하세요.'}));return;}
 const next={REVIEW_REQUIRED:'불명확한 요청 결과를 먼저 검토하세요.',PROVIDER_RETRY:'다음 조각은 공급자의 429 요청 기록과 재시도 가능 시각을 직접 확인해야 합니다. Gemini 경로의 무료 여부는 확인되지 않았습니다.',LOCAL_EARLIEST:'Groq 경로의 앱 내 가장 이른 요청 시각입니다. 계정 잔여량, 공급자 허용이나 완료 시각을 보장하지 않습니다.',UNKNOWN_PROBE_WAIT:'Groq Free 1회 탐침의 앱 내 대기 시각입니다. 조직 잔여량은 UNKNOWN이며 이 시각에 전송이 보장되지 않습니다.',UNKNOWN_CAPACITY_PROBE:'승인된 Groq Free 1회 탐침만 가능합니다. 조직 잔여량과 완료 가능 여부는 UNKNOWN입니다.',OPERATION_IN_FLIGHT:'Groq 요청이 진행 중입니다. 결과를 확인하기 전 재전송하지 마세요.',NO_VERIFIED_FREE_PATH:'현재 표시할 수 있는 무료 경로가 없습니다. Gemini 계정의 무료 여부는 확인되지 않았습니다.',CAPACITY_UNKNOWN:'Groq의 다음 요청 가능 시각과 계정 잔여량은 UNKNOWN입니다.'}[plan.nextKind]??'다음 조각 상태를 확인하세요.';
 target.append(el('p',{text:`다음 조각 ${plan.nextIndex+1}: ${next}${plan.nextAt?' · '+fmtRetryDate(plan.nextAt):''}`}));
 target.append(el('p',{className:'tip',text:'Groq Free의 최신 상태를 확인하고 기다리거나 같은 MP3로 나중에 재개할 수 있습니다. 다른 무료 제공자 경로는 이 화면에서 검증하지 않았습니다. 요청은 로그인한 브라우저가 활성화된 동안에만 진행됩니다. 완료·미확정 기록은 보존됩니다. Gemini Tier 1 용량은 무료로 표시하지 않습니다.'}));
 const choices=el('div',{className:'library-actions'}),guidance=el('p',{className:'tip'});
 const wait=el('button',{className:'btn secondary small',text:'확인된 무료 경로 기다리기'});
 wait.onclick=()=>{guidance.textContent='Groq Free 계정 상태와 최신 잔여량·재시도 가능 시각을 공급자에서 확인하세요. 대기만으로 요청이 시작되거나 완료가 보장되지는 않습니다.';};
 const later=el('button',{className:'btn secondary small',text:'나중에 같은 MP3로 재개'});
 later.onclick=()=>{guidance.textContent=`분석 ID ${job.id}를 새 분석 화면의 재개 입력에 넣고 동일한 MP3를 다시 선택하세요. DONE 조각과 미확정 요청 기록은 그대로 유지됩니다. 브라우저를 닫아도 백그라운드 전사는 진행되지 않습니다.`;};
 const estimate=el('button',{className:'btn secondary small',text:'남은 작업 유료 견적 살펴보기'});
 estimate.onclick=()=>{estimate.disabled=true;target.append(el('p',{text:`남은 작업 범위: 미확인 시간축 ${seconds(plan.remainingSeconds)}, 미완료 조각 ${plan.remainingChunks}개 · 조각 겹침을 포함한 1회 요청 길이 ${seconds(plan.remainingRequestSeconds)}. 조각마다 최소 10초를 적용한 참고 청구 길이는 ${seconds(plan.billableGroqSeconds)}입니다. Groq Whisper Large v3 Turbo의 2026-10-11 공개 요금 $0.04/시간 기준 음성 전사 소계만 약 $${plan.referenceGroqUsd.toFixed(4)}입니다. 재시도·이전 미확정 요청의 청구, 요약 비용, 세금은 제외한 참고치이며 작업 완료 가격이나 승인된 지출 상한이 아닙니다. 실행 전 모델 접근과 현재 요금을 다시 확인해야 합니다. 이 화면에서 유료 호출이나 승인은 실행되지 않습니다.`}),el('a',{text:'Groq 공식 모델 요금 ↗',attrs:{href:'https://console.groq.com/docs/model/whisper-large-v3-turbo',target:'_blank',rel:'noopener noreferrer'}}));};
 choices.append(wait,later,estimate);target.append(choices,guidance);
}
function showReport(job,container,persisted){empty(container);
  resultLine(container,'상태',job.status??'NOT_RUN');if(job.id)resultLine(container,'분석 ID',job.id);
  resultLine(container,'저장 상태',persisted?'D1 저장':'미저장 / DB 미설정');
  if(job.audit){resultLine(container,'전사 범위',Number.isFinite(job.audit.timelineRatio)?`${Math.round(job.audit.timelineRatio*1000)/10}% (시간축 추정)`:'확인 불가');resultLine(container,'범위 설명',job.audit.reason??'확인 필요');}
  const report=job.report;
  if(report){
    if(['GEMINI_EVIDENCE_LINKED','GROQ_EVIDENCE_LINKED'].includes(report.kind)){for(const [key,label] of [['summary','핵심 요약'],['chapters','시간대별 요약'],['claims','주장과 근거'],['numbers','수치와 확인 항목'],['critical','비판적 분석']]){container.append(el('h3',{text:label}));const list=el('ul');for(const item of report[key]||[])list.append(el('li',{text:item.text+' (원문 #'+item.evidenceIds.join(', #')+')'}));container.append(list);}container.append(el('h3',{text:'결론'}),el('p',{text:report.conclusion}),el('p',{className:'tip',text:report.warning}));}else{const h=el('h3',{text:'원문 추출 · AI 요약 아님'});container.append(h);
    const list=el('ol');for(const sentence of report.summary??[])list.append(el('li',{text:sentence}));container.append(list);
    container.append(el('p',{className:'subtitle',text:report.warning??'실제 AI 모델 분석·번역은 수행되지 않았습니다.'}));}
  }else container.append(el('p',{className:'subtitle',text:'AI 요약은 아직 없습니다. 전사 완료 후 저장된 원문과 내보내기를 확인할 수 있습니다.'}));
  if(job.id){const tools=el('div',{className:'library-actions'});for(const format of ['md','txt'])tools.append(el('a',{className:'btn secondary small',text:format.toUpperCase()+' 내보내기',attrs:{href:'/api/jobs/'+job.id+'/export?format='+format}}));const source=el('button',{className:'btn secondary small',text:'원문·근거 보기'});source.onclick=async()=>{try{const data=await api('/api/jobs/'+job.id+'/source'),uncertain=new Set((data.audioBoundaryAmbiguities||[]).map(x=>x.segmentId)),warning=data.audioBoundaryAmbiguityCount?`겹침 경계 검토 필요: 서로 다른 전사 표현 ${data.audioBoundaryAmbiguityCount}개를 보존했습니다. 중복 여부와 정확한 표현은 독립 청취로 확인해야 합니다.\n\n`:'';const pre=el('pre',{text:data.source?.segments?.length?warning+(data.source.segments).map(x=>'#'+x.id+(uncertain.has(x.id)?' [겹침 경계·발언 확인 필요]':'')+' ['+(x.startMs===null?'시각 미확인':Math.floor(x.startMs/1000)+'초')+'] '+x.text).join('\n'):'저장된 전체 전사가 아직 없습니다.'});container.append(pre);source.disabled=true;}catch(e){toast(safeError(e));}};tools.append(source);if(!['GEMINI_EVIDENCE_LINKED','GROQ_EVIDENCE_LINKED'].includes(report?.kind)){const review=el('button',{className:'btn secondary small',text:'요약 부분 출력 검토'});review.onclick=async()=>{try{const data=await api('/api/jobs/'+job.id+'/summary-review');container.append(el('pre',{text:data.partialText}));review.disabled=true;}catch(error){toast(safeError(error));}};tools.append(review);}container.append(tools);}
}
async function handleAnalyze(ev){ev.preventDefault();const button=$('#run-button'),progress=$('#analysis-progress');let data,bytes,plan;
 const mode=state.mode,execution=Object.freeze({batch:$('#audio-free-batch-run').checked,provider:$('#audio-provider').value,geminiConsent:$('#audio-gemini-confirm').checked,resume:$('#resume-job').value.trim(),file:$('#audio-file').files[0],rights:$('#audio-rights').checked});
 const live=$('#live-analysis').checked;const title=$('#video-title').value.trim();const duration=Number($('#duration-min').value);
 if(!Number.isInteger(duration)||duration<1||duration>120){toast('영상 길이는 1~120분입니다.');return;}
 button.disabled=true;
 try{
  if(execution.batch&&(mode!=='audio'||!live||!execution.resume||execution.provider!=='groq'||execution.geminiConsent))throw Error('제한 배치는 기존 분석 ID와 Groq만 사용하며 Gemini 동의는 선택하지 마세요.');
  const submittedScope=execution.batch?await api('/api/jobs/'+encodeURIComponent(execution.resume)+'/audio-free-batch'):null;
  if(execution.batch&&(!submittedScope?.approved||submittedScope.jobId!==execution.resume||submittedScope.state!=='APPROVED'))throw Error('제출 시점의 유효한 Groq Free 배치 승인을 확인하세요.');
  if(mode==='url')data={sourceType:'url',url:$('#youtube-url').value.trim(),durationSeconds:duration*60,title};
  else if(mode==='text'){const file=$('#caption-file').files[0];if(!file||!/\.(srt|vtt|txt)$/i.test(file.name)||file.size>2000000)throw Error('2MB 이하 SRT/VTT/TXT를 선택하세요.');data={sourceType:'text',filename:file.name,transcript:await file.text(),durationSeconds:duration*60,title:title||file.name,persistTranscript:true};}
  else{const file=execution.file;if(!file||!/\.mp3$/i.test(file.name)||file.size>200000000)throw Error('200MB 이하 MP3를 선택하세요.');if(!live||!execution.rights)throw Error('무료 API 처리와 적법한 보유 음성 업로드 동의가 필요합니다.');progress.textContent='MP3 시간축 및 조각 계획 확인 중…';bytes=new Uint8Array(await file.arrayBuffer());plan=planMp3(bytes);data={sourceType:'audio',durationSeconds:plan.durationSeconds,title:title||file.name};}
  await api('/api/preflight',{method:'POST',body:data});progress.textContent='분석 기록 생성 중…';let result;const resume=mode==='audio'?execution.resume:'';if(resume){result=await api('/api/jobs/'+encodeURIComponent(resume));if(result.job.source_type!=='audio'||Math.abs(result.job.duration_seconds-plan.durationSeconds)>1)throw Error('선택한 음성과 이전 분석이 다릅니다.');result.persisted=true;}else result=await api('/api/jobs',{method:'POST',body:data});const id=result.job.id;
  $('#result-panel').hidden=false;showReport(result.job,$('#result-content'),result.persisted);
  if(live){
   if(mode==='url'){progress.textContent='기존 자막 조회 중…';result=await api('/api/jobs/'+id+'/native',{method:'POST',body:{}});if(['NEED_UPLOAD','NATIVE_PENDING'].includes(result.job.status)){showReport(result.job,$('#result-content'),true);throw Error(result.job.status==='NATIVE_PENDING'?'제공자 처리 대기: 이력에서 자막 결과 조회를 사용하세요.':'기존 자막이 없습니다. 보유 음성/자막을 사용하세요.');}}
   if(mode==='audio'){
    const fileSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
    if(execution.batch&&submittedScope.fileSha256!==fileSha256)throw Error('제출 시점에 승인된 MP3와 선택한 파일이 다릅니다.');
    await api('/api/jobs/'+id+'/audio-plan',{method:'POST',body:{rightsConfirmed:true,fileSha256,chunks:plan.chunks.map(({index,start,end})=>({index,start,end}))}});
    if(execution.batch){
     const scope=submittedScope;
     const run=await runApprovedFreeBatch({jobId:id,fileSha256,approvedChunkIds:scope.chunkIds,chunks:plan.chunks,getBatch:()=>api('/api/jobs/'+id+'/audio-free-batch'),getProgress:()=>api('/api/jobs/'+id+'/audio-progress'),foreground:()=>!document.hidden,now:Date.now,wait:waitForeground,onUpdate:status=>{progress.textContent='Groq Free 제한 배치 · 조각 '+(status.index+1)+(status.done?' 저장됨':' 전송 중')+' · 분석 '+id;},sendChunk:async c=>{const prepared=prepareMp3Chunk(bytes.subarray(c.byteStart,c.byteEnd));const response=await fetch('/api/jobs/'+id+'/audio-chunk?index='+c.index+'&provider=groq&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream','x-groq-free-batch':'true'},credentials:'same-origin',body:prepared.bytes});const data=await response.json();return response.ok?data:{code:data.error?.code||'AUDIO_SEND_FAILED'};}});
     if(!run.complete)throw Error('Groq Free 제한 배치 중단: '+run.reason+' · 조각 '+((run.index??scope.chunkIds?.[0]??0)+1)+' · 분석 '+id+'. 이력과 제공자 상태를 확인하세요.');
     progress.textContent='승인된 Groq Free 조각 전송이 끝났습니다. 전사 병합·요약은 별도 검토 후 진행하세요. 분석 '+id;toast('제한 배치 전송이 끝났습니다.');return;
    }
    if(execution.geminiConsent)await api('/api/jobs/'+id+'/audio-consent',{method:'POST',body:{provider:'gemini',fileSha256,consent:true}});
    const run=await runAudioChunks({chunks:plan.chunks,getProgress:()=>api('/api/jobs/'+id+'/audio-progress'),getCapacity:()=>api('/api/live/capacity'),getQuota:()=>api('/api/live/quota'),now:Date.now,foreground:()=>!document.hidden,
     chooseProvider:()=>execution.provider,authorizedProviders:()=>['groq',...(execution.geminiConsent?['gemini']:[])],
     review429:async(c,saved)=>confirm('조각 '+(c.index+1)+'의 '+saved.reviewProvider+' 공식 요청 로그에서 429 거절과 출력 없음, 재시도 가능 시각을 확인했나요?')?saved.reviewOperationId:null,
     wait:waitForeground,
     onUpdate:status=>{progress.textContent=status.waitingUntil?'제공자 호출 간격 대기 중 · '+fmtDate(status.waitingUntil):'음성 전사 '+(status.index+1)+' / '+plan.chunks.length+' · 기록 '+id;},
     sendChunk:async(c,provider,reviewedId,options)=>{const prepared=prepareMp3Chunk(bytes.subarray(c.byteStart,c.byteEnd));const response=await fetch('/api/jobs/'+id+'/audio-chunk?index='+c.index+'&provider='+provider+'&name=chunk.mp3',{method:'POST',headers:{'content-type':'application/octet-stream',...(reviewedId?{'x-provider-log-429-no-output-confirmed':'true','x-provider-log-429-operation-id':reviewedId}:{}),...(options?.unknownCapacityProbe?{'x-groq-free-unknown-probe':'true'}:{})},credentials:'same-origin',body:prepared.bytes});const result=await response.json();return response.ok?result:{code:result.error?.code||'AUDIO_SEND_FAILED'};}});
    if(!run.complete)throw Error('음성 전사를 일시 중단했습니다: '+run.reason+' · 조각 '+((run.index??0)+1)+' · 기록 '+id+'. 제공자 관측치와 이력을 확인한 뒤 같은 파일로 재개하세요.');
    result=await api('/api/jobs/'+id+'/audio-finish',{method:'POST',body:{}});showReport(result.job,$('#result-content'),true);
   }
   const summaryPlan=await api('/api/jobs/'+id+'/summary-plan');
   progress.textContent='원문 근거 연결 요약 '+summaryPlan.stages+'개 구간 작성 중… 첫 단계 예약 상한 '+summaryPlan.firstPassUnits+' 단위. 할당이 부족하면 완료 단계만 보관하고 중단합니다.';
   const staged=summaryPlan.firstPassUnits>250000;if(staged&&!confirm('이 원문은 첫 단계만 '+summaryPlan.firstPassUnits+' 단위가 필요합니다. 여러 차례 무료 할당 확인이 필요할 수 있고 최종 합성 비용은 아직 모릅니다. 단계별로 진행할까요?'))throw Error('단계별 요약을 시작하지 않았습니다.');
   const summary=await runSummaryStages({getProgress:()=>api('/api/jobs/'+id+'/audio-progress'),getCapacity:()=>api('/api/live/capacity'),getQuota:()=>api('/api/live/quota'),sendSummary:()=>api('/api/jobs/'+id+'/summary',{method:'POST',body:{allowStaged:staged}}),wait:waitForeground,foreground:()=>!document.hidden,onUpdate:status=>{progress.textContent=status.waitingUntil?'Gemini 요약 호출 간격 대기 중 · '+fmtDate(status.waitingUntil):'요약 단계 '+(status.stage+1)+' 저장됨 · 기록 '+id;}});
   if(!summary.complete)throw Error('요약을 일시 중단했습니다: '+summary.reason+' · 기록 '+id+'. 공급자 관측치와 사용량을 확인한 뒤 이력에서 계속하세요.');
   result=summary.result;
  }
  showReport(result.job,$('#result-content'),result.persisted);progress.textContent='처리 결과를 저장했습니다. 완전 전사·외부 사실 검증 상태는 리포트를 확인하세요.';toast('분석 결과 저장 완료');
 }catch(e){progress.textContent=safeError(e)+' — 완료된 원문과 조각은 이력에 보관됩니다. 불명확한 API 요청은 자동 재시도하지 않습니다.';toast(safeError(e));}finally{button.disabled=false;}
}
function detailCurrent(jobId,requestId,target){return detailRequestIsCurrent({expectedRequestId:requestId,currentRequestId:libraryDetailRequest,expectedJobId:jobId,visibleJobId:target.dataset.jobId,view:state.view,hidden:target.hidden});}
function showFreeBatchChoice(job,target,requestId){
 const button=el('button',{className:'btn secondary small',text:'Groq Free 제한 배치 검토'});
 button.onclick=async()=>{button.disabled=true;try{
  if(!detailCurrent(job.id,requestId,target))return;
  const scope=await api('/api/jobs/'+job.id+'/audio-free-batch');
  if(!detailCurrent(job.id,requestId,target))return;
  if(scope.approved){target.append(el('p',{text:`Groq Free 배치 ${scope.state} · ${scope.chunkIds.length}조각 · 앱 예약 상한 ${scope.maxAudioSeconds}초 · 만료 ${fmtRetryDate(scope.expiresAt)}. 계정 잔여량 UNKNOWN. 같은 MP3로 새 분석에서 제한 배치 실행을 직접 선택하세요.`}));return;}
  const form=el('form',{className:'fields'});
  form.append(el('p',{text:`대상 조각 ${scope.chunkIds.map(index=>index+1).join(', ')} · 정확히 ${scope.maxRequests}회 · 업로드 시간 상한 ${scope.maxAudioSeconds}초 · 원본 SHA-256 ${scope.fileSha256}. Groq 조직 잔여량은 UNKNOWN이며 첫 429 또는 불명확한 오류에서 중단합니다. 승인은 1시간 후 만료되고 자동 갱신되지 않습니다. 요약과 유료 전환은 하지 않습니다.`}));
  const labels=['현재 Groq 계정이 Free이고 이 키에서 결제가 비활성임을 확인했습니다.','계정 전체 잔여량 UNKNOWN과 지정 조각만 요청함을 이해합니다.','첫 429·오류에서 멈추고, 요약·유료 전환 없이 종료함을 확인합니다.'];
  const checks=labels.map(label=>{const input=el('input',{attrs:{type:'checkbox',required:'true'}}),row=el('label',{text:label});row.prepend(input);form.append(row);return input;});
  const submit=el('button',{className:'btn secondary small',text:'이 배치 범위 승인 기록'});form.append(submit);
  form.onsubmit=async event=>{event.preventDefault();if(!detailCurrent(job.id,requestId,target))return;submit.disabled=true;try{await api('/api/jobs/'+job.id+'/audio-free-batch',{method:'POST',body:{provider:'groq',model:scope.model,jobId:job.id,fileSha256:scope.fileSha256,chunkIds:scope.chunkIds,maxRequests:scope.maxRequests,maxAudioSeconds:scope.maxAudioSeconds,freeTierConfirmed:checks[0].checked,billingDisabled:checks[0].checked,unknownCapacityAcknowledged:checks[1].checked,oneBatchOnly:checks[1].checked,noPaidFallback:checks[2].checked,stopOnFirstError:checks[2].checked,stopBeforeSummary:checks[2].checked}});if(detailCurrent(job.id,requestId,target))form.replaceWith(el('p',{text:'제한 배치 승인 저장됨. 같은 MP3와 분석 ID로 새 분석에서 Groq Free 제한 배치를 직접 실행하세요.'}));}catch(error){toast(safeError(error));submit.disabled=false;}};
  target.append(form);
 }catch(error){toast(safeError(error));button.disabled=false;}};
 target.append(button);
}
function showGroqSummaryChoice(job,target,requestId){
 const button=el('button',{className:'btn secondary small',text:'Groq Free 요약 범위 검토'});
 button.onclick=async()=>{button.disabled=true;try{
  if(!detailCurrent(job.id,requestId,target))return;
  const scope=await api('/api/jobs/'+job.id+'/groq-summary-approval');
  if(!detailCurrent(job.id,requestId,target))return;
  const panel=el('div',{className:'fields'});
  panel.append(el('p',{text:scope.finalizationReady?`전사 SHA-256 ${scope.transcriptHash} · 모든 추론 단계가 저장됐습니다. 저장된 보고서를 최종 확인하고 저장할 수 있습니다. 추가 모델 요청은 없습니다.`:`전사 SHA-256 ${scope.transcriptHash} · ${scope.model} · 이번 승인 창 ${scope.windowStart+1}단계부터 최대 ${scope.maxRequests}회 (계획 최대 ${scope.totalRequests}회) · 요청당 입력 ${scope.maxInputTokensPerRequest} / 완료 ${scope.maxCompletionTokensPerRequest} 토큰 · 이번 창의 앱 예약 상한 ${scope.totalTokenUpperBound} 토큰. 실제 계정 잔여량은 UNKNOWN입니다. 긴 전사는 다음 창의 별도 승인과 앱 일일 상한 재설정이 필요할 수 있습니다.`}));
  if(scope.finalizationReady){const finalize=el('button',{className:'btn secondary small',text:'저장된 요약 최종 저장'});finalize.onclick=async()=>{finalize.disabled=true;try{const result=await runApprovedGroqSummary({jobId:job.id,scope,getApproval:()=>api('/api/jobs/'+job.id+'/groq-summary-approval'),sendStage:body=>api('/api/jobs/'+job.id+'/groq-summary',{method:'POST',body}),wait:waitForeground,foreground:()=>!document.hidden&&detailCurrent(job.id,requestId,target)});if(!result.complete)throw Error('요약 최종 저장 중단: '+result.reason);if(detailCurrent(job.id,requestId,target)){empty(target);showReport(result.result.job,target,true);}toast('Groq Free 요약이 저장됐습니다.');}catch(error){toast(safeError(error));finalize.disabled=false;}};panel.append(finalize);
  }else if(scope.approved){
   panel.append(el('p',{text:`승인 상태 ${scope.state} · 만료 ${fmtRetryDate(scope.expiresAt)}. 실행은 별도 선택입니다.`}));
   if(scope.state==='APPROVED'){const run=el('button',{className:'btn secondary small',text:'승인된 Groq Free 요약 실행'});run.onclick=async()=>{run.disabled=true;try{
    const outcome=await runApprovedGroqSummary({jobId:job.id,scope,getApproval:()=>api('/api/jobs/'+job.id+'/groq-summary-approval'),sendStage:body=>api('/api/jobs/'+job.id+'/groq-summary',{method:'POST',body:body||{}}),wait:waitForeground,foreground:()=>!document.hidden&&detailCurrent(job.id,requestId,target),onUpdate:status=>{panel.append(el('p',{text:`요약 단계 ${status.stage} 저장됨 · 분석 ${job.id}`}));}});
    if(outcome.reason==='SUMMARY_WINDOW_COMPLETE'){panel.append(el('p',{text:'이번 요약 승인 창이 완료됐습니다. 분석을 다시 열어 남은 단계를 별도로 검토하고 승인하세요. 앱 일일 상한이 재설정될 때까지 기다려야 할 수 있습니다.'}));return;}
    if(!outcome.complete)throw Error('Groq Free 요약 중단: '+outcome.reason+' · 분석 '+job.id+'. 이력과 제공자 사용량을 확인하세요.');
    if(detailCurrent(job.id,requestId,target)){empty(target);showReport(outcome.result.job,target,true);}toast('Groq Free 요약이 저장됐습니다.');
   }catch(error){toast(safeError(error));run.disabled=false;}};panel.append(run);}
  }else{
   const form=el('form',{className:'fields'}),labels=['현재 이 Groq 키가 Free 조직에 속하고 결제가 비활성임을 확인했습니다.','계정 잔여 토큰은 UNKNOWN이며 표시된 요청·토큰 상한을 승인합니다.','유료 전환·Gemini 대체 없이 첫 429 또는 불명확한 결과에서 멈춥니다.'];
   const checks=labels.map(label=>{const input=el('input',{attrs:{type:'checkbox',required:'true'}}),row=el('label',{text:label});row.prepend(input);form.append(row);return input;});
   const submit=el('button',{className:'btn secondary small',text:'이 요약 범위 승인 기록'});form.append(submit);form.onsubmit=async event=>{event.preventDefault();if(!detailCurrent(job.id,requestId,target))return;submit.disabled=true;try{
    await api('/api/jobs/'+job.id+'/groq-summary-approval',{method:'POST',body:{jobId:job.id,transcriptHash:scope.transcriptHash,model:scope.model,windowStart:scope.windowStart,totalRequests:scope.totalRequests,maxRequests:scope.maxRequests,maxInputTokensPerRequest:scope.maxInputTokensPerRequest,maxCompletionTokensPerRequest:scope.maxCompletionTokensPerRequest,totalTokenUpperBound:scope.totalTokenUpperBound,credentialGeneration:scope.credentialGeneration,freeTierConfirmed:checks[0].checked,billingDisabled:checks[0].checked,unknownBalanceAcknowledged:checks[1].checked,noPaidFallback:checks[2].checked,noGeminiFallback:checks[2].checked,summaryOnly:true}});
    if(detailCurrent(job.id,requestId,target))form.replaceWith(el('p',{text:'Groq Free 요약 승인 저장됨. 실행은 별도로 선택하세요.'}));
   }catch(error){toast(safeError(error));submit.disabled=false;}};panel.append(form);
  }
  target.append(panel);
 }catch(error){toast(safeError(error));button.disabled=false;}};target.append(button);
}
function showUnknownGroqProbeChoice(job,chunk,target,requestId){
 const button=el('button',{className:'btn secondary small',text:'조각 '+(chunk.index+1)+' 무료 1회 탐침 검토'});
 button.onclick=async()=>{button.disabled=true;try{
  if(!detailCurrent(job.id,requestId,target))return;
  const evidence=await api('/api/jobs/'+job.id+'/audio-recovery?index='+chunk.index),form=el('form',{className:'fields'});
  if(!detailCurrent(job.id,requestId,target))return;
  form.append(el('p',{text:'Groq 조직 잔여량은 UNKNOWN입니다. 429 대기 후 미완료 조각을 한 번만 전사 요청합니다. 이전 Gemini 요청의 사용량과 중복 가능성은 그대로 남습니다. 성공해도 전체 무료 할당량이 복구됐다고 간주하지 않으며, 429 또는 시간 초과 뒤 자동 재시도하지 않습니다.'}),el('p',{text:'대상 조각 '+(chunk.index+1)+' · 파일 SHA-256 '+evidence.fileSha256+' · Gemini 작업 '+evidence.geminiOperationId+' · Groq 429 작업 '+evidence.groq429OperationId}));
  const checks=[['Groq 계정이 현재 Free이고 이 키에서 결제가 비활성임을 확인했습니다.','free'],['조직 잔여량 UNKNOWN을 인정합니다.','unknown'],['이전 Gemini 사용 가능성과 중복 전사 위험을 인정합니다.','risk'],['이 조각의 요청 한 번만 승인합니다.','once']].map(([label])=>{const input=el('input',{attrs:{type:'checkbox',required:'true'}}),row=el('label',{text:label});row.prepend(input);form.append(row);return input;});
  const submit=el('button',{className:'btn secondary small',text:'Groq Free 1회 탐침 승인'});form.append(submit);
  form.onsubmit=async event=>{event.preventDefault();if(!detailCurrent(job.id,requestId,target))return;submit.disabled=true;try{await api('/api/jobs/'+job.id+'/audio-free-probe',{method:'POST',body:{index:chunk.index,provider:'groq',model:'whisper-large-v3-turbo',fileSha256:evidence.fileSha256,geminiOperationId:evidence.geminiOperationId,groq429OperationId:evidence.groq429OperationId,freeTierConfirmed:checks[0].checked,billingDisabled:checks[0].checked,unknownCapacityAcknowledged:checks[1].checked,acknowledgePossibleGeminiUsage:checks[2].checked,acknowledgeDuplicateTranscriptionRisk:checks[2].checked,oneRequestOnly:checks[3].checked}});if(detailCurrent(job.id,requestId,target))form.replaceWith(el('p',{text:'1회 탐침 승인됨. 같은 MP3와 Groq를 선택해 재개하세요. 전송은 별도 실행 시에만 일어납니다.'}));toast('1회 Groq Free 탐침을 승인했습니다.');}catch(error){toast(safeError(error));submit.disabled=false;}};
  target.append(form);
 }catch(error){toast(safeError(error));button.disabled=false;}};target.append(button);
}
function showBoundaryReconcileChoice(job,target,requestId){
 if(job.source_type!=='audio'||job.audit?.audioProcessingCoverage!==1||job.report)return;
 const path='/api/jobs/'+encodeURIComponent(job.id)+'/audio-boundary-reconcile';
 const review=el('button',{className:'btn secondary small',text:'전사 겹침 경계 표시 검토'});
 const isCurrent=()=>{const valid=detailCurrent(job.id,requestId,target);if(!valid)review.disabled=false;return valid;};
 review.onclick=async()=>{
  if(review.disabled||!isCurrent())return;
  review.disabled=true;
  try{
   const preview=await api(path);
   if(!isCurrent())return;
   const panel=el('div',{className:'fields'});
   panel.append(el('p',{text:`분석 ${preview.jobId} · 원본 SHA-256 ${preview.audioFileSha256} · 보존된 발언 ${preview.sourceSegmentCount}개 · 현재 경계 표시 ${preview.currentMarkerIds.length}개 → 재검토 표시 ${preview.revisedMarkerIds.length}개.`}));
   if(preview.changed)panel.append(el('p',{text:'추가로 검토할 원문 ID: '+preview.revisedMarkerIds.filter(id=>!preview.currentMarkerIds.includes(id)).map(id=>'#'+id).join(', ')}));
   panel.append(el('p',{className:'tip',text:'저장된 전사 발언·시각·파일 지문 및 PC·Library 원본은 유지됩니다. 이 작업은 서로 다른 표현이 겹치는 경계의 검토 표시만 갱신합니다. 새 표시를 반영한 요약은 별도 범위 검토와 승인이 필요하며 여기서는 모델을 호출하지 않습니다.'}));
   if(!preview.changed){panel.append(el('p',{text:'경계 표시가 이미 최신 상태입니다. 추가 저장은 필요하지 않습니다.'}));review.disabled=false;target.append(panel);return;}
   const acknowledge=el('input',{attrs:{type:'checkbox'}}),label=el('label',{text:'표시 변경 범위와 전사 원본 보존을 확인했습니다.'}),save=el('button',{className:'btn secondary small',text:'경계 표시만 저장'}),cancel=el('button',{className:'btn secondary small',text:'취소'});
   label.prepend(acknowledge);save.disabled=true;acknowledge.onchange=()=>{save.disabled=!acknowledge.checked;};
   let pending=false;
   cancel.onclick=()=>{if(pending)return;panel.remove();review.disabled=false;};
   save.onclick=async()=>{
    if(pending||!acknowledge.checked||!isCurrent())return;
    pending=true;save.disabled=true;cancel.disabled=true;
    try{
     const saved=await api(path,{method:'POST',body:{jobId:preview.jobId,audioFileSha256:preview.audioFileSha256,currentMarkerIds:preview.currentMarkerIds,revisedMarkerIds:preview.revisedMarkerIds,confirmBoundaryMetadataReconcile:true}});
     if(!isCurrent())return;
     const current=await api('/api/jobs/'+encodeURIComponent(job.id));
     if(!isCurrent())return;
     if(current.job?.id!==job.id||current.job?.audit?.audioProcessingCoverage!==1)throw Error('저장된 작업 상태를 다시 확인하세요.');
     empty(target);showReport(current.job,target,true);
     target.append(el('p',{text:saved.reconciled?'경계 검토 표시를 저장했습니다. 전사 발언과 TXT는 유지됩니다.':'경계 검토 표시가 이미 저장돼 있습니다.'}));
     try{
      const verified=await api(path);
      if(!isCurrent())return;
      if(verified.changed||verified.audioFileSha256!==preview.audioFileSha256||verified.sourceSegmentCount!==preview.sourceSegmentCount||JSON.stringify(verified.currentMarkerIds)!==JSON.stringify(preview.revisedMarkerIds))throw Error('저장된 경계 표시를 다시 확인하세요.');
      resultLine(target,'저장된 경계 표시',`${verified.currentMarkerIds.length}개 · 발언 ${verified.sourceSegmentCount}개`);
      const plan=await api('/api/jobs/'+encodeURIComponent(job.id)+'/groq-summary-plan');
      if(!isCurrent())return;
      resultLine(target,'새 요약 계획',`원문 ${plan.rawStages}단계 · 전체 최대 ${plan.totalRequests}요청 · 원본 범위 ${plan.transcriptHash}`);
      target.append(el('p',{className:'tip',text:'요약 계획은 읽기 전용으로 확인했습니다. 모델 호출과 요약 승인은 시작되지 않았습니다.'}));
     }catch(error){if(isCurrent())target.append(el('p',{className:'tip',text:'경계 표시는 저장됐습니다. 후속 조회를 다시 확인하세요: '+safeError(error)}));}
    }catch(error){if(isCurrent()){toast(safeError(error));panel.append(el('p',{text:'저장 여부를 이력에서 새로 확인한 뒤 다시 검토하세요.'}));review.disabled=false;}}
   };
   panel.append(label,save,cancel);target.append(panel);
  }catch(error){review.disabled=false;if(isCurrent())toast(safeError(error));}
 };
 target.append(review);
}
function libraryCard(job){
  const card=el('article',{className:'library-item'}),top=el('div',{className:'library-top'}),info=el('div');
  info.append(el('div',{className:'library-title',text:job.title || job.video_id || '제목 없음'}),el('div',{className:'library-meta',text:`${fmtDate(job.created_at)} · ${Math.round(job.duration_seconds/60)}분 · ${job.source_type}`}));
  top.append(info,el('span',{className:'pill'+(job.status?.includes('PARTIAL')?' warning':''),text:job.status}));card.append(top);
  const actions=el('div',{className:'library-actions'}),open=el('button',{className:'btn secondary small',text:'리포트 열기'}),remove=el('button',{className:'btn secondary small',text:'삭제'});
  open.onclick=async()=>{const target=$('#library-detail'),detailRequest=libraryDetailRequest=beginDetailAction(target,job.id,libraryDetailRequest);target.hidden=false;empty(target);target.append(el('p',{text:'저장된 분석을 확인 중…'}));try{const data=await api(`/api/jobs/${encodeURIComponent(job.id)}`);if(!detailCurrent(job.id,detailRequest,target))return;showReport(data.job,target,true);showBoundaryReconcileChoice(data.job,target,detailRequest);if(data.job.source_type==='audio'){const p=await api('/api/jobs/'+job.id+'/audio-progress');if(!detailCurrent(job.id,detailRequest,target))return;audioPlanView(data.job,p,target);if(p.chunks.some(c=>c.state==='PLANNED')&&p.chunks.every(c=>['DONE','PLANNED'].includes(c.state)))showFreeBatchChoice(job,target,detailRequest);for(const chunk of p.chunks.filter(c=>c.uncertainFailure)){const button=el('button',{className:'btn secondary small',text:'조각 '+(chunk.index+1)+' 부분 출력 검토'});button.onclick=async()=>{try{const review=await api('/api/jobs/'+job.id+'/audio-review?index='+chunk.index);target.append(el('pre',{text:review.partialText}));review.disabled=true;}catch(error){toast(safeError(error));}};target.append(button);if(chunk.state==='UNCERTAIN'){const recover=el('button',{className:'btn secondary small',text:'조각 '+(chunk.index+1)+' Groq 무료 재개 검토'});recover.onclick=async()=>{recover.disabled=true;try{if(!detailCurrent(job.id,detailRequest,target))return;const evidence=await api('/api/jobs/'+job.id+'/audio-recovery?index='+chunk.index);if(!detailCurrent(job.id,detailRequest,target))return;const form=el('form',{className:'fields'}),usage=el('input',{attrs:{type:'checkbox',required:'true'}}),duplicate=el('input',{attrs:{type:'checkbox',required:'true'}}),submit=el('button',{className:'btn secondary small',text:'이 조각만 재개 승인'});form.append(el('p',{text:'Gemini 404 요청의 실제 사용량은 0이라고 단정할 수 없습니다. 기존 미확정 기록과 예약 사용량은 유지됩니다. Groq로 다시 전사하면 중복 사용이 생길 수 있습니다. 승인해도 즉시 전송하지 않으며, 새 무료 잔여량 확인 후 같은 MP3로 다시 시작해야 합니다.'}),el('p',{text:'대상 조각 '+(chunk.index+1)+' · 파일 SHA-256 '+evidence.fileSha256+' · Gemini 작업 '+evidence.geminiOperationId+' · Groq 429 작업 '+evidence.groq429OperationId}));const a=el('label',{text:'이전 Gemini 사용 가능성을 인정합니다.'}),b=el('label',{text:'중복 전사 위험을 인정하고 Groq 무료 재개를 선택합니다.'});a.prepend(usage);b.prepend(duplicate);form.append(a,b,submit);form.onsubmit=async ev=>{ev.preventDefault();if(!detailCurrent(job.id,detailRequest,target))return;submit.disabled=true;try{await api('/api/jobs/'+job.id+'/audio-recovery',{method:'POST',body:{index:chunk.index,fileSha256:evidence.fileSha256,geminiOperationId:evidence.geminiOperationId,groq429OperationId:evidence.groq429OperationId,acknowledgePossibleGeminiUsage:usage.checked,acknowledgeDuplicateTranscriptionRisk:duplicate.checked,chooseGroqFree:true}});if(detailCurrent(job.id,detailRequest,target))form.replaceWith(el('p',{text:'승인 기록 저장됨. 새 무료 용량 확인 후 같은 MP3와 Groq 제공자를 선택해 재개하세요.'}));toast('Groq 무료 재개 승인 기록을 저장했습니다.');}catch(error){toast(safeError(error));submit.disabled=false;}};target.append(form);}catch(error){toast(safeError(error));recover.disabled=false;}};target.append(recover);}}for(const chunk of p.chunks.filter(c=>c.reviewedFreeRetryApproved)){target.append(el('p',{text:'조각 '+(chunk.index+1)+'의 Groq 무료 재개 승인됨 · 무료 잔여량은 별도로 확인해야 합니다.'}));if(!chunk.unknownCapacityProbeApproved)showUnknownGroqProbeChoice(job,chunk,target,detailRequest);else target.append(el('p',{text:'조직 잔여량 UNKNOWN 1회 탐침 승인됨 · 동일 MP3와 Groq를 직접 선택해 재개하세요.'}));}}target.scrollIntoView({behavior:'smooth'});}catch(e){if(detailCurrent(job.id,detailRequest,target)){toast(safeError(e));target.append(el('p',{text:'이력 상세 내용을 확인하지 못했습니다. 다시 열어 주세요.'}));}}};
  remove.onclick=async()=>{if(!confirm('이 분석 기록과 저장된 리포트를 삭제할까요?'))return;try{await api(`/api/jobs/${encodeURIComponent(job.id)}`,{method:'DELETE'});await loadLibrary();toast('이력에서 삭제했습니다.');}catch(e){toast(safeError(e));}};
  for(const [action,label] of [['native-poll','자막 결과 조회'],['summary','요약 생성'],['audio-finish','전사 병합'],...(job.source_type==='audio'?[['audio-cleanup','임시 전사 조각 정리']]:[])]){const b=el('button',{className:'btn secondary small',text:label});b.onclick=async()=>{b.disabled=true;let target,detailRequest;try{let body={};if(action==='summary'){const p=await api('/api/jobs/'+job.id+'/summary-plan');if(p.firstPassUnits>250000){if(!confirm('첫 단계 예약 상한 '+p.firstPassUnits+' 단위, 최종 합성 비용은 미정입니다. 무료 할당을 단계별로 확인하며 계속할까요?'))return;body={allowStaged:true};}}if(action==='audio-cleanup'){if(!confirm('저장된 TXT 전사를 확인한 뒤 서비스의 임시 조각 전사 기록만 정리할까요? PC와 Library 원본은 유지됩니다.'))return;body={confirmTemporaryTranscriptCleanup:true};}target=$('#library-detail');detailRequest=libraryDetailRequest=beginDetailAction(target,job.id,libraryDetailRequest);target.hidden=false;empty(target);target.append(el('p',{text:'저장된 작업 상태 확인 중…'}));const d=await api('/api/jobs/'+job.id+'/'+action,{method:'POST',body});if(!detailCurrent(job.id,detailRequest,target))return;showReport(d.job,target,true);if(d.pending)toast('요약 단계 저장됨. 약 '+d.minimumWaitSeconds+'초 뒤 다시 누르세요.');else if(action==='audio-cleanup')toast(d.alreadyCleaned?'이미 정리됐습니다.':'임시 조각 전사 기록을 정리했습니다.');}catch(e){toast(safeError(e));if(target&&detailCurrent(job.id,detailRequest,target))target.append(el('p',{text:'작업 결과를 확인하지 못했습니다. 이력에서 다시 확인하세요.'}));}finally{b.disabled=false;}};actions.append(b);}if(job.source_type==='audio'&&!job.report){const free=el('button',{className:'btn secondary small',text:'Groq Free 요약 승인·실행'});free.onclick=()=>{const target=$('#library-detail'),detailRequest=libraryDetailRequest=beginDetailAction(target,job.id,libraryDetailRequest);target.hidden=false;empty(target);showGroqSummaryChoice(job,target,detailRequest);};actions.append(free);}actions.append(open,remove);card.append(actions);return card;
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
function capacityPayload(){
  const provider=$('#capacity-provider').value,now=Date.now();
  const count=id=>{const value=$(id).value;return value===''?null:Number(value);};
  const time=id=>{const value=$(id).value;return value===''?null:Date.parse(value);};
  const minute=time('#cap-reset-minute'),hour=time('#cap-reset-hour'),day=time('#cap-reset-day');
  const remaining=provider==='gemini'?{requestsMinute:count('#cap-rpm'),tokensMinute:count('#cap-tpm'),requestsDay:count('#cap-rpd')}:{requestsMinute:count('#cap-rpm'),audioSecondsHour:count('#cap-audio-hour'),audioSecondsDay:count('#cap-audio-day')};
  const resetAt=provider==='gemini'?{requestsMinute:minute,tokensMinute:minute,requestsDay:day}:{requestsMinute:minute,audioSecondsHour:hour,audioSecondsDay:day};
  return {provider,model:provider==='gemini'?'gemini-2.5-flash':'whisper-large-v3-turbo',source:provider==='gemini'?'AI_STUDIO_LIVE':'GROQ_CONSOLE_LIVE',observedAt:now,remaining,resetAt,externalActivity:!$('#cap-confirm').checked,billingDisabled:$('#cap-confirm').checked,freeOnly:$('#cap-confirm').checked};
}
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
