# AI 인수인계

마지막 갱신: 2026-11-26

## 지금 상태

- v0.7(Codex로 개발)이 운영 Worker `holy-rice-b914`에 있다.
  - 예시 영상 2hUkTmwYm3A는 전사가 끝났지만 요약이 형식 오류(`FAILED_UNCERTAIN`)로 멈춰 있다.
- 사용자 승인에 따라 **v1 재구성**을 진행 중이다.
  - 설계: `docs/v1/DESIGN.md`
  - 숫자 검증 설계: `docs/v1/NUMERIC_VERIFICATION_DESIGN.md`
- 현재 단계는 `docs/v1/PROGRESS.md`의 마지막 항목을 본다.

## Cloudflare Workers Free 한도 (2026-11-26)

- 계정은 Workers Free다. 요청 1건과 Workflow 단계 1개마다 CPU 10ms 한도가 있다.
- 대응 경과와 측정값은 `docs/v1/PROGRESS.md`의 "Workers Free 한도 대응" 절, 설계는 `docs/v1/FREE_PLAN_CPU_DESIGN.md`.
- 측정 방법: 수동 워크플로 "Deploy v1 (manual)"의 `measure` 모드(읽기 전용, `hours`와 `bucket` 입력).
- 지킬 것:
  - 결과 조회는 D1 조회 1번(`jobs.loadDetail`)으로 읽는다.
  - 숫자 검증은 저장된 `v1_checks`를 쓴다(요약 저장 뒤 `checks` 단계에서 계산).
  - 요청 처리 중에 전사 전체를 파싱하지 않는다.
  - 경로를 새로 만들 때 D1 호출 수(1번 ≈ CPU 1ms)를 줄인다.
- 사용자 결정: 새 인스턴스 첫 요청의 가끔 생기는 초과(10~12ms)는 수용한다. 끊긴 요청(`exceededResources`)이 생기면 다음 대안을 검토한다.
- 남은 일: 사용자가 다음에 요약을 돌리면 그 시각의 `measure` 값으로 Workflow CPU를 수정 전(합계 116.7ms, 단계 평균 9.7ms)과 비교한다.

## Gemini 비용 (2026-11-21 결정)

- 키는 유료 등급(Tier 1)이다. 사용자가 유지를 결정했고, 앱에 월 3,000원 상한을 두었다(`docs/v1/PROGRESS.md` "월 예산" 절). AI의 검증용 Gemini 호출도 이 예산 안에서 최소한으로 한다.

## 사용자 확정 사항 (2026-11-21)

- 새 구조로 재구성하되 좋은 기존 코드는 재사용한다.
- Gemini YouTube URL 입력과 PC 실행기를 둘 다 사용한다.
- 무료 유지. Gemini 키는 결제가 연결되지 않은 프로젝트의 키다. Google 무료 등급 데이터 정책에 동의했다.
- 운영 Worker·D1은 기존 것을 그대로 쓴다.
- 요약 순서: 1차 핵심 요약 + 챕터 → 2차 분석. 3단계부터 요약에 `facts`를 포함한다.
- 기존 v0.7 보고서는 새 화면의 "이전 보고서" 탭에서 읽기 전용으로 보여 준다.
- 재시도: 형식 오류 1회, 네트워크·5xx·429는 최대 2회(무료 제공자만, 시도마다 기록).
- 로컬 Qwen 시험은 보류한다. PR #41은 열어 둔 채 참고만 한다.
- 목표 달성에 필요하면 코드 백본·전반 구조 수정을 승인받았다. 운영 배포와 운영 D1 변경은 매번 따로 승인받는다.

## 중단 지점 (2026-11-21, 사용자 요청으로 백업 후 일시 중단)

- 완료: 0~5단계 (모두 CI 통과).
- 1~9단계와 후속 개선(교차 확인, 검토·교정, 첫 화면 간결화·공유 받기, 연계용 JSON·읽기 토큰)까지 운영 배포·검증 완료(2026-11-21). 상세는 `docs/v1/PROGRESS.md`.
- 남은 것: BANSIGHT 쪽 연계 구현(`docs/v1/EXPORT_API.md`, 읽기 토큰 설정 필요), 분석의 불확실성 항목 누락 여부 확인, 교차 확인의 실행 간 편차.
- AI 실검증 방법: Access 서비스 토큰(`/api/v1/*`만 허용). Secret은 세션 환경 자격증명(프록시가 `CF-Access-Client-Secret` 주입). Client ID는 저장소에 넣지 않는다(사용자에게 받음).
- 사용자에게 요청 대기 중인 항목: `docs/v1/HANDOFF_REVIEW.md` 4장.

## 작업 브랜치

- `claude/serene-cori-0jdusg`
- `main`에 병합하거나 배포하려면 사용자 승인이 필요하다.
