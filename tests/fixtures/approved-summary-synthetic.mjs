// Entirely invented classroom demonstration. No real video, user or operation IDs.
export function syntheticApprovedSource(){
 const segments=[
  {id:1,startMs:0,endMs:19000,text:'가상 상자 실험에서 연구자는 뚜껑을 닫으면 열의 유출이 줄어 내부 온도가 더 천천히 낮아진다고 설명했다. 이 설명은 같은 재료와 같은 실내 조건을 가정한다.'},
  {id:2,startMs:20000,endMs:39000,text:'다만 뚜껑에 큰 구멍이 있으면 같은 효과를 기대하기 어렵다는 반례를 들었다. 실험 밖의 모든 상자에 같은 효과가 있다고 단정하지 않았다.'},
  {id:3,startMs:40000,endMs:59000,text:'다른 가상 관찰에서는 방문객 수와 음료 판매가 함께 늘었다. 두 변수가 함께 움직였을 뿐 방문객 증가가 판매 증가의 원인이라는 결론은 내리지 않았다.'},
  {id:4,startMs:60000,endMs:79000,text:'관찰은 맑은 날에만 이루어졌다. 비 오는 날의 결과와 판매 증가의 작동 과정은 자료에 제시하지 않았다.'},
 ];
 return {segments,raw:segments.map(item=>item.text).join('\n'),provenance:'SYNTHETIC_TRANSCRIPT_ONLY'};
}
const citation=(source,id)=>({id,quote:source.segments.find(item=>item.id===id).text});
const statement=(source,text,ids,chapterIds)=>({...(chapterIds?{chapterIds}:{}),status:'SOURCE_STATED',text,evidenceIds:ids,sourceQuotes:ids.map(id=>citation(source,id))});
const absent=(chapterIds,causal=false)=>({...(chapterIds?{chapterIds}:{}),status:causal?'NOT_ESTABLISHED':'NOT_FOUND',text:'자료에서 확인되지 않음',evidenceIds:[],sourceQuotes:[]});
export function syntheticApprovedPayload(source=syntheticApprovedSource()){
 return {
  formatVersion:'approved-four-part-v1',
  keyConclusion:statement(source,'가상 상자 실험은 조건이 같을 때 뚜껑이 열 유출을 줄인다는 설명과 구멍 난 뚜껑의 예외를 제시한다. 방문객과 판매의 동반 증가는 인과관계로 결론 내리지 않았다.',[1,2,3]),
  outline:[
   {id:'c1',title:'뚜껑과 열 유출의 조건',oneLineSummary:'연구자는 같은 조건의 상자에서 열 유출 감소를 설명하고 구멍 난 뚜껑의 예외를 함께 제시했다.',evidenceIds:[1,2],sourceQuotes:[citation(source,1),citation(source,2)]},
   {id:'c2',title:'동반 변화와 인과관계의 구분',oneLineSummary:'방문객과 판매가 함께 늘었지만 원인이라는 결론과 판매 증가의 기전은 제시하지 않았다.',evidenceIds:[3,4],sourceQuotes:[citation(source,3),citation(source,4)]},
  ],
  causalDetails:[
   statement(source,'연구자는 뚜껑을 닫는 조치가 열의 유출을 줄이고, 그 결과 내부 온도가 더 천천히 낮아지는 과정을 설명했다. 같은 재료와 실내 조건이라는 전제 아래의 설명이며 큰 구멍이 있는 뚜껑에는 같은 효과를 기대하기 어렵다고 한정했다. 이는 자료 속 연구자의 설명이지 외부 실험으로 확인한 결론은 아니다.',[1,2],['c1']),
   absent(['c2'],true),
  ],
  assumptions:[
   statement(source,'상자 설명은 재료와 실내 조건이 같다는 전제를 둔다.',[1],['c1']),
   statement(source,'방문객과 판매의 관찰 범위는 맑은 날뿐이며 비 오는 날에는 적용 여부를 알 수 없다.',[4],['c2']),
  ],
  counterexamples:[statement(source,'뚜껑에 큰 구멍이 있는 경우에는 같은 효과를 기대하기 어렵다는 반례가 제시되었다.',[2],['c1']),absent(['c2'])],
 };
}
export function syntheticApprovedReport(source=syntheticApprovedSource()){
 const approvedSummary=syntheticApprovedPayload(source);
 return {summary:[{text:approvedSummary.keyConclusion.text,evidenceIds:[1,2,3]}],chapters:approvedSummary.outline.map(item=>({text:item.oneLineSummary,evidenceIds:item.evidenceIds})),claims:[{text:'자료 속 설명과 관찰의 한계를 구분했다.',evidenceIds:[1,3]}],numbers:[],critical:[{text:'같은 조건의 전제와 구멍 난 뚜껑의 반례가 있다.',evidenceIds:[1,2]}],conclusion:approvedSummary.keyConclusion.text,approvedSummary};
}
export function syntheticSemanticCounterexample(source=syntheticApprovedSource()){
 const value=syntheticApprovedPayload(source);
 // Intentional semantic error with real fixture references. Shape validation is
 // expected to pass; an independent meaning review must reject this conclusion.
 value.keyConclusion.text='방문객 증가가 음료 판매 증가의 원인이라고 입증되었다.';
 value.keyConclusion.evidenceIds=[3];value.keyConclusion.sourceQuotes=[citation(source,3)];
 return value;
}
