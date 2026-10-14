import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {windowManifest,windowedSummarySchema,validateWindowedSummary} from '../src/two-pass-windows.mjs';
import {sourceSnapshot,summaryRequest} from '../src/gemini-two-pass-contract.mjs';

const segment=(id,startMs,endMs,text=`segment ${id}`)=>({id,startMs,endMs,text});
const source=segments=>({segments,raw:segments.map(s=>s.text).join('\n')});
const report=chapters=>({summary:[{text:'segment 1',evidenceIds:[1]}],chapters,claims:[],numbers:[],critical:[],conclusion:'Stored transcript only.'});
const chapter=(windowKey,kind,evidenceIds,text='This window contains the cited transcript.')=>({windowKey,kind,text,evidenceIds});

test('manifest uses timestamps, includes boundary overlap, and keeps a short last window',()=>{
 const input=source([segment(1,0,600001),segment(2,590000,610000),segment(3,600000,1200000),segment(4,1200000,1201000)]);
 assert.deepEqual(windowManifest(input),[
  {key:'w000',startMs:0,endMs:600000,primaryIds:[1,2],boundaryIds:[]},
  {key:'w001',startMs:600000,endMs:1200000,primaryIds:[3],boundaryIds:[1,2]},
  {key:'w002',startMs:1200000,endMs:1201000,primaryIds:[4],boundaryIds:[]}
 ]);
 const prompt=summaryRequest(input,{});assert.ok(prompt.contents[0].parts[0].text.includes('"w001",600000,1200000,[3],[1,2]'));
 assert.deepEqual(prompt.generationConfig.responseJsonSchema.properties.chapters.items.properties.windowKey.enum,['w000','w001','w002']);
 const valid=validateWindowedSummary(JSON.stringify(report([chapter('w000','CONTENT',[1,2]),chapter('w001','CONTENT',[3]),chapter('w002','CONTENT',[4])])),input);
 assert.equal(valid.windowValidation,'TIMESTAMP_PRIMARY_IDS_AND_BOUNDARY_REFERENCES');assert.equal(valid.semanticReview,'NOT_PERFORMED');assert.equal(valid.synthesisComplete,false);assert.equal(valid.outputKind,'WINDOWED_DRAFT');
 assert.throws(()=>validateWindowedSummary(JSON.stringify(report([chapter('w000','CONTENT',[1]),chapter('w001','CONTENT',[4]),chapter('w002','CONTENT',[4])])),input),{safeValidationCode:'WINDOW_EVIDENCE_OUT_OF_RANGE'});
});

test('untranscribed gaps are not called audio silence; greetings require primary evidence',()=>{
 const input=source([segment(1,0,1000),segment(2,1200000,1201000,'hello again')]);
 assert.equal(windowManifest(input).length,3);assert.deepEqual(windowManifest(input)[1].primaryIds,[]);
 const valid=validateWindowedSummary(JSON.stringify(report([chapter('w000','CONTENT',[1]),chapter('w001','TRANSCRIPT_GAP',[],'No stored transcript segment overlaps this window.'),chapter('w002','NON_SUBSTANTIVE',[2],'Only a greeting appears in the stored transcript.')])),input);
 assert.equal(valid.chapters[1].kind,'TRANSCRIPT_GAP');
 assert.equal(valid.audioAccuracy,'NOT_VERIFIED');assert.equal(valid.sourceReview,'REQUIRED');assert.equal(valid.synthesisComplete,false);
 assert.throws(()=>validateWindowedSummary(JSON.stringify(report([chapter('w000','CONTENT',[1]),chapter('w001','SILENCE',[],'Audio is silent.'),chapter('w002','NON_SUBSTANTIVE',[2])])),input),{safeValidationCode:'WINDOW_OUTPUT_INVALID'});
 assert.throws(()=>validateWindowedSummary(JSON.stringify(report([chapter('w000','CONTENT',[1]),chapter('w001','CONTENT',[1]),chapter('w002','CONTENT',[2])])),input),{safeValidationCode:'WINDOW_EVIDENCE_OUT_OF_RANGE'});
 assert.throws(()=>validateWindowedSummary(JSON.stringify(report([chapter('w000','CONTENT',[1]),chapter('w001','TRANSCRIPT_GAP',[],'Empty'),chapter('w002','TRANSCRIPT_GAP',[],'Empty')])),input),{safeValidationCode:'WINDOW_EVIDENCE_OUT_OF_RANGE'});
});

test('a one millisecond overlap is only auxiliary evidence, never primary coverage',()=>{
 const input=source([segment(1,599999,600001),segment(2,600001,601000)]);
 assert.deepEqual(windowManifest(input)[1],{key:'w001',startMs:600000,endMs:601000,primaryIds:[2],boundaryIds:[1]});
 assert.throws(()=>validateWindowedSummary(JSON.stringify(report([chapter('w000','CONTENT',[1]),chapter('w001','CONTENT',[1])])),input),{safeValidationCode:'WINDOW_EVIDENCE_OUT_OF_RANGE'});
 assert.equal(validateWindowedSummary(JSON.stringify(report([chapter('w000','CONTENT',[1]),chapter('w001','CONTENT',[1,2])])),input).synthesisComplete,false);
});

test('all 1,226 segments labeled NON_SUBSTANTIVE remain an unapproved draft',()=>{
 const segments=Array.from({length:1226},(_,i)=>segment(i+1,i*4807,(i+1)*4807));
 const input=source(segments),windows=windowManifest(input);
 const draft=validateWindowedSummary(JSON.stringify(report(windows.map(w=>chapter(w.key,'NON_SUBSTANTIVE',[w.primaryIds[0]],'The model calls this entire window non-substantive.')))),input);
 assert.equal(windows.length,10);assert.equal(draft.synthesisComplete,false);assert.equal(draft.sourceReview,'REQUIRED');assert.equal(draft.outputKind,'WINDOWED_DRAFT');
});

test('coverage, duplicate window keys, and missing IDs fail closed',()=>{
 const input=source([segment(1,0,1000),segment(2,600000,601000)]);
 assert.throws(()=>validateWindowedSummary(JSON.stringify(report([chapter('w000','CONTENT',[1])])),input),{safeValidationCode:'WINDOW_COVERAGE_INCOMPLETE'});
 assert.throws(()=>validateWindowedSummary(JSON.stringify(report([chapter('w000','CONTENT',[1]),chapter('w000','CONTENT',[1])])),input),{safeValidationCode:'WINDOW_OUTPUT_INVALID'});
 assert.throws(()=>validateWindowedSummary(JSON.stringify(report([chapter('w001','CONTENT',[2]),chapter('w000','CONTENT',[1])])),input),{safeValidationCode:'WINDOW_OUTPUT_INVALID'});
 assert.throws(()=>sourceSnapshot(source([segment(1,0,1000),segment(3,600000,601000)])),{safeValidationCode:'WINDOW_SOURCE_INVALID'});
 assert.throws(()=>sourceSnapshot(source([segment(1,0,1000),segment(2,600000,600000)])),{safeValidationCode:'WINDOW_SOURCE_INVALID'});
});
