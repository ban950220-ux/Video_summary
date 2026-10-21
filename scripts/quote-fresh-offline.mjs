// Local sizing only. Reads a saved transcript and never calls a provider or D1.
import {readFileSync} from 'node:fs';
import {fullCoveragePlan,FULL_COVERAGE_DAY_RESERVATION} from '../src/groq-full-coverage.mjs';
import {synthesisQuoteEstimate} from '../src/groq-complete-synthesis.mjs';

if(process.argv.length!==3)throw Error('Pass one local source snapshot JSON path');
const snapshot=JSON.parse(readFileSync(process.argv[2],'utf8'));
const source=snapshot.source;
if(!source||!Array.isArray(source.segments)||typeof source.raw!=='string')throw Error('SOURCE_REQUIRED');
const plan=await fullCoveragePlan({segments:source.segments,raw:source.raw,sourceAuditSha256:'0'.repeat(64),freshTranscript:true});
const leaves=plan.stages;
// One note per leaf is a scenario; the full coverage manifest caps saved
// evidence at two notes per leaf and rejects overflow before any synthesis.
const scenario=synthesisQuoteEstimate(leaves.length,4),upper=synthesisQuoteEstimate(leaves.length*2,4);
const leafInputByteReservations=leaves.reduce((n,stage)=>n+stage.inputBytes,0);
const leafOutputTokenCaps=leaves.reduce((n,stage)=>n+stage.outputTokens,0);
const leafReservation=leaves.reduce((n,stage)=>n+stage.reservationTokens,0);
const combinedReservation=leafReservation+upper.totalReservationUpper;
console.log(JSON.stringify({kind:'FRESH_TRANSCRIPT_OFFLINE_BOUNDED_QUOTE_V2',sourceSegments:source.segments.length,
 leafCalls:leaves.length,leafInputByteReservations,leafOutputTokenCaps,leafReservation,
 leafMaxInputBytes:Math.max(...leaves.map(stage=>stage.inputBytes)),leafMaxOutputTokens:Math.max(...leaves.map(stage=>stage.outputTokens)),
 synthesisFanout:4,maxNotesPerLeaf:2,maxSynthesisNotes:leaves.length*2,
 synthesisInputUpperPerCall:upper.inputUpperPerCall,synthesisOutputUpperPerCall:upper.outputUpperPerCall,
 synthesisCallsUpper:upper.calls,synthesisInputByteReservationsUpper:upper.calls*upper.inputUpperPerCall,
 synthesisOutputTokenCapsUpper:upper.calls*upper.outputUpperPerCall,
 synthesisReservationUpper:upper.totalReservationUpper,totalCallsUpper:leaves.length+upper.calls,combinedReservationUpper:combinedReservation,
 minimumRollingDayWindows:Math.ceil(combinedReservation/FULL_COVERAGE_DAY_RESERVATION),
 oneNotePerLeafScenario:{synthesisCalls:scenario.calls,synthesisReservation:scenario.totalReservationUpper,combinedReservation:leafReservation+scenario.totalReservationUpper},
 caveat:'UTF-8 byte reservations are not actual model token counts. If any saved section needs more than two bounded notes, synthesis stops without dropping content. Account balance and operating key-to-Free-organization linkage are unknown.'},null,2));
