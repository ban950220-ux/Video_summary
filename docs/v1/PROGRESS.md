# v1 진행 기록

단계마다 변경 내용, 결정 사항과 이유, 검증 결과, 남은 이슈를 기록한다.

## 0단계 — 설계 (2026-11-21)

- 변경: `docs/v1/DESIGN.md` 초안 작성. 코드 변경 없음.
- 결정: 사용자 답변 반영(재구성 B, Gemini URL + PC 실행기 유지, 무료 유지, 기존 Worker/D1 유지, 핵심 요약·챕터 우선).
- 검증 기준선: 기존 `npm run check` 통과, `npm test` 965/965 통과 (Node 22, 2026-11-17 실행).
- 업로드 패키지 `video-summary-fixture-readback`: 테스트 55/55, 판정 30/30 확인. 문장 틀이 좁아 실제 요약에는 대부분 판정 불가 → 저장소에는 넣지 않고 8단계에서 구조화 출력 기반으로 재설계.
- 사용자 답변(2026-11-21): 업로드 패키지는 "필요하면 넣고 아니면 안 해도 됨", 숫자 검증 재설계 요청.
  - 결정: 패키지는 저장소에 넣지 않음. 형식이 다른 새 검증기로 대체되므로 필요 없음. 예시 30쌍의 의미만 새 회귀 테스트로 옮김.
  - `docs/v1/NUMERIC_VERIFICATION_DESIGN.md` 초안 작성. 3단계 요약 스키마에 `facts`를 미리 넣는 안을 권장.
- 남은 이슈: 설계 문서 7장 항목과 숫자 검증 설계에 대한 사용자 확인.
- 상태: **승인됨** (2026-11-21, 설계·숫자 검증 설계·facts 선포함·이전 보고서 탭·Gemini 무료 데이터 정책·무결제 키 모두 확인)

## 1단계 — 기반 구성 (2026-11-21)

### 변경 내용
- map-bot 방식 문서 추가: `AGENTS.md`(공통 규칙), `CLAUDE.md`(진입점), `AI_HANDOFF.md`, `TASKS.md`, `ARCHITECTURE.md`.
- 기존 `docs/*.md|json` 42개를 `docs/legacy/`로 이동(내용 변경 없음). README·IMPLEMENTATION 링크 수정, README·START_HERE 맨 위에 v1 안내 추가.
- v1 골격 `src/v1/`:
  - `config.mjs`: 유료 API 항상 차단, 일일 상한은 낮추기만 가능
  - `errors.mjs`: 오류 코드 12개
  - `http.mjs`: JSON 응답, 본문 크기 제한, 동일 출처 검사
  - `router.mjs`: `/api/v1/health`
- `scripts/v1-lint.mjs`: 구문 검사, 파일 400줄 이하, 줄 120자 이하.
- `tests/v1/foundation.test.mjs`: 9개.
- `package.json`: `test`에 `tests/v1` 포함, `test:v1`·`lint:v1` 추가, `check`에 `lint:v1` 연결.
- CI: 제한 시간 5분 → 15분(기존 실행이 약 4분이라 여유 부족), `test:v1` 단계 추가. `.node-version`=24.

### 결정과 이유
- v1 라우터는 아직 `src/site-worker.mjs`에 연결하지 않았다. 배포되더라도 운영 동작이 바뀌지 않게 하려는 것이다. 4단계에서 연결한다.
- 수동 배포 워크플로(`deploy.yml`)는 6단계로 미뤘다. Cloudflare 토큰 Secret과 배포 승인이 필요한 일이기 때문이다.
- 숫자 검증 원본 패키지는 넣지 않았다(0단계 결정 유지).

### 검증 결과
- `npm run check`: 통과 (v1 lint 6개 파일, 문제 0)
- `npm test`: **974/974 통과** (기존 965 + 신규 9), 로컬 Node 22
- `npm run release:gate`: 종료 코드 2(배포 차단 유지, 기존과 같음)
- GitHub CI 1차(run 357, `59d5018`): **실패**. 기존 v0.7 테스트 21개(`tests/groq-summary.test.mjs`)가 실패했고 v1 테스트는 통과했다.
  - 원인: GitHub 실행기의 Node가 run 356의 24.22.2에서 24.22.3으로 바뀌었다. 24.22.3은 내장 SQLite가 3.53.4 → 3.54.1로 올라갔고, 그 결과 기존 v0.7 코드의 일부 쿼리 결과가 달라졌다.
  - 확인: 변경하지 않은 `main`도 Node 24.22.3에서 같은 테스트가 실패한다. 이번 변경 때문이 아니다.
  - 조치: `.node-version`=24.22.2로 고정하고 CI가 이 파일을 읽게 했다(`node-version-file`).
  - 재검증: Node 24.22.2 로컬 `npm test` **974/974 통과**. v1 테스트는 Node 24.22.3에서도 9/9 통과.
- GitHub CI 2차: 푸시 후 확인 (아래 기록)

### 남은 이슈
- 기존 v0.7 코드는 SQLite 3.54에서 일부 동작이 달라진다. 운영 D1의 SQLite 버전은 Cloudflare가 관리하므로 영향 여부는 확인하지 않았다. v1으로 대체될 코드라 원인 쿼리까지는 추적하지 않았다. v1 코드는 두 버전 모두에서 테스트한다.
- Node 고정을 풀려면 v0.7 테스트를 정리하거나 v1 전환 후 제거해야 한다.
