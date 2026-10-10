// MP3 frame-aware slicing. No YouTube downloading; lawful user files only.
export function scanMp3(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length<4)throw Error('MP3_INVALID');
 let offset=0;if(bytes[0]===73&&bytes[1]===68&&bytes[2]===51){if(bytes.length<10)throw Error('MP3_ID3');offset=10+((bytes[6]&127)*2097152+(bytes[7]&127)*16384+(bytes[8]&127)*128+(bytes[9]&127))+((bytes[5]&16)?10:0);}
 const frames=[];let seconds=0,skipped=0;
 while(offset+4<=bytes.length){
  const a=bytes[offset],b=bytes[offset+1],c=bytes[offset+2];
  const version=(b>>3)&3,layer=(b>>1)&3,rateIndex=(c>>2)&3,bitIndex=c>>4;
  if(a!==255||(b&224)!==224||version===1||layer!==1||rateIndex===3||bitIndex===0||bitIndex===15){offset++;skipped++;if(frames.length&&skipped>2048)break;continue;}
  const rates=[44100,48000,32000];const sampleRate=rates[rateIndex]/(version===3?1:version===2?2:4);
  const bitRate=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitIndex]*1000;
  const size=Math.floor((version===3?144:72)*bitRate/sampleRate)+((c>>1)&1);
  if(offset+size>bytes.length)break;
  const duration=(version===3?1152:576)/sampleRate;
  frames.push({byteStart:offset,byteEnd:offset+size,start:seconds,end:seconds+duration});seconds+=duration;offset+=size;skipped=0;
 }
 if(frames.length<2||seconds>7205)throw Error('MP3_DURATION_OR_FRAMES');
 return {frames,durationSeconds:seconds};
}
export function planMp3(bytes,{chunkSeconds=300,overlapSeconds=3,maxBytes=8_000_000}={}){
 if(chunkSeconds<10||chunkSeconds>600||overlapSeconds<0||overlapSeconds>=chunkSeconds)throw Error('CHUNK_CONFIG');
 const {frames,durationSeconds}=scanMp3(bytes),chunks=[];let frameIndex=0;
 while(frameIndex<frames.length){
  const first=frameIndex;let last=first;
  while(last+1<frames.length&&frames[last+1].end-frames[first].start<=chunkSeconds&&frames[last+1].byteEnd-frames[first].byteStart<=maxBytes)last++;
  chunks.push({index:chunks.length,byteStart:frames[first].byteStart,byteEnd:frames[last].byteEnd,start:frames[first].start,end:frames[last].end});
  if(last===frames.length-1)break;
  let next=last+1;while(next>first+1&&frames[next-1].start>=frames[last].end-overlapSeconds)next--;
  if(next<=first)throw Error('CHUNK_NO_PROGRESS');frameIndex=next;
 }
 return {durationSeconds,chunks};
}
export function mergeAudioSegments(chunks){
 const segments=[];let previousEnd=0;const missingChunks=[];
 for(const chunk of [...chunks].sort((a,b)=>a.start-b.start)){
  const items=chunk.segments||[];if(!items.length)missingChunks.push(chunk.index);
  for(const s of items){
   const start=chunk.start+Number(s.start),end=chunk.start+Number(s.end),text=String(s.text||'').trim();
   if(!text||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||start<chunk.start-.1||end>chunk.end+2)continue;
   if(chunk.index>0&&(start+end)/2<previousEnd)continue;
   segments.push({startMs:Math.round(start*1000),endMs:Math.round(end*1000),text,chunk:chunk.index});
  }
  previousEnd=Math.max(previousEnd,chunk.end);
 }
 return {segments,missingChunks};
}
