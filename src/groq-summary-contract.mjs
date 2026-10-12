// Keep the request body and the conservative input estimate on one contract.
// Strict decoding constrains field shapes; source grounding is still checked separately.
export const GROQ_SUMMARY_CONTRACT_VERSION='evidence-summary-v2';
const evidenceItem={type:'object',properties:{text:{type:'string'},evidenceIds:{type:'array',items:{type:'integer'}}},required:['text','evidenceIds'],additionalProperties:false};
const evidenceArray={type:'array',items:{$ref:'#/$defs/evidenceItem'}};
export const GROQ_SUMMARY_RESPONSE_FORMAT={type:'json_schema',json_schema:{name:'evidence_linked_summary_v2',strict:true,schema:{type:'object',properties:{summary:evidenceArray,chapters:evidenceArray,claims:evidenceArray,numbers:evidenceArray,critical:evidenceArray,conclusion:{type:'string'}},$defs:{evidenceItem},required:['summary','chapters','claims','numbers','critical','conclusion'],additionalProperties:false}}};
export const groqSummaryRequestBody=(messages,maxCompletionTokens)=>({model:'openai/gpt-oss-120b',messages,response_format:GROQ_SUMMARY_RESPONSE_FORMAT,reasoning_effort:'low',max_completion_tokens:maxCompletionTokens,temperature:0,stream:false});
