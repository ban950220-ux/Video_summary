import {withoutComment} from './full-coverage-config.mjs';

export const geminiPaidFlagNames=Object.freeze([
 'ENABLE_GEMINI_TWO_PASS_PAID',
 'GEMINI_TWO_PASS_PAID_EXECUTION_APPROVED',
 'GEMINI_TWO_PASS_COST_BUFFER_APPROVED',
]);

// These reviewed dashboard variables must survive keep_vars. Never activate
// them through checked-in TOML, including quoted, dotted or preview keys.
export function assertGeminiPaidConfig(config){
 if(typeof config!=='string')throw Error('GEMINI_PAID_CONFIG_INVALID');
 for(const original of config.split(/\r?\n/)){
  const line=withoutComment(original);
  if(/\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/.test(line))throw Error('GEMINI_PAID_CONFIG_INVALID');
  if(geminiPaidFlagNames.some(name=>line.includes(name)))throw Error('GEMINI_PAID_FLAGS_MUST_STAY_OUT_OF_CONFIG');
 }
 return true;
}

export function expectedRuntimeFlags(baseline,{postDeploy=false}={}){
 return {...baseline.runtimeFlags,...(postDeploy?{ENABLE_LIVE_FREE:'true'}:{}),
  ...(baseline.fullCoverageEnabled===true?{ENABLE_FULL_COVERAGE:'true'}:{}),
  ...(baseline.geminiTwoPassPaidEnabled===true?Object.fromEntries(geminiPaidFlagNames.map(name=>[name,'true'])):{})};
}

// Carry the existing protected review's times across asynchronous remote reads.
// This is a deployment review, not the separate 30-minute D1 quote/approval.
export function assertGeminiPaidReviewFresh(baseline){
 if(baseline.geminiTwoPassPaidEnabled!==true)return;
 const iso=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
 const start=Date.parse(baseline.deploymentEvidenceReviewedAt),end=Date.parse(baseline.deploymentEvidenceExpiresAt),now=Date.now();
 if(!iso.test(baseline.deploymentEvidenceReviewedAt)||!iso.test(baseline.deploymentEvidenceExpiresAt)||!Number.isFinite(start)||!Number.isFinite(end)||start>now||end<=now||end-start>24*60*60*1000)throw Error('Remote deployment guard: DEPLOYMENT_EVIDENCE_EXPIRED');
}
