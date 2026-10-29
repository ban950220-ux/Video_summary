// Owner-authenticated imported summaries. The request journal contains identifiers
// and hashes only; file bytes and summary text stay in this view's memory.
export const MANUAL_SUMMARY_MAX_BYTES=1_000_000;
export const MANUAL_SUMMARY_PROVENANCE='EXISTING_TRANSCRIPT_IMPORTED';
export const MANUAL_SUMMARY_LABEL='기존 전사 기반 가져온 요약';
const requestJournal=new Map();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha=/^[0-9a-f]{64}$/;
const encoder=new TextEncoder();
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
const base64=bytes=>{let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(binary);};
function problem(code,message){return Object.assign(new Error(message),{code});}
function safeMessage(error,fallback){return /^MANUAL_IMPORT_[A-Z_]+$/.test(error?.code??'')?`${fallback} (${error.code})`:fallback;}

export async function prepareManualSummaryFile(file){
 if(!file||typeof file.name!=='string'||!/\.txt$/i.test(file.name)||typeof file.arrayBuffer!=='function')throw problem('MANUAL_IMPORT_FILE_TYPE','UTF-8 TXT 파일을 선택하세요.');
 if(!Number.isSafeInteger(file.size)||file.size<1||file.size>MANUAL_SUMMARY_MAX_BYTES)throw problem('MANUAL_IMPORT_BYTE_LIMIT','파일은 UTF-8 기준 1,000,000바이트 이하여야 합니다.');
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(bytes.byteLength!==file.size||bytes.byteLength>MANUAL_SUMMARY_MAX_BYTES)throw problem('MANUAL_IMPORT_BYTE_LIMIT','파일 크기가 변경되었거나 용량 제한을 넘었습니다.');
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw problem('MANUAL_IMPORT_UTF8','올바른 UTF-8 TXT 파일이 필요합니다.');}
 if(!text.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))throw problem('MANUAL_IMPORT_TEXT','비어 있지 않은 일반 텍스트 요약이 필요합니다.');
 return {artifactBase64:base64(bytes),artifactSha256:await digest(bytes),artifactBytes:bytes.byteLength,text};
}

function validMetadata(summary){
 return summary&&uuid.test(summary.id)&&Number.isSafeInteger(summary.revision)&&summary.revision>0&&sha.test(summary.sourceSha256)&&sha.test(summary.artifactSha256)&&Number.isSafeInteger(summary.artifactBytes)&&summary.artifactBytes>0&&summary.artifactBytes<=MANUAL_SUMMARY_MAX_BYTES&&summary.provenance===MANUAL_SUMMARY_PROVENANCE&&summary.providerExecution==='NOT_RUN_BY_APP'&&summary.automaticSummaryCompleted===false&&summary.basisMethod==='OWNER_SOURCE_RECONCILIATION'&&summary.independentlyVerified===false;
}

export function createImportedSummaryController({jobId,api,isCurrent=()=>true,onChange=()=>{},randomUUID=()=>crypto.randomUUID()}){
 if(!uuid.test(jobId)||typeof api!=='function')throw problem('MANUAL_IMPORT_TARGET','분석 대상을 확인하세요.');
 const root='/api/jobs/'+encodeURIComponent(jobId),journalKey=jobId;
 let state={phase:'IDLE',source:null,sourceError:null,summaries:null,listError:null,listPage:1,listHasMore:false,nextBeforeRevision:null,listLoading:false,draft:null,summary:null,detail:null,detailError:null,message:'',requestId:requestJournal.get(journalKey)?.requestId??null};
 let prepared=null,requestScope=requestJournal.get(journalKey)??null,listPages=[null],prepareVersion=0,detailVersion=0,loadVersion=0,listVersion=0,saveTask=null,cancelTask=null,reconcileTask=null;
 const snapshot=()=>({...state,summaries:state.summaries?.slice()??null});
 const update=patch=>{state={...state,...patch};if(isCurrent())onChange(snapshot());};
 const outstanding=()=>requestJournal.get(journalKey);
 const terminal=()=>['SAVED','CANCELLED'].includes(state.phase);
 const ownPending=()=>requestScope&&requestScope.requestId===state.requestId&&['SAVING','CANCELLING','RECONCILING','UNKNOWN'].includes(state.phase)?requestScope:null;
 const forgetRequest=requestId=>{if(outstanding()?.requestId===requestId)requestJournal.delete(journalKey);};
 const pending=()=>['SAVING','CANCELLING','RECONCILING','UNKNOWN'].includes(state.phase)||!!outstanding();
 async function refreshList({beforeRevision=null,page=1}={}){
  if((beforeRevision!==null&&(!Number.isSafeInteger(beforeRevision)||beforeRevision<1))||!Number.isSafeInteger(page)||page<1)return;
  const version=++listVersion;
  update({listLoading:true});
  try{
   const response=await api(root+'/imported-summaries'+(beforeRevision===null?'':'?limit=50&beforeRevision='+beforeRevision));
   if(!Array.isArray(response.summaries)||response.summaries.length>50||response.summaries.some((item,index)=>!validMetadata(item)||(beforeRevision!==null&&item.revision>=beforeRevision)||(index>0&&item.revision>=response.summaries[index-1].revision)))throw Error('INVALID_LIST');
   const hasMore=response.hasMore===true,next=hasMore?response.nextBeforeRevision:null;
   if(hasMore&&(!Number.isSafeInteger(next)||next<1||next!==response.summaries.at(-1)?.revision))throw Error('INVALID_CURSOR');
   if(version===listVersion){if(page===1)listPages=[null];else listPages[page-1]=beforeRevision;update({summaries:response.summaries,listError:null,listPage:page,listHasMore:hasMore,nextBeforeRevision:next,listLoading:false});}
  }
  catch{if(version===listVersion)update({summaries:null,listError:'저장된 가져온 요약 목록을 확인하지 못했습니다. 비어 있는 목록으로 처리하지 않습니다.',listLoading:false});}
 }
 async function open(importId){
  if(!isCurrent()||!uuid.test(importId))return;
  const version=++detailVersion;update({detail:null,detailError:null});
  try{
   const response=await api(root+'/imported-summaries/'+encodeURIComponent(importId)),summary=response.summary;
   if(!validMetadata(summary)||summary.id!==importId||typeof summary.text!=='string')throw Error('INVALID_SUMMARY');
   const bytes=encoder.encode(summary.text);
   if(bytes.byteLength!==summary.artifactBytes||await digest(bytes)!==summary.artifactSha256)throw Error('CONTENT_MISMATCH');
   if(version!==detailVersion||!isCurrent())return;
   update({detail:summary});
  }catch{if(version===detailVersion&&isCurrent())update({detailError:'저장된 요약의 본문과 해시를 확인하지 못했습니다. 다시 조회하세요.'});}
 }
 async function acceptOutcome(response){
  const requestId=requestScope?.requestId??state.requestId;
  if(response?.requestId!==requestId)throw Error('REQUEST_MISMATCH');
  if(terminal()&&!['COMMITTED','CANCELLED'].includes(response.state))return state.phase==='SAVED'?'COMMITTED':'CANCELLED';
  if(response.state==='COMMITTED'){
   if(!validMetadata(response.summary)||!requestScope||response.summary.sourceSha256!==requestScope.sourceSha256||response.summary.artifactSha256!==requestScope.artifactSha256)throw Error('INVALID_COMMIT');
   forgetRequest(requestId);prepared=null;prepareVersion++;
   update({phase:'SAVED',summary:response.summary,draft:null,message:'가져온 요약이 저장되었습니다. 자동 AI 요약 완료 상태는 바뀌지 않았습니다.'});
   await Promise.all([refreshList(),open(response.summary.id)]);return 'COMMITTED';
  }
  if(response.state==='CANCELLED'){
   forgetRequest(requestId);prepared=null;prepareVersion++;
   update({phase:'CANCELLED',draft:null,message:'저장 요청이 취소되었습니다. 이미 저장된 다른 요약은 그대로 유지됩니다.'});return 'CANCELLED';
  }
  update({phase:'UNKNOWN',message:'아직 저장 여부가 확정되지 않았습니다. 상태를 다시 조회하거나 이 요청을 취소하세요. 새 저장 요청을 자동으로 보내지 않습니다.'});return 'UNKNOWN';
 }
 async function reconcile(){
  if(reconcileTask)return reconcileTask;
  const entry=ownPending()??outstanding();if(!entry)return snapshot();
  if(entry.sourceSha256&&entry.artifactSha256)requestScope=entry;
  update({phase:'RECONCILING',requestId:entry.requestId,message:'저장 요청 상태를 조회 중입니다…'});
  reconcileTask=(async()=>{try{await acceptOutcome(await api(root+'/imported-summary-requests/'+encodeURIComponent(entry.requestId)));}catch{if(!terminal())update({phase:'UNKNOWN',message:'저장 상태를 조회하지 못했습니다. 다시 조회하거나 요청을 취소한 뒤 결과를 확인하세요.'});}return snapshot();})().finally(()=>{reconcileTask=null;});
  return reconcileTask;
 }
 async function load(){
  if(!isCurrent())return snapshot();
  const version=++loadVersion;prepareVersion++;prepared=null;update({draft:null,phase:outstanding()?'RECONCILING':'LOADING',source:null,sourceError:null,message:'저장된 원문과 가져온 요약을 확인 중입니다…'});
  const sourceTask=(async()=>{try{
   const source=await api(root+'/imported-summaries/source');
   if(!source||!sha.test(source.sourceSha256)||source.provenance!==MANUAL_SUMMARY_PROVENANCE||source.providerExecution!=='NOT_RUN_BY_APP'||source.automaticSummaryCompleted!==false||source.maxBytes!==MANUAL_SUMMARY_MAX_BYTES)throw Error('INVALID_SOURCE');
   if(version===loadVersion)update({source,sourceError:null});
  }catch(error){if(version===loadVersion)update({source:null,sourceError:safeMessage(error,'저장된 원문을 확인하지 못해 새 요약을 가져올 수 없습니다.')});}})();
  await Promise.all([sourceTask,refreshList()]);
  if(version!==loadVersion||!isCurrent())return snapshot();
  if(outstanding())await reconcile();else update({phase:'IDLE',message:'TXT 파일을 선택하고 저장된 원문과의 연결을 확인하세요.'});
  return snapshot();
 }
 async function prepare(file){
  if(!isCurrent()||pending()||saveTask||cancelTask)return snapshot();
  const version=++prepareVersion;prepared=null;update({draft:null,phase:'PREPARING',message:'TXT의 UTF-8 용량과 원문 바이트를 확인 중입니다…'});
  try{
   const artifact=await prepareManualSummaryFile(file);
   if(version!==prepareVersion||!isCurrent())return snapshot();
   prepared=artifact;update({phase:'READY',draft:{artifactSha256:artifact.artifactSha256,artifactBytes:artifact.artifactBytes,text:artifact.text},message:'선택한 요약과 원문을 확인한 뒤 저장하세요.'});
  }catch(error){if(version===prepareVersion&&isCurrent())update({phase:'IDLE',message:safeMessage(error,'TXT 파일의 형식·UTF-8 용량을 확인하세요.')});}
  return snapshot();
 }
 function save({ownerConfirmed=false}={}){
  if(saveTask)return saveTask;
  if(!isCurrent()||pending()||cancelTask)return Promise.resolve(snapshot());
  if(!prepared||!state.source||ownerConfirmed!==true){update({message:'파일과 원문 연결 확인이 모두 필요합니다.'});return Promise.resolve(snapshot());}
  const artifact=prepared,source=state.source,requestId=randomUUID();
  if(!uuid.test(requestId))throw Error('INVALID_REQUEST_ID');
  requestScope={requestId,sourceSha256:source.sourceSha256,artifactSha256:artifact.artifactSha256};requestJournal.set(journalKey,requestScope);
  update({phase:'SAVING',requestId,message:'가져온 요약을 별도로 저장 중입니다…'});
  const body={requestId,sourceSha256:source.sourceSha256,artifactSha256:artifact.artifactSha256,artifactBase64:artifact.artifactBase64,provenance:MANUAL_SUMMARY_PROVENANCE,basis:{method:'OWNER_SOURCE_RECONCILIATION',sourceSha256:source.sourceSha256,artifactSha256:artifact.artifactSha256,ownerConfirmed:true}};
  saveTask=(async()=>{
   try{await acceptOutcome(await api(root+'/imported-summaries',{method:'POST',body}));}
   catch(error){if(!terminal()){update({phase:'UNKNOWN',message:safeMessage(error,'저장 응답을 확인하지 못해 상태를 조회합니다.')});await reconcile();}}
   return snapshot();
  })().finally(()=>{saveTask=null;});
  return saveTask;
 }
 function cancel(){
  if(cancelTask)return cancelTask;
  if(!isCurrent())return Promise.resolve(snapshot());
  prepareVersion++;prepared=null;update({draft:null});
  const entry=ownPending();
  if(!entry){if(!terminal())update({phase:'CANCELLED',message:'파일 선택을 취소했습니다. 저장 요청은 보내지 않았습니다.'});return Promise.resolve(snapshot());}
  update({phase:'CANCELLING',message:'취소와 저장 중 먼저 확정된 결과를 확인 중입니다…'});
  cancelTask=(async()=>{try{await acceptOutcome(await api(root+'/imported-summary-requests/'+encodeURIComponent(entry.requestId)+'/cancel',{method:'POST',body:{}}));}catch{if(!terminal()){update({phase:'UNKNOWN',message:'취소 결과를 확인하지 못했습니다. 저장 여부를 조회합니다.'});await reconcile();}}return snapshot();})().finally(()=>{cancelTask=null;});
  return cancelTask;
 }
 return {load,prepare,save,cancel,reconcile,open,refreshList,nextPage:()=>state.listHasMore&&!state.listLoading?refreshList({beforeRevision:state.nextBeforeRevision,page:state.listPage+1}):Promise.resolve(),previousPage:()=>state.listPage>1&&!state.listLoading?refreshList({beforeRevision:listPages[state.listPage-2],page:state.listPage-1}):Promise.resolve(),getState:snapshot,exportUrl:importId=>uuid.test(importId)?root+'/imported-summaries/'+encodeURIComponent(importId)+'/export':null};
}

export function mountImportedSummaries({host,jobId,api,isCurrent=()=>true,document:dom=globalThis.document}){
 const element=(tag,text,className)=>{const node=dom.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 const heading=element('h3',MANUAL_SUMMARY_LABEL),description=element('p','완성된 TXT 요약을 이 분석에 별도로 저장하고 다시 읽습니다. 앱 제공자 호출 없이 저장하며, 자동 AI 요약·전사 검증 상태는 그대로 유지됩니다.','tip');
 const status=element('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const listHeading=element('h4','저장된 가져온 요약'),list=element('div'),detail=element('div');
 const source=element('p'),fileLabel=element('label','가져올 UTF-8 TXT · 최대 1,000,000바이트'),file=element('input');file.type='file';file.accept='.txt,text/plain';fileLabel.append(file);
 const preview=element('pre');preview.hidden=true;
 const check=element('input');check.type='checkbox';const checkLabel=element('label','선택한 요약이 이 분석의 저장된 전사를 기반으로 작성되었음을 원문과 비교해 확인했습니다.');checkLabel.prepend(check);
 const disclosure=element('p','원문·근거 보기에서 전사를 먼저 확인하세요. 이 확인은 소유자의 연결 확인이며, 요약의 내용이나 음성 정확성을 독립 검증한 결과는 아닙니다.','tip');
 const actions=element('div',undefined,'library-actions'),save=element('button','가져온 요약 저장','btn primary small'),cancel=element('button','선택·저장 요청 취소','btn secondary small'),reconcile=element('button','저장 상태 다시 조회','btn secondary small'),reload=element('button','원문·목록 새로고침','btn secondary small');
 for(const button of [save,cancel,reconcile,reload])button.type='button';actions.append(save,cancel,reconcile,reload);
 host.replaceChildren(heading,description,status,listHeading,list,detail,source,fileLabel,preview,disclosure,checkLabel,actions);
 let sourceHash=null;
 const controller=createImportedSummaryController({jobId,api,isCurrent,onChange:render});
 function controls(state){
  const busy=['LOADING','PREPARING','SAVING','CANCELLING','RECONCILING','UNKNOWN'].includes(state.phase);
  save.disabled=busy||!state.source||!state.draft||check.checked!==true;
  file.disabled=busy||!state.source;
  check.disabled=busy||!state.draft||!state.source;
  cancel.disabled=['LOADING','CANCELLING','RECONCILING'].includes(state.phase)||(!state.draft&&!['PREPARING','SAVING','UNKNOWN'].includes(state.phase));
  reconcile.hidden=state.phase!=='UNKNOWN';reconcile.disabled=state.phase!=='UNKNOWN';
  reload.disabled=['PREPARING','SAVING','CANCELLING','RECONCILING'].includes(state.phase);
 }
 function render(state){
  if(!isCurrent())return;
  status.textContent=state.message;
  if(sourceHash!==state.source?.sourceSha256){sourceHash=state.source?.sourceSha256??null;check.checked=false;}
  source.textContent=state.source?`기준 전사 ${state.source.segmentCount}구간 · ${state.source.durationSeconds}초 · 원문 출처 ${state.source.sourceProvenance}\n원문 SHA-256 ${state.source.sourceSha256}`:state.sourceError??'저장된 원문을 확인 중입니다…';
  preview.hidden=!state.draft;preview.textContent=state.draft?`선택한 요약 · UTF-8 ${state.draft.artifactBytes}바이트\nSHA-256 ${state.draft.artifactSha256}\n\n${state.draft.text}`:'';
  list.replaceChildren();
  if(state.summaries===null)list.append(element('p',state.listError??'목록을 확인 중입니다…'));
  else if(!state.summaries.length)list.append(element('p','저장된 가져온 요약이 없습니다.'));
  else for(const item of state.summaries){const row=element('div',undefined,'library-actions'),button=element('button',`가져온 요약 ${item.revision} 열기`,'btn secondary small');button.type='button';button.onclick=()=>controller.open(item.id);row.append(button,element('span',`${item.createdAt} · ${item.artifactBytes}바이트`));list.append(row);}
  if(state.listPage>1||state.listHasMore){const pager=element('div',undefined,'library-actions'),previous=element('button','최근 요약 페이지','btn secondary small'),next=element('button','이전 요약 페이지','btn secondary small');previous.type=next.type='button';previous.disabled=state.listPage===1||state.listLoading;next.disabled=!state.listHasMore||state.listLoading;previous.onclick=()=>controller.previousPage();next.onclick=()=>controller.nextPage();pager.append(previous,next);list.append(pager);}
  detail.replaceChildren();
  if(state.detail){
   detail.append(element('h4',`${MANUAL_SUMMARY_LABEL} · ${state.detail.revision}`),element('p','소유자 원문 연결 확인 · 제공자 실행 없음 · 자동 요약 완료 아님','tip'),element('pre',state.detail.text));
   if(state.source&&state.detail.sourceSha256!==state.source.sourceSha256)detail.append(element('p','이 요약의 저장 당시 원문 해시와 현재 원문 해시가 다릅니다. 원문 연결을 다시 검토하세요. 기존 요약은 보존되어 있습니다.','tip'));
   const link=element('a','가져온 요약 TXT 내보내기','btn secondary small');link.setAttribute('href',controller.exportUrl(state.detail.id));link.setAttribute('download','imported-summary.txt');detail.append(link);
  }else if(state.detailError)detail.append(element('p',state.detailError));
  controls(state);
 }
 file.onchange=async()=>{check.checked=false;const selected=file.files?.[0];if(selected)await controller.prepare(selected);};
 check.onchange=()=>controls(controller.getState());
 save.onclick=()=>controller.save({ownerConfirmed:check.checked});
 cancel.onclick=async()=>{check.checked=false;file.value='';await controller.cancel();};
 reconcile.onclick=()=>controller.reconcile();
 reload.onclick=async()=>{check.checked=false;file.value='';await controller.load();};
 render(controller.getState());
 return {controller,ready:controller.load()};
}
