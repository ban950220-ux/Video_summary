// A provider response belongs to one operation and one preselected event ID.
// If D1 committed an INSERT but lost its reply, read back that same ID before
// recording the failure. Never allocate another event for the same response.
export async function reconcileGroqUsageEvent(env,{jobId,eventId,capability,totalTokens,successProvenance,failedProvenance}){
 if(typeof eventId!=='string'||!Number.isSafeInteger(totalTokens)||totalTokens<0)return false;
 const read=()=>env.DB.prepare("SELECT job_id,owner_id,provider,capability,unit,used_units,provenance FROM usage_events WHERE id=?").bind(eventId).first();
 let row=await read();
 if(!row){
  try{await env.DB.prepare("INSERT OR IGNORE INTO usage_events(id,job_id,owner_id,provider,capability,unit,used_units,estimated_usd,actual_usd,provenance,captured_at) VALUES(?,?,'owner','groq',?,'actual_total_tokens',?,0,NULL,?,?)").bind(eventId,jobId,capability,totalTokens,failedProvenance,new Date().toISOString()).run();}catch{}
  row=await read();
 }
 return row?.job_id===jobId&&row.owner_id==='owner'&&row.provider==='groq'&&row.capability===capability&&row.unit==='actual_total_tokens'&&row.used_units===totalTokens&&[successProvenance,failedProvenance].includes(row.provenance);
}
