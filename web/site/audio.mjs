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
function mp3TagCrc(bytes){let crc=0;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>1)^((crc&1)?0xa001:0);}return crc;}
export function prepareMp3Chunk(bytes){
 const {frames}=scanMp3(bytes),first=frames[0],head=bytes.subarray(0,Math.min(first.byteEnd,256));
 if(first.byteStart!==0||frames.some((frame,i)=>i&&frame.byteStart!==frames[i-1].byteEnd)||frames.at(-1).byteEnd!==bytes.length)throw Error('MP3_CHUNK_FRAMES_UNVERIFIED');
 const version=(head[1]>>3)&3,mono=(head[3]>>6)===3,sideStart=4,sideLength=version===3?(mono?17:32):(mono?9:17),xing=sideStart+sideLength;
 const word=offset=>String.fromCharCode(...head.subarray(offset,offset+4)),markers=[];
 for(let i=0;i+4<=head.length;i++)if(['Xing','Info','VBRI'].includes(word(i)))markers.push(i);
 if(!markers.length)return {bytes,metadataCorrected:false};
 if(markers.length!==1||markers[0]!==xing||!['Xing','Info'].includes(word(xing)))throw Error('MP3_METADATA_UNSUPPORTED');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),flags=view.getUint32(xing+4);
 if(![3,15].includes(flags)||first.byteEnd<xing+(flags===15?156:16))throw Error('MP3_XING_LAYOUT_UNSUPPORTED');
 const frameCount=frames.length-1,advertisedFrames=view.getUint32(xing+8),advertisedBytes=view.getUint32(xing+12);
 if(flags===3&&['LAME','Lavf','Lavc'].includes(word(xing+16)))throw Error('MP3_XING_EXTENSION_UNSUPPORTED');
 if(advertisedFrames===frameCount&&advertisedBytes===bytes.length)return {bytes,metadataCorrected:false};
 if(advertisedFrames<frameCount||advertisedBytes<bytes.length)throw Error('MP3_XING_COUNTS_INVALID');
 const prepared=Uint8Array.from(bytes),out=new DataView(prepared.buffer),endOfFirst=first.byteEnd;
 out.setUint32(xing+8,frameCount);out.setUint32(xing+12,prepared.length);
 if(flags===15){
  const tag=xing+120,encoder=word(tag);
  if(!['LAME','Lavf','Lavc'].includes(encoder)||endOfFirst<xing+156)throw Error('MP3_LAME_TAG_UNSUPPORTED');
  if(first.byteEnd<190)throw Error('MP3_LAME_CRC_SPAN_UNSUPPORTED');
  const originalTag=Uint8Array.from(bytes.subarray(0,190));originalTag.fill(0,xing+154,xing+156);
  if(mp3TagCrc(originalTag)!==view.getUint16(xing+154))throw Error('MP3_LAME_CRC_INVALID');
  const toc=xing+16;prepared[toc]=0;
  for(let i=1;i<100;i++){const frame=frames[Math.min(frames.length-1,1+Math.floor(i*frameCount/100))];prepared[toc+i]=Math.min(255,Math.floor(256*frame.byteStart/prepared.length));}
  const paddingField=xing+141,delayPadding=(prepared[paddingField]<<16)|(prepared[paddingField+1]<<8)|prepared[paddingField+2];
  const delay=delayPadding>>>12;prepared[paddingField]=delay>>>4;prepared[paddingField+1]=(delay&15)<<4;prepared[paddingField+2]=0;
  out.setUint32(xing+148,prepared.length);
  out.setUint16(xing+152,mp3TagCrc(prepared.subarray(endOfFirst)));
  const correctedTag=Uint8Array.from(prepared.subarray(0,190));correctedTag.fill(0,xing+154,xing+156);
  out.setUint16(xing+154,mp3TagCrc(correctedTag));
 }
 return {bytes:prepared,metadataCorrected:true};
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
