import {ProviderError} from './adapters.mjs';

// One D1 query is counted when its result is awaited. Budget from the start of
// the live route, including schema, owner, claim, guards, usage and failure writes.
export const GROQ_D1_MAX_QUERIES=50;
export const GROQ_D1_POST_DISPATCH_RESERVE=6;
// Raw: key lookup + two shared-claim reads + two atomic guard reads.
// Synthesis: key lookup + two shared-claim reads + two four-read guards.
export const GROQ_RAW_PREFLIGHT_QUERIES=5;
export const GROQ_SYNTHESIS_PREFLIGHT_QUERIES=11;
export function groqD1Budget(db){
 let used=0;
 const blocked=()=>{const error=new ProviderError('GROQ_D1_BUDGET','요약 요청을 보내기 전에 D1 기록 여유가 부족합니다.');error.preDispatchBlocked=true;throw error;};
 const ensure=required=>{if(!Number.isSafeInteger(required)||required<0||used+required>GROQ_D1_MAX_QUERIES)blocked();};
 const prepare=sql=>{
  const statement=db.prepare(sql);
  const wrap=bound=>({
   bind(...args){return wrap(bound.bind(...args));},
   async first(){ensure(1);used++;return bound.first();},
   async all(){ensure(1);used++;return bound.all();},
   async run(){ensure(1);used++;return bound.run();},
  });
  return wrap(statement);
 };
 return {DB:{prepare},ensure,used:()=>used};
}
