// Owner-only archival storage, not a transcript or automatically verified summary.
// No browser persistence, service worker, background retry or provider operation.
export const ARCHIVE_LABEL='수동 보관 요약 · 원문 미연결/미검증';
export const ARCHIVE_MAX_BYTES=1_000_000;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,sha=/^[0-9a-f]{64}$/;
const encoder=new TextEncoder();
let pendingRequest=null;
const pendingDeletes=new Set();
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const problem=(code,message)=>Object.assign(new Error(message),{code});
const safeError=(error,fallback)=>/^MANUAL_ARCHIVE_[A-Z_]+$/.test(error?.code??'')?`${fallback} (${error.code})`:fallback;
export function canonicalArchiveVideoUrl(value){
 if(typeof value!=='string'||value.length>2048||value.trim()!==value||/[\u0000-\u0020\u007f-\u009f\\]/.test(value))throw problem('MANUAL_ARCHIVE_VIDEO_URL','실제 YouTube 영상 URL을 입력하세요.');
 let url;try{url=new URL(value);}catch{throw problem('MANUAL_ARCHIVE_VIDEO_URL','실제 YouTube 영상 URL을 입력하세요.');}
 if(url.protocol!=='https:'||!value.match(/^https:\/\/([^/?#]+)/)?.[1]||value.match(/^https:\/\/([^/?#]+)/)[1].includes(':')||url.username||url.password||url.port)throw problem('MANUAL_ARCHIVE_VIDEO_URL','HTTPS YouTube 영상 URL을 입력하세요.');
 let id=null;
 if(url.hostname==='youtu.be')id=url.pathname.slice(1);
 else if(['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname)){
  if(url.pathname==='/watch'&&url.searchParams.getAll('v').length===1)id=url.searchParams.get('v');
  else id=url.pathname.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
 }
 if(!/^[A-Za-z0-9_-]{11}$/.test(id??''))throw problem('MANUAL_ARCHIVE_VIDEO_URL','YouTube 영상 ID가 있는 실제 URL이 필요합니다.');
 return {videoId:id,videoUrl:'https://www.youtube.com/watch?v='+id};
}
export async function prepareArchiveFile(file){
 if(!file||typeof file.name!=='string'||! /\.(txt|md)$/i.test(file.name)||typeof file.arrayBuffer!=='function')throw problem('MANUAL_ARCHIVE_FILE_TYPE','UTF-8 TXT 또는 MD 파일을 선택하세요.');
 if(!Number.isSafeInteger(file.size)||file.size<1||file.size>ARCHIVE_MAX_BYTES)throw problem('MANUAL_ARCHIVE_BYTE_LIMIT','파일은 UTF-8 기준 1,000,000바이트 이하여야 합니다.');
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(bytes.byteLength!==file.size)throw problem('MANUAL_ARCHIVE_BYTE_LIMIT','파일 크기가 변경되었습니다.');
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw problem('MANUAL_ARCHIVE_UTF8','올바른 UTF-8 텍스트가 필요합니다.');}
 if(!text.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text))throw problem('MANUAL_ARCHIVE_TEXT','비어 있지 않은 일반 텍스트 요약이 필요합니다.');
 let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
 return {text,artifactBase64:btoa(binary),artifactSha256:await digest(bytes),artifactBytes:bytes.length};
}
export function validArchiveMetadata(value){
 const label=(text,max)=>typeof text==='string'&&!!text.trim()&&Array.from(text).length<=max&&!/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(text);
 return value&&typeof value.id==='string'&&uuid.test(value.id)&&typeof value.videoId==='string'&&/^[A-Za-z0-9_-]{11}$/.test(value.videoId)&&value.videoUrl==='https://www.youtube.com/watch?v='+value.videoId&&label(value.title,200)&&label(value.authorLabel,80)&&value.authorKind==='EXTERNAL_ASSISTANT_OWNER_DECLARED'&&value.sourceLinkState==='UNLINKED'&&value.independentlyVerified===false&&value.automaticSummaryCompleted===false&&value.providerExecution==='NOT_RUN_BY_APP'&&typeof value.artifactSha256==='string'&&sha.test(value.artifactSha256)&&Number.isSafeInteger(value.artifactBytes)&&value.artifactBytes>0&&value.artifactBytes<=ARCHIVE_MAX_BYTES&&typeof value.importedAt==='string'&&Number.isFinite(Date.parse(value.importedAt))&&new Date(value.importedAt).toISOString()===value.importedAt;
}
export function createArchiveController({api,isCurrent=()=>true,onChange=()=>{},randomUUID=()=>crypto.randomUUID()}){
 if(typeof api!=='function')throw Error('ARCHIVE_API_REQUIRED');
 let state={phase:'IDLE',archives:null,listError:null,page:1,hasMore:false,cursor:null,listLoading:false,readOnly:true,draft:null,detail:null,detailError:null,message:'',requestId:pendingRequest?.requestId??null,deleteUnknownId:pendingDeletes.values().next().value??null,deletingId:null};
 let prepared=null,prepareVersion=0,listVersion=0,detailVersion=0,detailTarget=null,loadVersion=0,saveTask=null,reconcileTask=null,deleteTask=null;
 let pages=[null];
 const snapshot=()=>({...state,archives:state.archives?.slice()??null});
 const update=patch=>{state={...state,...patch};if(isCurrent())onChange(snapshot());};
 const busy=()=>!!pendingRequest||!!saveTask||!!reconcileTask||!!deleteTask||pendingDeletes.size>0;
 async function refreshList({cursor=null,page=1}={}){
  const version=++listVersion;update({listLoading:true});
  try{
   const query=new URLSearchParams({limit:'20'});if(cursor){query.set('beforeCreatedAt',cursor.createdAt);query.set('beforeId',cursor.id);}
   const response=await api('/api/summary-archives?'+query);
   const older=(a,b)=>a.importedAt<b.importedAt||(a.importedAt===b.importedAt&&a.id<b.id);
   if(!Array.isArray(response.archives)||response.archives.length>50||response.archives.some((x,i)=>!validArchiveMetadata(x)||(i>0&&!older(x,response.archives[i-1]))||(cursor&&!older(x,{importedAt:cursor.createdAt,id:cursor.id})))||typeof response.readOnly!=='boolean'||typeof response.hasMore!=='boolean')throw Error('INVALID_ARCHIVE_LIST');
   const next=response.hasMore?{createdAt:response.nextBeforeCreatedAt,id:response.nextBeforeId}:null;
   if(next&&(!uuid.test(next.id)||typeof next.createdAt!=='string'||next.id!==response.archives.at(-1)?.id||next.createdAt!==response.archives.at(-1)?.importedAt))throw Error('INVALID_ARCHIVE_CURSOR');
   if(version!==listVersion)return;
   if(page===1)pages=[null];else pages[page-1]=cursor;
   update({archives:response.archives,listError:null,page,hasMore:response.hasMore===true,cursor:next,listLoading:false,readOnly:response.readOnly});
  }catch(error){if(version===listVersion)update({archives:null,listError:safeError(error,'수동 보관 목록을 확인하지 못했습니다. 빈 목록으로 처리하지 않습니다.'),listLoading:false,readOnly:true});}
 }
 async function open(id){
  if(!isCurrent()||!uuid.test(id))return;const version=++detailVersion;detailTarget=id;update({detail:null,detailError:null});
  try{
   const result=await api('/api/summary-archives/'+id),archive=result.archive;
   if(!validArchiveMetadata(archive)||archive.id!==id||typeof archive.text!=='string')throw Error('INVALID_ARCHIVE');
   const bytes=encoder.encode(archive.text);if(bytes.length!==archive.artifactBytes||await digest(bytes)!==archive.artifactSha256)throw Error('ARCHIVE_INTEGRITY');
   if(version===detailVersion&&isCurrent())update({detail:archive});
  }catch(error){if(version===detailVersion&&isCurrent())update({detailError:safeError(error,'보관된 본문과 해시를 확인하지 못했습니다. 다시 조회하세요.')});}
 }
 async function acceptOutcome(result,entry,expectedDetailVersion=detailVersion){
  if(result?.requestId!==entry.requestId)throw Error('ARCHIVE_REQUEST_MISMATCH');
  if(result.state==='COMMITTED'){
   const archive=result.archive;if(!validArchiveMetadata(archive)||archive.artifactSha256!==entry.artifactSha256||archive.videoId!==entry.videoId)throw Error('ARCHIVE_COMMIT_MISMATCH');
   if(pendingRequest?.requestId===entry.requestId)pendingRequest=null;
   prepared=null;prepareVersion++;update({phase:'SAVED',draft:null,message:result.reused?'동일 영상·본문의 기존 보관 항목을 확인했습니다. 기존 제목·작성자 표시는 덮어쓰지 않았습니다.':'수동 보관 요약이 저장되었습니다. 원문 연결·전사·자동 AI 완료 상태는 바뀌지 않았습니다.'});
   await refreshList();if(detailVersion===expectedDetailVersion&&isCurrent())await open(archive.id);return;
  }
  if(result.state==='DELETED'){
   if(pendingRequest?.requestId===entry.requestId)pendingRequest=null;
   prepared=null;prepareVersion++;update({phase:'DELETED',draft:null,message:'이 저장 요청의 보관 본문은 삭제되었습니다. 이전 요청을 다시 실행해 복원하지 않습니다.'});await refreshList();return;
  }
  update({phase:'UNKNOWN',message:'저장 결과가 아직 확정되지 않았습니다. 상태를 다시 조회하세요. 새 저장 요청은 자동 전송하지 않습니다.'});
 }
 async function reconcile(){
  if(reconcileTask)return reconcileTask;const entry=pendingRequest;if(!entry)return snapshot();const detailAtStart=detailVersion;
  update({phase:'RECONCILING',requestId:entry.requestId,message:'저장 상태를 조회 중입니다…'});
  reconcileTask=(async()=>{try{await acceptOutcome(await api('/api/summary-archive-requests/'+entry.requestId),entry,detailAtStart);}catch(error){update({phase:'UNKNOWN',message:safeError(error,'저장 상태를 확인하지 못했습니다. 다시 조회하세요.')});}return snapshot();})().finally(()=>{reconcileTask=null;});return reconcileTask;
 }
 async function load(){
  if(!isCurrent())return snapshot();const version=++loadVersion;update({phase:pendingRequest?'RECONCILING':'LOADING',message:'수동 보관 목록을 확인 중입니다…'});
  await refreshList();if(version!==loadVersion||!isCurrent())return snapshot();
  if(pendingRequest)await reconcile();else update({phase:'IDLE',message:state.deleteUnknownId?'이전 삭제 결과가 미확정입니다. 삭제 상태 조회를 먼저 진행하세요.':state.readOnly?'읽기·내보내기·삭제 전용입니다. 새 보관은 비활성입니다.':'기존 완성본을 보관합니다. 원문·음성 또는 내용 검증 완료로 처리하지 않습니다.'});return snapshot();
 }
 async function prepare(file){
  if(!isCurrent()||busy()||state.readOnly)return snapshot();const version=++prepareVersion;prepared=null;update({phase:'PREPARING',draft:null,message:'파일의 UTF-8 바이트와 해시를 확인 중입니다…'});
  try{const item=await prepareArchiveFile(file);if(version!==prepareVersion||!isCurrent())return snapshot();prepared=item;update({phase:'READY',draft:{text:item.text,artifactSha256:item.artifactSha256,artifactBytes:item.artifactBytes},message:'영상 URL·작성 주체·선택한 본문을 확인하고 보관하세요.'});}
  catch(error){if(version===prepareVersion&&isCurrent())update({phase:'IDLE',message:safeError(error,'파일 형식과 내용을 확인하세요.')});}return snapshot();
 }
 function cancel(){
  if(busy()){update({message:'전송된 저장·삭제 요청은 취소됐다고 표시하지 않습니다. 저장 상태를 조회한 뒤 필요하면 보관 항목을 명시적으로 삭제하세요.'});return snapshot();}
  prepareVersion++;prepared=null;update({phase:'IDLE',draft:null,message:'파일 선택을 취소했습니다. 새 저장 요청은 보내지 않았습니다.'});return snapshot();
 }
 function save({videoUrl,title,authorLabel,ownerConfirmed=false}={}){
  if(saveTask)return saveTask;if(!isCurrent()||busy()||state.readOnly)return Promise.resolve(snapshot());
  if(!prepared||ownerConfirmed!==true){update({message:'파일 선택과 원문 미연결·작성주체 확인이 필요합니다.'});return Promise.resolve(snapshot());}
  let video;try{video=canonicalArchiveVideoUrl(videoUrl);if(typeof title!=='string'||!title.trim()||Array.from(title).length>200||typeof authorLabel!=='string'||!authorLabel.trim()||Array.from(authorLabel).length>80||/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(title+authorLabel))throw Error('BAD_METADATA');}catch(error){update({message:safeError(error,'영상 URL·제목·외부 assistant 표시명을 확인하세요.')});return Promise.resolve(snapshot());}
  const requestId=randomUUID();if(!uuid.test(requestId))throw Error('INVALID_REQUEST_ID');
  const item=prepared,detailAtStart=detailVersion,entry={requestId,artifactSha256:item.artifactSha256,videoId:video.videoId};pendingRequest=entry;
  const body={requestId,videoUrl:video.videoUrl,title,authorLabel,artifactSha256:item.artifactSha256,artifactBase64:item.artifactBase64,ownerConfirmed:true};
  update({phase:'SAVING',requestId,message:'원문 미연결 수동 보관 항목으로 저장 중입니다…'});
  saveTask=(async()=>{try{await acceptOutcome(await api('/api/summary-archives',{method:'POST',body}),entry,detailAtStart);}catch(error){if(/^MANUAL_ARCHIVE_(?:READ_ONLY|PERSISTENCE_NOT_CONFIGURED|SCHEMA_REQUIRED|BODY_TOO_LARGE|JSON_REQUIRED|INVALID_REQUEST|INVALID_JSON|NONCANONICAL_JSON|INVALID_VIDEO_URL|ARTIFACT_TOO_LARGE|ARTIFACT_ENCODING|ARTIFACT_HASH_MISMATCH|ARTIFACT_UTF8|ARTIFACT_TEXT)$/.test(error?.code??'')){if(pendingRequest?.requestId===entry.requestId)pendingRequest=null;update({phase:'READY',readOnly:state.readOnly||['MANUAL_ARCHIVE_READ_ONLY','MANUAL_ARCHIVE_SCHEMA_REQUIRED','MANUAL_ARCHIVE_PERSISTENCE_NOT_CONFIGURED'].includes(error.code),message:safeError(error,'저장 전에 요청이 거부되었습니다. 입력·설정을 확인하세요. 자동 재전송하지 않습니다.')});}else{update({phase:'UNKNOWN',message:safeError(error,'응답을 확인하지 못해 저장 상태를 조회합니다.')});await reconcile();}}return snapshot();})().finally(()=>{saveTask=null;});return saveTask;
 }
 async function reconcileDelete(id=state.deleteUnknownId){
  if(!isCurrent()||!uuid.test(id??''))return;update({message:'삭제 결과를 읽기 전용으로 확인 중입니다…'});
  try{const result=await api('/api/summary-archives/'+id);if(!validArchiveMetadata(result.archive)||result.archive.id!==id)throw Error('INVALID_ARCHIVE');pendingDeletes.delete(id);update({deleteUnknownId:null,message:'이 항목은 아직 보관 중입니다. 삭제하려면 명시적으로 다시 선택하세요.'});}
  catch(error){if(error?.code==='MANUAL_ARCHIVE_NOT_FOUND'){pendingDeletes.delete(id);if(detailTarget===id){detailVersion++;detailTarget=null;update({detail:null,detailError:null});}update({deleteUnknownId:null,message:'현재 이 보관 항목의 본문이 없습니다. 새 저장이나 재생성을 실행하지 않았습니다.'});await refreshList();}else update({deleteUnknownId:id,message:'삭제 결과를 아직 확인하지 못했습니다. 다시 조회하세요.'});}
 }
 function remove(id,{confirmed=false}={}){
  if(deleteTask)return deleteTask;if(!isCurrent()||busy()||!uuid.test(id)||confirmed!==true)return Promise.resolve(snapshot());
  pendingDeletes.add(id);update({deletingId:id,message:'이 수동 보관 본문을 삭제 중입니다…'});
  deleteTask=(async()=>{try{const result=await api('/api/summary-archives/'+id,{method:'DELETE',body:{}});if(result.deleted!==true||result.id!==id)throw Error('DELETE_UNCONFIRMED');pendingDeletes.delete(id);if(detailTarget===id){detailVersion++;detailTarget=null;update({detail:null,detailError:null});}update({deleteUnknownId:null,message:'수동 보관 본문을 삭제했습니다. 별도 분석·전사는 변경하지 않았습니다.'});await refreshList();}catch{update({deleteUnknownId:id,message:'삭제 응답을 확인하지 못했습니다. 결과 조회만 진행합니다.'});await reconcileDelete(id);}finally{update({deletingId:null});}return snapshot();})().finally(()=>{deleteTask=null;});return deleteTask;
 }
 return {load,prepare,cancel,save,reconcile,open,remove,reconcileDelete,refreshList,getState:snapshot,nextPage:()=>state.hasMore&&!state.listLoading?refreshList({cursor:state.cursor,page:state.page+1}):Promise.resolve(),previousPage:()=>state.page>1&&!state.listLoading?refreshList({cursor:pages[state.page-2],page:state.page-1}):Promise.resolve(),exportUrl:id=>uuid.test(id)?'/api/summary-archives/'+id+'/export':null};
}
export function mountSummaryArchives({host,api,isCurrent=()=>true,document:dom=globalThis.document,confirmDelete=message=>globalThis.confirm(message)}){
 const element=(tag,text,className)=>{const node=dom.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 const heading=element('h3',ARCHIVE_LABEL),description=element('p','이미 작성된 assistant 요약을 별도로 보관합니다. 전사 원문이 없어도 저장할 수 있지만, 원문 연결·음성 정확성·내용 검증·자동 AI 완료를 뜻하지 않습니다.','tip');
 const status=element('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const list=element('div'),detail=element('div'),form=element('section'),video=element('input'),title=element('input'),author=element('input'),file=element('input'),check=element('input'),preview=element('pre');
 video.type='url';video.placeholder='https://www.youtube.com/watch?v=…';title.type='text';title.maxLength=200;author.type='text';author.maxLength=80;author.value='assistant';file.type='file';file.accept='.txt,.md,text/plain,text/markdown';check.type='checkbox';preview.hidden=true;
 for(const [text,input] of [['실제 영상 URL',video],['보관 제목',title],['외부 assistant 표시명 · 소유자 신고, 독립 확인 아님',author],['완성 요약 TXT/MD · UTF-8 1,000,000바이트 이하',file]]){const label=element('label',text);label.append(input);form.append(label);}
 const checkLabel=element('label','영상·외부 assistant 작성 표시·본문을 확인했고 원문 미연결/미검증 수동 보관임을 확인합니다.');checkLabel.prepend(check);form.append(preview,checkLabel);
 const actions=element('div',undefined,'library-actions'),save=element('button','수동 보관 요약 저장','btn primary small'),cancel=element('button','파일 선택 취소','btn secondary small'),reconcile=element('button','저장 상태 조회','btn secondary small'),deleteReconcile=element('button','삭제 상태 조회','btn secondary small'),reload=element('button','보관 목록 새로고침','btn secondary small');
 for(const button of [save,cancel,reconcile,deleteReconcile,reload])button.type='button';actions.append(save,cancel,reconcile,deleteReconcile,reload);form.append(actions);host.replaceChildren(heading,description,status,list,detail,form);
 const controller=createArchiveController({api,isCurrent,onChange:render});
 function render(state){
  if(!isCurrent())return;status.textContent=state.message;
  const busy=['LOADING','PREPARING','SAVING','RECONCILING','UNKNOWN'].includes(state.phase)||!!state.deletingId||!!state.deleteUnknownId;
  for(const input of [video,title,author,file])input.disabled=busy||state.readOnly;
  check.disabled=busy||state.readOnly||!state.draft;save.disabled=busy||state.readOnly||!state.draft||!check.checked;
  cancel.disabled=['LOADING','SAVING','RECONCILING','UNKNOWN'].includes(state.phase)||!!state.deletingId||(!state.draft&&state.phase!=='PREPARING');reconcile.hidden=state.phase!=='UNKNOWN';deleteReconcile.hidden=!state.deleteUnknownId;reload.disabled=busy&&state.phase!=='UNKNOWN';
  preview.hidden=!state.draft;preview.textContent=state.draft?`선택 본문 · ${state.draft.artifactBytes}바이트 · SHA256 ${state.draft.artifactSha256}\n\n${state.draft.text}`:'';
  list.replaceChildren();if(state.archives===null)list.append(element('p',state.listError??'목록을 확인 중입니다…'));else if(!state.archives.length)list.append(element('p','수동 보관 요약이 없습니다.'));
  for(const item of state.archives??[]){const row=element('div',undefined,'library-actions'),open=element('button',item.title+' 열기','btn secondary small'),remove=element('button','보관 본문 삭제','btn secondary small');open.type=remove.type='button';open.onclick=()=>controller.open(item.id);remove.disabled=busy;remove.onclick=()=>{if(isCurrent()&&confirmDelete('이 수동 보관 요약 본문만 삭제할까요? 별도 분석·전사는 변경하지 않습니다.'))return controller.remove(item.id,{confirmed:true});};row.append(open,element('span',`원문 미연결/미검증 · 가져온 시각 ${item.importedAt}`),remove);list.append(row);}
  if(state.page>1||state.hasMore){const previous=element('button','최근 보관 페이지'),next=element('button','이전 보관 페이지');previous.type=next.type='button';previous.disabled=state.page===1||state.listLoading;next.disabled=!state.hasMore||state.listLoading;previous.onclick=()=>controller.previousPage();next.onclick=()=>controller.nextPage();list.append(previous,next);}
  detail.replaceChildren();if(state.detail){const item=state.detail;detail.append(element('h4',item.title),element('p',`외부 assistant 작성(소유자 신고): ${item.authorLabel} · 영상 업로더 작성 확인 아님\n원문 미연결/미검증 · 앱 제공자 실행 없음 · 자동 요약 완료 아님\n가져온 시각 ${item.importedAt} · 최초 작성 시각 미확인\n본문 SHA256 ${item.artifactSha256}`,'tip'));
   const link=element('a','원본 영상');link.setAttribute('href',item.videoUrl);link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');const exported=element('a','보관 본문 TXT 내보내기','btn secondary small');exported.setAttribute('href',controller.exportUrl(item.id));exported.setAttribute('download','manual-summary-archive.txt');detail.append(link,element('pre',item.text),exported);
  }else if(state.detailError)detail.append(element('p',state.detailError));
 }
 for(const input of [video,title,author])input.oninput=()=>{check.checked=false;render(controller.getState());};
 file.onchange=async()=>{check.checked=false;const selected=file.files?.[0];if(selected)await controller.prepare(selected);};
 check.onchange=()=>render(controller.getState());save.onclick=()=>controller.save({videoUrl:video.value,title:title.value,authorLabel:author.value,ownerConfirmed:check.checked});
 cancel.onclick=()=>{check.checked=false;file.value='';controller.cancel();};reconcile.onclick=()=>controller.reconcile();deleteReconcile.onclick=()=>controller.reconcileDelete();reload.onclick=()=>controller.load();
 render(controller.getState());return {controller,ready:controller.load()};
}
