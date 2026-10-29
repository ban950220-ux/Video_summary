import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MANUAL_IMPORT_CONTRACT,MAX_IMPORTED_SUMMARY_BYTES,manualSummarySourceSha256,previewManualSummaryImport,productionExecutionSupported} from '../scripts/manual-summary-import-contract.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=2_000_000_000_000;
const encode=JSON.stringify;
function file(text='전체 구간의 합성 테스트 요약\n',bytes=Buffer.from(text,'utf8')){return {mimeType:'text/plain',sizeBytes:bytes.length,sha256:sha(bytes),utf8Base64:bytes.toString('base64')};}
function fixture(){
 const source={ownerId:'owner',jobId:uid(1),videoId:'synthetic01',durationMs:10_000,sourceProvenance:'SYNTHETIC_TEST_TRANSCRIPT',raw:'1\n00:00:00,000 --> 00:00:04,000\n첫 문장\n\n2\n00:00:03,900 --> 00:00:10,000\n끝 문장\n',segments:[{id:1,startMs:0,endMs:4000,text:'첫 문장'},{id:2,startMs:3900,endMs:10000,text:'끝 문장'}]};
 const canonicalSourceSha256=manualSummarySourceSha256(encode(source)),artifact=file();
 return {contract:MANUAL_IMPORT_CONTRACT,nowMs:now,access:{ownerId:'owner',permission:'OWNER_WRITE'},current:{observedAtMs:now,deleted:false,readOnly:false,source},request:{requestId:uid(2),target:{ownerId:'owner',jobId:uid(1),videoId:'synthetic01',durationMs:10_000,segmentCount:2,canonicalSourceSha256},provenance:'ASSISTANT_AUTHORED_IMPORTED_SUMMARY',artifact,authoredBasis:{method:'AUTHOR_SOURCE_MANIFEST',canonicalSourceSha256,artifactSha256:artifact.sha256,basisEvidenceSha256:sha('synthetic independent basis evidence')},acknowledgements:{preserveExistingRecords:true,importIsNotAutomaticCompletion:true,sourceAccuracyNotVerified:true}},inventory:{ownerId:'owner',jobId:uid(1),observedAtMs:now,complete:true,attachments:[],requests:[]}};
}
const preview=value=>previewManualSummaryImport(encode(value));
const rejects=(value,code)=>assert.throws(()=>preview(value),error=>error.message==='MANUAL_IMPORT_'+code);
function attach(value,result=preview(value),overrides={}){
 const attachment={attachmentId:uid(3),revision:1,canonicalSourceSha256:value.request.target.canonicalSourceSha256,artifactSha256:value.request.artifact.sha256,provenance:value.request.provenance,...overrides};
 value.inventory.attachments.push(attachment);
 value.inventory.requests.push({requestId:value.request.requestId,requestFingerprintSha256:result.requestFingerprintSha256,state:'COMMITTED',attachmentId:attachment.attachmentId});
 return attachment;
}
function setArtifact(value,artifact){value.request.artifact=artifact;value.request.authoredBasis.artifactSha256=artifact.sha256;}

test('a valid offline preview is additive and never an authenticated import or automatic completion',()=>{
 const value=fixture(),before=encode(value),result=preview(value);
 assert.equal(result.outcome,'APPEND_CANDIDATE');assert.equal(result.structuralPreviewReady,true);
 for(const flag of ['productionExecutionSupported','provenanceAuthenticated','permissionVerified','importReady','automaticPipelineCompleted','automaticRetryAllowed'])assert.equal(result[flag],false,flag);
 assert.equal(productionExecutionSupported,false);assert.equal(result.writesPerformed,0);assert.equal(result.providerCalls,0);assert.equal(result.countTokensCalls,0);
 assert.equal(result.candidate.collection,'SEPARATE_IMPORTED_SUMMARY_ATTACHMENTS');assert.equal(result.candidate.providerExecution,'NOT_RUN_BY_APP');
 assert.equal(result.candidate.audioAccuracy,'NOT_VERIFIED');assert.equal(result.sourceBinding.status,'MATCHES_SUPPLIED_HASH_CLAIMS_ONLY');
 for(const field of ['jobs.report_json','jobs.status','jobs.audit_json','jobs.updated_at','yta_sources.*','billing receipts','usage events'])assert.ok(result.protectedExistingFields.includes(field));
 assert.equal(encode(value),before);assert.ok(Object.isFrozen(result.candidate.artifact));
 assert.throws(()=>{result.candidate.providerExecution='SUCCESS';},TypeError);
});
test('a manual author receives a distinct provenance with the same limitations',()=>{const value=fixture();value.request.provenance='MANUAL_IMPORTED';assert.equal(preview(value).candidate.provenance,'MANUAL_IMPORTED');});
test('source segment overlap is allowed without pretending to verify audio accuracy',()=>{assert.equal(preview(fixture()).candidate.audioAccuracy,'NOT_VERIFIED');});
test('numeric video identity cannot be silently string-coerced',()=>{const value=fixture();value.current.source.videoId=12345678901;rejects(value,'SOURCE_INVALID');});
test('duplicate segment IDs cannot enter the source binding',()=>{const value=fixture();value.current.source.segments[1].id=1;rejects(value,'SOURCE_SEGMENTS_INVALID');});
test('out-of-duration segments cannot enter the source binding',()=>{const value=fixture();value.current.source.segments[1].endMs=10001;rejects(value,'SOURCE_SEGMENTS_INVALID');});

for(const field of ['ownerId','jobId','videoId','durationMs','segmentCount','canonicalSourceSha256'])test('target '+field+' drift blocks attachment',()=>{
 const value=fixture();value.request.target[field]=field==='durationMs'?9999:field==='segmentCount'?3:field==='canonicalSourceSha256'?sha('other source'):'mismatch';rejects(value,'SOURCE_SCOPE_CHANGED');
});
for(const key of ['raw','text','time','provenance'])test('same segment count cannot hide source '+key+' drift',()=>{
 const value=fixture();if(key==='raw')value.current.source.raw+='\n';if(key==='text')value.current.source.segments[0].text+=' changed';if(key==='time')value.current.source.segments[0].endMs=3999;if(key==='provenance')value.current.source.sourceProvenance='OTHER_SOURCE';rejects(value,'SOURCE_SCOPE_CHANGED');
});
test('missing current source cannot be replaced by a claimed count or hash',()=>{const value=fixture();value.current.source={segmentCount:2,canonicalSourceSha256:value.request.target.canonicalSourceSha256};rejects(value,'SCHEMA_INVALID');});
test('missing target hash blocks even a valid full supplied source',()=>{const value=fixture();value.request.target.canonicalSourceSha256=null;rejects(value,'SOURCE_HASH_REQUIRED');});
for(const variant of ['missing','noEvidence','wrongSource','wrongArtifact'])test('independent authored basis '+variant+' is not inferred from source count',()=>{
 const value=fixture();if(variant==='missing')value.request.authoredBasis=null;if(variant==='noEvidence')value.request.authoredBasis.basisEvidenceSha256=null;if(variant==='wrongSource')value.request.authoredBasis.canonicalSourceSha256=sha('different source');if(variant==='wrongArtifact')value.request.authoredBasis.artifactSha256=sha('different summary');rejects(value,['missing','noEvidence'].includes(variant)?'BASIS_REVIEW_REQUIRED':'SOURCE_BASIS_MISMATCH');
});
test('synthetic reference without an authored source manifest stays blocked',()=>{
 const value=fixture();value.request.artifact.libraryFileId='libfile_synthetic_summary';value.request.authoredBasis=null;
 // No private summary bytes or actual SRT enter this synthetic fixture.
 rejects(value,'BASIS_REVIEW_REQUIRED');
});
for(const [field,changed,code] of [['deleted',true,'JOB_DELETED'],['readOnly',true,'READ_ONLY'],['observedAtMs',now-60_001,'SOURCE_CAPTURE_STALE'],['observedAtMs',now+1,'SOURCE_CAPTURE_STALE']])test('current '+field+' '+changed+' fails closed',()=>{const value=fixture();value.current[field]=changed;rejects(value,code);});
test('owner mismatch blocks without returning supplied content',()=>{const value=fixture();value.access.ownerId='other-owner';rejects(value,'OWNER_MISMATCH');});
test('read-only access does not produce an append candidate',()=>{const value=fixture();value.access.permission='READ_ONLY';rejects(value,'OWNER_WRITE_REQUIRED');});
for(const key of ['providerReceipt','approval','providerStatus','status','report_json','productionExecutionSupported'])test('forged '+key+' cannot be inserted into request',()=>{const value=fixture();value.request[key]='FORGED_SECRET_OR_SUCCESS';rejects(value,'SCHEMA_INVALID');});
test('provider-labelled provenance is rejected',()=>{const value=fixture();value.request.provenance='GEMINI_PAID_FULL_EVIDENCE_LINKED';rejects(value,'REQUEST_INVALID');});
test('missing acknowledgement cannot upgrade imported content',()=>{const value=fixture();value.request.acknowledgements.importIsNotAutomaticCompletion=false;rejects(value,'ACKNOWLEDGEMENT_REQUIRED');});

test('UTF-8 BOM, CRLF and trailing newline bytes are preserved exactly',()=>{
 const value=fixture(),bytes=Buffer.from('\uFEFF요약\r\n끝\r\n\n','utf8');setArtifact(value,file('',bytes));const result=preview(value);
 assert.equal(result.candidate.artifact.sha256,sha(bytes));assert.equal(result.candidate.artifact.sizeBytes,bytes.length);assert.equal(result.candidate.artifact.hasUtf8Bom,true);assert.equal(Buffer.from(result.candidate.artifact.text,'utf8').equals(bytes),true);
});
test('a trailing newline changes the exact content hash and new revision identity',()=>{const value=fixture(),first=preview(value);setArtifact(value,file('전체 구간의 합성 테스트 요약'));const second=preview(value);assert.notEqual(first.candidate.artifact.sha256,second.candidate.artifact.sha256);assert.notEqual(first.requestFingerprintSha256,second.requestFingerprintSha256);});
test('malformed UTF-8 is rejected instead of replaced',()=>{const value=fixture();setArtifact(value,file('',Buffer.from([0xc3,0x28])));rejects(value,'ARTIFACT_UTF8_INVALID');});
for(const text of ['', ' \r\n', '\uFEFF\n', 'text\u0000tail'])test('empty/control-only or binary content rejected '+JSON.stringify(text),()=>{const value=fixture();setArtifact(value,file(text));rejects(value,text.length===0?'ARTIFACT_INVALID':'ARTIFACT_TEXT_INVALID');});
test('over-size content is rejected before decoding',()=>{const value=fixture();setArtifact(value,file('x'.repeat(MAX_IMPORTED_SUMMARY_BYTES+1)));rejects(value,'ARTIFACT_INVALID');});
test('declared byte length cannot hide truncation',()=>{const value=fixture();value.request.artifact.sizeBytes++;rejects(value,'ARTIFACT_BYTES_MISMATCH');});
test('declared SHA cannot hide altered bytes',()=>{const value=fixture();value.request.artifact.sha256=sha('wrong');rejects(value,'ARTIFACT_BYTES_MISMATCH');});
test('noncanonical base64 pad bits are rejected',()=>{const value=fixture();setArtifact(value,file('f'));value.request.artifact.utf8Base64='Zh==';rejects(value,'ARTIFACT_BYTES_MISMATCH');});
test('HTML-looking input remains literal plain text with no evaluation',()=>{const value=fixture(),text='<script>throw Error("not executable")</script>\n<img src=x onerror=alert(1)>';setArtifact(value,file(text));const result=preview(value);assert.equal(result.candidate.artifact.text,text);assert.equal(result.candidate.artifact.renderMode,'TEXT_CONTENT_ONLY');});

test('same request and body after a committed response are read-only idempotent',()=>{const value=fixture();attach(value);const result=preview(value);assert.equal(result.outcome,'ALREADY_IMPORTED');assert.equal(result.existingAttachmentId,uid(3));assert.equal(result.nextAction,'READ_EXISTING_ATTACHMENT_ONLY');assert.equal(result.writesPerformed,0);assert.equal(result.candidate,undefined);});
test('same request ID with changed body conflicts',()=>{const value=fixture();attach(value);setArtifact(value,file('changed'));rejects(value,'REQUEST_ID_CONFLICT');});
test('new request ID and same source/content deduplicate',()=>{const value=fixture();attach(value);value.request.requestId=uid(4);assert.equal(preview(value).outcome,'ALREADY_IMPORTED');});
test('different provenance cannot relabel an existing identical import',()=>{const value=fixture();attach(value);value.request.requestId=uid(4);value.request.provenance='MANUAL_IMPORTED';rejects(value,'PROVENANCE_CONFLICT');});
test('new content is a new proposed revision, not an overwrite',()=>{const value=fixture();attach(value);value.request.requestId=uid(4);setArtifact(value,file('new revision'));const before=encode(value.inventory),result=preview(value);assert.equal(result.outcome,'APPEND_CANDIDATE');assert.equal(result.candidate.proposedRevision,2);assert.equal(encode(value.inventory),before);});
test('exhausted revision sequence blocks a new append before unsafe integer arithmetic',()=>{const value=fixture();attach(value,preview(value),{revision:Number.MAX_SAFE_INTEGER});value.request.requestId=uid(4);setArtifact(value,file('next revision'));const before=encode(value);rejects(value,'REVISION_EXHAUSTED');assert.equal(encode(value),before);});
test('exhausted revision sequence still permits reading the exact existing import',()=>{const value=fixture();attach(value,preview(value),{revision:Number.MAX_SAFE_INTEGER});assert.equal(preview(value).outcome,'ALREADY_IMPORTED');});
for(const changedId of [false,true])test('lost response blocks retry, including a fresh request ID '+changedId,()=>{const value=fixture(),first=preview(value);value.inventory.requests.push({requestId:value.request.requestId,requestFingerprintSha256:first.requestFingerprintSha256,state:'UNCERTAIN',attachmentId:null});if(changedId)value.request.requestId=uid(5);const result=preview(value);assert.equal(result.outcome,'RECONCILE_READ_ONLY');assert.equal(result.nextAction,'READ_IMPORT_OPERATION_AND_ATTACHMENT_ONLY');assert.equal(result.automaticRetryAllowed,false);assert.equal(result.candidate,undefined);});
test('an uncertain older import cannot be bypassed with different content',()=>{const value=fixture(),first=preview(value);value.inventory.requests.push({requestId:value.request.requestId,requestFingerprintSha256:first.requestFingerprintSha256,state:'UNCERTAIN',attachmentId:null});value.request.requestId=uid(5);setArtifact(value,file('different new content'));assert.equal(preview(value).outcome,'RECONCILE_READ_ONLY');});
test('a rejected request is never automatically retried',()=>{const value=fixture(),first=preview(value);value.inventory.requests.push({requestId:value.request.requestId,requestFingerprintSha256:first.requestFingerprintSha256,state:'REJECTED',attachmentId:null});rejects(value,'PREVIOUS_REQUEST_REJECTED');});
test('committed ledger must point to a compatible existing attachment',()=>{const value=fixture();attach(value,preview(value),{artifactSha256:sha('other')});rejects(value,'REPLAY_CONFLICT');});
for(const variant of ['incomplete','stale','wrongOwner','missingAttachment','duplicateAttachment','duplicateRequest'])test('inconsistent inventory '+variant+' blocks',()=>{
 const value=fixture();attach(value);if(variant==='incomplete')value.inventory.complete=false;if(variant==='stale')value.inventory.observedAtMs=now-60_001;if(variant==='wrongOwner')value.inventory.ownerId='other';if(variant==='missingAttachment')value.inventory.attachments=[];if(variant==='duplicateAttachment')value.inventory.attachments.push({...value.inventory.attachments[0]});if(variant==='duplicateRequest')value.inventory.requests.push({...value.inventory.requests[0]});rejects(value,variant==='stale'?'INVENTORY_STALE':'INVENTORY_INVALID');
});
test('duplicate source/content rows require review instead of choosing one',()=>{const value=fixture();attach(value);value.inventory.attachments.push({...value.inventory.attachments[0],attachmentId:uid(8),revision:2});value.request.requestId=uid(9);rejects(value,'DUPLICATE_ATTACHMENTS_REQUIRE_REVIEW');});
test('committed replay also reports duplicate source/content history for review',()=>{const value=fixture();attach(value);value.inventory.attachments.push({...value.inventory.attachments[0],attachmentId:uid(8),revision:2});rejects(value,'DUPLICATE_ATTACHMENTS_REQUIRE_REVIEW');});

test('JavaScript object with getter/toJSON is rejected without invoking either',()=>{let invoked=0;const input={get contract(){invoked++;return MANUAL_IMPORT_CONTRACT;},toJSON(){invoked++;return fixture();}};assert.throws(()=>previewManualSummaryImport(input),/MANUAL_IMPORT_JSON_INPUT_REQUIRED/);assert.equal(invoked,0);});
test('duplicate JSON keys are rejected',()=>{const json=encode(fixture()).replace('"contract":','"contract":"forged","contract":');assert.throws(()=>previewManualSummaryImport(json),/MANUAL_IMPORT_JSON_NON_CANONICAL/);});
test('prototype keys are rejected without pollution',()=>{const json=encode(fixture()).replace('"contract":','"__proto__":{"polluted":true},"contract":');assert.throws(()=>previewManualSummaryImport(json),/MANUAL_IMPORT_JSON_INVALID/);assert.equal({}.polluted,undefined);});
test('unpaired surrogate in a source cannot hash through UTF-8 replacement',()=>{const value=fixture();value.current.source.raw='\ud800';rejects(value,'UNICODE_INVALID');});
test('unknown error data is never included in a fixed error',()=>{const value=fixture();value.request.password='private-string-must-not-appear';try{preview(value);assert.fail('expected failure');}catch(error){assert.equal(error.message,'MANUAL_IMPORT_SCHEMA_INVALID');assert.equal(error.message.includes('private-string'),false);}});
