import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateAnalysis} from '../src/report.mjs';
import {assertGrounding} from '../src/groq-summary.mjs';
import {validatePaidFullReport} from '../src/paid-summary-contract.mjs';
import {summaryRequest,validateReview} from '../src/gemini-two-pass-contract.mjs';
import {windowManifest,validateWindowedSummary} from '../src/two-pass-windows.mjs';

// Entirely synthetic. No private transcript, original model prose, credentials,
// account identifiers or API calls are needed to reproduce the failure class.
const item=evidenceIds=>({text:'Synthetic source statement.',evidenceIds});
const sourceOf=segments=>({segments,raw:segments.map(s=>s.text).join('\n')});
const source=sourceOf(Array.from({length:10},(_,i)=>({id:i+1,startMs:i*600000,endMs:i===9?5891242:(i+1)*600000,text:'Synthetic source statement.'})));
const report=groups=>({summary:[item([1])],chapters:groups.map(item),claims:[],numbers:[],critical:[],conclusion:'Synthetic fixture; not an AI result.'});
const first=report([[1,2],[3,5],[6],[7,8]]);
const repair=report([[1,2],[3,5],[6],[7]]);
const windows=windowManifest(source);
const current=()=>({...report([]),chapters:windows.map(w=>({...item([w.primaryIds[0]]),windowKey:w.key,kind:'CONTENT'}))});
const missing=report=>{
 const ids=new Set(report.chapters.flatMap(c=>c.evidenceIds));
 return windows.filter(w=>!w.primaryIds.some(id=>ids.has(id))).map(w=>w.startMs/60000);
};

test('RCA: valid JSON and valid references can still omit chapter time windows',()=>{
 for(const candidate of [first,repair]){
  assert.doesNotThrow(()=>assertGrounding(validateAnalysis(candidate,source.segments,'gemini'),source.segments));
  assert.throws(()=>validatePaidFullReport(JSON.stringify(candidate),source),{safeValidationCode:'PAID_REPORT_WINDOW_COVERAGE'});
 }
 assert.equal(first.chapters.length,4);assert.equal(repair.chapters.length,4);
 assert.deepEqual(missing(first),[30,80,90]);assert.deepEqual(missing(repair),[30,70,80,90]);
});

test('RCA: repair notes cannot substitute for chapters or establish timestamps from prose',()=>{
 const wrapper={report:repair,repairs:[
  {kind:'COVERAGE',description:'Claimed repair of 30-40 minutes.',evidenceIds:[1]},
  {kind:'COVERAGE',description:'Claimed repair of 80-90 minutes.',evidenceIds:[8]},
  {kind:'COVERAGE',description:'Claimed repair of 90-98.2 minutes.',evidenceIds:[9]}
 ],uncertainties:[item([1])]};
 assert.deepEqual(wrapper.repairs.map(n=>source.segments[n.evidenceIds[0]-1].startMs/60000),[0,70,80]);
 assert.throws(()=>validatePaidFullReport(JSON.stringify(wrapper.report),source),{safeValidationCode:'PAID_REPORT_WINDOW_COVERAGE'});
 assert.throws(()=>validateReview(JSON.stringify(wrapper),source,current()),{code:'TWO_PASS_REVIEW_INVALID'});
});

test('RCA: the current request exposes the same deterministic window contract as validation',()=>{
 const request=summaryRequest(source,{}),prompt=request.contents[0].parts[0].text;
 assert.match(prompt,/Return exactly one chapter per manifest window/);
 assert.ok(prompt.includes(JSON.stringify(source.segments.map(s=>[s.id,s.startMs,s.endMs,s.text]))));
 assert.ok(prompt.includes(JSON.stringify(windows.map(w=>[w.key,w.startMs,w.endMs,w.primaryIds,w.boundaryIds]))));
 const schema=request.generationConfig.responseJsonSchema.properties.chapters.items;
 assert.deepEqual(schema.required,['windowKey','kind','text','evidenceIds']);
 assert.deepEqual(schema.properties.windowKey.enum,windows.map(w=>w.key));
 for(const oldShape of [first,repair])assert.throws(()=>validateWindowedSummary(JSON.stringify(oldShape),source),{safeValidationCode:'WINDOW_OUTPUT_INVALID'});
});

test('RCA: a valid whole-range structural fixture remains unverified until explicit acceptance',()=>{
 const result=validateWindowedSummary(JSON.stringify(current()),source);
 assert.equal(result.chapters.length,10);assert.equal(result.synthesisComplete,false);
 assert.equal(result.outputKind,'WINDOWED_DRAFT');assert.equal(result.audioAccuracy,'NOT_VERIFIED');
 assert.equal(result.sourceReview,'REQUIRED');assert.equal(result.semanticReview,'NOT_PERFORMED');
 const reviewed=validateReview(JSON.stringify({verdict:'PASS',issues:[]}),source,result);
 assert.equal(reviewed.verdict,'PASS');assert.equal(result.synthesisComplete,false);
});

test('RCA: removing any window, including the short last window, fails closed',()=>{
 for(let index=0;index<windows.length;index++){
  const candidate=current();candidate.chapters.splice(index,1);
  assert.throws(()=>validateWindowedSummary(JSON.stringify(candidate),source),error=>['WINDOW_OUTPUT_INVALID','WINDOW_COVERAGE_INCOMPLETE'].includes(error.safeValidationCode));
 }
});

test('RCA: duplicate, reordered and cross-window evidence cannot replace missing coverage',()=>{
 for(const change of [
  x=>x.chapters.push(x.chapters[0]),
  x=>x.chapters.reverse(),
  x=>{x.chapters[3].evidenceIds=[1];},
  x=>{x.chapters[9].kind='TRANSCRIPT_GAP';x.chapters[9].evidenceIds=[];}
 ]){const candidate=current();change(candidate);assert.throws(()=>validateWindowedSummary(JSON.stringify(candidate),source));}
});

test('RCA: a one millisecond boundary overlap does not count as primary coverage',()=>{
 const input=sourceOf([{id:1,startMs:0,endMs:600001,text:'Synthetic source statement.'},{id:2,startMs:600001,endMs:601000,text:'Synthetic source statement.'}]);
 const candidate={...report([]),chapters:[{...item([1]),windowKey:'w000',kind:'CONTENT'},{...item([1]),windowKey:'w001',kind:'CONTENT'}]};
 assert.throws(()=>validateWindowedSummary(JSON.stringify(candidate),input),{safeValidationCode:'WINDOW_EVIDENCE_OUT_OF_RANGE'});
 candidate.chapters[1].evidenceIds=[1,2];assert.equal(validateWindowedSummary(JSON.stringify(candidate),input).synthesisComplete,false);
});

test('RCA: an actual stored-transcript gap is represented without claiming audio silence',()=>{
 const input=sourceOf([{id:1,startMs:0,endMs:1000,text:'Synthetic source statement.'},{id:2,startMs:1200000,endMs:1201000,text:'Synthetic source statement.'}]);
 const candidate={...report([]),chapters:[{...item([1]),windowKey:'w000',kind:'CONTENT'},{text:'No stored transcript overlaps this window.',evidenceIds:[],windowKey:'w001',kind:'TRANSCRIPT_GAP'},{...item([2]),windowKey:'w002',kind:'CONTENT'}]};
 const checked=validateWindowedSummary(JSON.stringify(candidate),input);
 assert.equal(checked.audioAccuracy,'NOT_VERIFIED');assert.equal(checked.synthesisComplete,false);
});

test('RCA: repeated validation preserves the failed report and source instead of repairing silently',()=>{
 const before=JSON.stringify({source,first,repair});
 for(let i=0;i<3;i++)for(const candidate of [first,repair])assert.throws(()=>validatePaidFullReport(JSON.stringify(candidate),source),{safeValidationCode:'PAID_REPORT_WINDOW_COVERAGE'});
 assert.equal(JSON.stringify({source,first,repair}),before);
});
