import {readFile} from 'node:fs/promises';
import {partitionGroqTranscript} from '../src/groq-summary.mjs';
import {fullCoveragePlan,FULL_COVERAGE_DAY_RESERVATION,FULL_COVERAGE_OUTPUT_TOKENS} from '../src/groq-full-coverage.mjs';

const path=process.argv[2];
if(!path)throw Error('Pass a local read-only source snapshot path');
const snapshot=JSON.parse(await readFile(path,'utf8')),{source}=snapshot;
const groups=partitionGroqTranscript(source.segments,{durationSeconds:5892,audioProcessingCoverage:1,independentVerification:false,externalFactCheck:'NOT_PERFORMED',audioBoundarySegmentIds:snapshot.audioBoundaryAmbiguities.map(item=>item.segmentId)});
const item=group=>({text:'Offline placeholder for sizing only',evidenceIds:[group[0].id,group.at(-1).id]});
const reports=groups.slice(0,8).map(group=>({summary:[item(group)],chapters:[item(group)],claims:[],numbers:[],critical:[],conclusion:'Offline placeholder'}));
const plan=await fullCoveragePlan({segments:source.segments,raw:source.raw,legacyGroups:groups,savedLegacyReports:reports,summarizeHeldStage:true});
const leaves=plan.stages.filter(stage=>['NEW_HELD_LEAF','NEW_LEAF'].includes(stage.kind));
const totalReservationTokens=leaves.reduce((sum,stage)=>sum+stage.reservationTokens,0);
const sourcePayloadBytes=leaves.reduce((sum,stage)=>sum+new TextEncoder().encode(JSON.stringify(stage.segments.map(s=>[s.id,s.text]))).length,0);
const inputByteReservations=leaves.reduce((sum,stage)=>sum+stage.inputBytes,0);
process.stdout.write(JSON.stringify({sourceSegments:plan.segmentCount,legacyGroups:groups.length,legacyReused:8,legacyHeld:'raw:8',newHeldStageRequiresExplicitApproval:true,newLeafCalls:leaves.length,sourcePayloadBytes,inputByteReservations,requestScaffoldingAndSafetyBytes:inputByteReservations-sourcePayloadBytes,completionTokenCaps:leaves.length*FULL_COVERAGE_OUTPUT_TOKENS,maxInputByteReservation:Math.max(...leaves.map(stage=>stage.inputBytes)),maxRequestReservation:Math.max(...leaves.map(stage=>stage.reservationTokens)),totalReservationTokens,minimumRollingDayWindows:Math.ceil(totalReservationTokens/FULL_COVERAGE_DAY_RESERVATION),firstNewId:leaves[0]?.firstId,lastNewId:leaves.at(-1)?.lastId,actualUsage:'UNKNOWN_NO_PROVIDER_CALL',reportStatus:'OFFLINE_PLAN_ONLY'},null,2)+'\n');
