// Display only durable server evidence. A CLAIMED row reserves the app slot;
// it does not prove that Groq received the request or started inference.
export function groqSummaryProgress(status,{phase='idle',reason=null,waitUntil=null,now=Date.now()}={}){
 const saved=Number.isSafeInteger(status?.completedStages)?status.completedStages:0;
 const maximum=Number.isSafeInteger(status?.plannedMaximumRequests)?status.plannedMaximumRequests:null;
 const count=maximum===null?`저장된 중간 단계 ${saved}개`:`저장된 중간 단계 ${saved}개 · 계획 최대 ${maximum}요청`;
 const approval=status?.approval,active=status?.activeStage;
 const result=(headline,detail,tone='neutral',canExecute=false)=>({headline,detail:detail?`${detail} · ${count}`:count,tone,canExecute});
 if(status?.finalReportSaved)return result('최종 요약 저장 완료','이력에서 보고서를 다시 열고 TXT로 내보낼 수 있습니다.','done');
 if(active?.key==='raw:8:correction'){
  if(active.state==='CLAIMED')return result('raw:8 교정 1회 접수 확인','새 교정 슬롯이 기록됐습니다. 제공자 수신 여부와 결과는 아직 미확인입니다. 자동 재전송하지 마세요.','working');
  if(active.state==='FAILED_UNCERTAIN')return result('raw:8 교정 1회 결과 불확실','기존 raw:8 실패와 별개의 새 시도입니다. 제공자 사용량과 안전한 제한 정보를 확인하기 전 재전송하지 마세요.','warning');
  if(active.state==='BLOCKED')return result('raw:8 교정 1회 전송 전 차단','새 교정 시도는 제공자 전송 전에 차단됐습니다. 저장된 원장과 승인 범위를 확인하세요.','warning');
 }
 if(active?.state==='FAILED_UNCERTAIN')return result('모델 요청 결과 불확실','원장에 미확정 요청이 있습니다. 제공자 사용량과 기록을 검토하기 전 재전송하지 마세요.','warning');
 if(active?.state==='BLOCKED')return result('요약 요청 차단 기록 확인','승인·원본·키 상태를 검토하세요. 자동 재전송은 없습니다.','warning');
 if(active?.state==='CLAIMED')return phase==='unknown'?result('앱 서버 접수 확인 · 결과 불명','요청 슬롯은 기록됐지만 응답을 받지 못했습니다. 제공자 수신 여부는 미확인이고 재전송하지 마세요.','warning'):result('앱 서버 접수 확인','요청 슬롯이 기록됐습니다. 모델 결과를 기다리거나 확인 중이며 제공자 수신은 확인되지 않았습니다.','working');
 if(phase==='responseLostSaved')return result('응답 유실 · 새 중간 단계 저장 확인','D1에 새 단계가 보존됐습니다. 최종 요약은 아직 아니며 자동 재전송은 없습니다.','warning');
 if(phase==='approved')return result('승인 저장 완료','모델 요청은 아직 전송하지 않았습니다. 실행은 별도 선택입니다.','neutral');
 if(phase==='unknown')return result('접수·결과 확인 중','요청 응답을 받지 못했습니다. 현재 조회만으로 미실행을 확정할 수 없으므로 재전송하지 마세요.','warning');
 if(phase==='approvalUnknown')return result('승인 저장 결과 확인 중','승인 응답을 받지 못했습니다. 모델 요청은 보내지 않았으며 승인 기록을 다시 확인하세요.','warning');
 if(phase==='preflightFailed')return result('실행 전 승인 확인 실패','모델 요청은 보내지 않았습니다. 저장 상태를 다시 확인하세요.','warning');
 if(phase==='statusUnavailable')return result('저장 상태 조회 중 또는 실패','접수 여부를 아직 확인할 수 없습니다. 모델 요청을 자동 전송하지 않습니다.','warning');
 if(phase==='checking')return result('승인 상태 확인 중','모델 요청은 아직 전송하지 않았습니다.','working');
 if(phase==='sending')return result('요청 전송 중','앱 서버 접수 기록은 아직 확인되지 않았습니다.','working');
 if(phase==='finalizing')return result('저장된 단계로 최종 보고서 저장 중','추가 모델 호출 없이 D1 저장 결과를 확인합니다.','working');
 if(phase==='waiting'){
  const seconds=Number.isFinite(waitUntil)?Math.max(0,Math.ceil((waitUntil-now)/1000)):61;
  return result(`이 탭에서 다음 단계 전송까지 ${seconds}초 대기`,'이 시간에는 모델 요청을 보내지 않습니다. 화면을 떠나면 자동 진행을 멈춥니다.','waiting');
 }
 if(reason==='SUMMARY_WINDOW_COMPLETE')return result('이번 승인 창 완료','남은 단계는 별도 범위 검토와 승인 후 실행할 수 있습니다.','waiting');
 if(reason==='SUMMARY_BUNDLE_AVAILABLE')return result('구간별 요약 묶음 준비','전체 종합 요약은 미완료입니다. 구간별 묶음을 별도로 열어 검토할 수 있습니다.','warning');
 if(reason==='SUMMARY_LOCAL_LIMIT')return result('앱 무료 요약 한도 대기','실제 Groq 계정 잔여량은 UNKNOWN입니다. 이력과 사용량을 확인한 뒤 다시 검토하세요.','waiting');
 if(reason==='SUMMARY_PACING_WAIT')return result('요약 요청 간격 대기','마지막 저장 후 61초가 지난 다음 다시 검토하세요.','waiting');
 if(reason==='FOREGROUND_REQUIRED')return result('이 탭의 자동 진행 중단','이미 전송된 요청은 서버에서 계속될 수 있습니다. 저장 상태를 확인하고, 계속하려면 라이브러리에서 이 작업의 Groq Free 요약 승인·실행을 다시 여세요. 자동 재전송은 없습니다.','warning');
 if(approval?.state==='APPROVED'&&approval.expiresAt<=now)return result('요약 승인 만료','저장된 중간 단계는 유지됩니다. 새 범위를 검토한 뒤 별도 승인해야 합니다.','warning');
 if(reason)return result('요약 중단 · '+reason,'원장 상태와 제공자 사용량을 확인하세요. 자동 재전송은 없습니다.','warning');
 if(approval?.state==='STOPPED')return result('요약 승인 중단','이력과 제공자 사용량을 확인하세요. 자동 재승인은 없습니다.','warning');
 const allowed=approval?.state==='APPROVED'&&approval.expiresAt>now&&saved<(approval.windowStart??0)+(approval.maxRequests??0);
 if(Number.isFinite(status?.nextEligibleAt)&&status.nextEligibleAt>now&&saved)return result('저장된 단계 확인 · 요청 간격 대기','61초 간격이 지난 뒤 저장 상태를 다시 확인하세요. 다음 단계는 별도 실행 선택 후 전송됩니다.','waiting');
 if(saved)return result('중간 단계 저장 확인','최종 요약은 아직 저장되지 않았습니다. 다음 단계 실행은 별도 선택입니다.','neutral',allowed);
 if(allowed)return result('승인 저장 확인','현재 조회에서 단계 접수 기록은 확인되지 않았습니다. 실행은 별도 선택입니다.','neutral',true);
 return result('요약 실행 기록 확인 중','현재 조회에서 접수 기록을 확인하지 못했습니다. 승인 범위를 검토하세요.','neutral');
}
