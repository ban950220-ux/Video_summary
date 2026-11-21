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
- GitHub CI 2차: run 358(`6d6dfa5`) **통과**, 최신 run 360(`257b16d`) **통과**. 1단계 완료 기준 충족.

### 남은 이슈
- 기존 v0.7 코드는 SQLite 3.54에서 일부 동작이 달라진다. 운영 D1의 SQLite 버전은 Cloudflare가 관리하므로 영향 여부는 확인하지 않았다. v1으로 대체될 코드라 원인 쿼리까지는 추적하지 않았다. v1 코드는 두 버전 모두에서 테스트한다.
- Node 고정을 풀려면 v0.7 테스트를 정리하거나 v1 전환 후 제거해야 한다.

## 사용자 결정 (2026-11-21, 1단계 후)

- 재시도 정책 권장안 승인: 형식 오류 1회, 네트워크·5xx·429는 대기 후 최대 2회, 시도마다 기록.
- 로컬 Qwen A/B 시험 보류. 요약은 Gemini 무료, PC는 전사(Whisper)에만 사용.
- PR #41은 병합하지 않고 열어 둔 채 참고만 한다.
- **목표 달성에 필요하면 코드 백본·전반 구조 수정을 모두 승인**. 운영 배포와 운영 D1 변경은 기존 원칙대로 따로 승인받는다.

## 2단계 — 자막·전사 확보 (2026-11-21)

### 변경 내용
| 파일 | 내용 |
|---|---|
| `src/v1/youtube.mjs` | URL 해석(watch/youtu.be/shorts/live/embed) → 영상 ID, 정규 URL, 시각 링크 |
| `src/v1/transcript.mjs` | 공통 전사 형식: 출처, 언어, 정렬·번호 매김, 범위(coverage), 프롬프트용 `[#id mm:ss]` 텍스트 |
| `src/v1/captions.mjs` | SRT/VTT/TXT 업로드 (기존 `src/core.mjs` 파서 재사용) |
| `src/v1/retry.mjs` | 승인된 재시도 정책 |
| `src/v1/usage.mjs` | 일일 상한 검사(요청 전에 확인, 메모리 구현. D1 구현은 4단계) |
| `src/v1/legacy-transcripts.mjs` | v0.7 `jobs`+`yta_sources`에서 같은 영상 전사를 **읽기 전용**으로 찾기. 전체 범위 우선, 그다음 최신 |
| `src/v1/providers/http.mjs` | 외부 호출 공통 처리(429·5xx·네트워크 → 재시도 대상, 그 외 4xx → 재시도 안 함) |
| `src/v1/providers/supadata.mjs` | 기존 자막 조회. **항상 `mode=native`**, 202 작업 폴링, 206 = 자막 없음 |
| `src/v1/providers/gemini.mjs` | YouTube URL 15분 구간 전사, 응답 스키마 고정, 저해상도, Flash 계열 모델만 허용, 상대 시각 자동 보정, 경계 중복 제거, 호출별 토큰 기록 |
| `src/v1/acquire.mjs` | 순서: 기존 전사 → Supadata → Gemini. 단계마다 결과·이유 기록. 모두 실패하면 부분 기존 전사, 그것도 없으면 `TRANSCRIPT_UNAVAILABLE` |
| `src/v1/errors.mjs` | 오류 코드 4개 추가(총 16개) |
| `tests/v1/*` | 34개 추가(총 43개). 실제 네트워크 없이 가짜 응답과 실제 SQLite(기존 스키마) 사용 |

### 결정과 이유
- **영상 길이를 모를 때**: Supadata 메타데이터도 1크레딧이고 응답에 길이가 있는지 확인되지 않았다. 그래서 Gemini가 구간마다 `endOfVideo`를 알려 주게 했다. 2시간까지 끝이 안 나면 "일부 전사"로 표시한다.
- **Supadata 206도 1크레딧으로 계산**: 기존 v0.7 기록에 자막이 없어도 크레딧이 차감된다고 되어 있다. 재시도한 호출도 각각 1크레딧으로 보수적으로 계산한다.
- **Gemini 모델 ID는 설정값**(기본 `gemini-2.5-flash`): 무료 등급 제공 모델은 바뀔 수 있다. Flash/Flash-Lite 형식만 허용하고 Pro 등은 `PAID_API_BLOCKED`로 막는다.
- **기존 전사는 읽기만**: 운영 D1 원칙에 따라 v0.7 테이블에는 쓰지 않는다.
- v1 코드는 아직 운영 진입점에 연결하지 않았다(4단계에서 연결).

### 검증 결과
- v1 테스트 43/43 통과 (Node 22, Node 24.22.3)
- 무료 전용 정적 검사 통과: `mode=auto/generate` 없음, Flash 계열 외 Gemini ID 없음, `paidApiAllowed`는 `false` 고정
- `npm run check` 통과(v1 검사 22개 파일, 문제 0)
- 전체 `npm test`(Node 24.22.2): **1008/1008 통과** (기존 965 + v1 43)
- GitHub CI run 362(`ea2a5e0`): **통과**. 2단계 완료 기준 충족.

### 남은 이슈
- **Gemini 구간 지정의 실제 토큰 사용량**: YouTube URL은 구간을 지정해도 음성 토큰이 영상 전체로 잡힌다는 사용자 보고가 있다(Google 포럼). 결제가 없는 키라 비용은 생기지 않지만, 무료 한도(하루 8시간·분당 토큰)가 예상보다 빨리 찰 수 있다. 호출마다 `promptTokens`를 기록하므로 6단계 실측으로 확인하고, 필요하면 구간 길이나 방식을 바꾼다.
- `gemini-2.5-flash`가 현재 무료 등급에서 제공되는지는 실제 호출 전에 확인해야 한다(6단계, 또는 사용자가 AI Studio에서 확인).
- Supadata 응답 형식은 기존 v0.7 코드와 문서 기준이며 실제 호출로는 확인하지 않았다.

## 3단계 — 요약 엔진 (2026-11-21)

### 변경 내용
| 파일 | 내용 |
|---|---|
| `src/v1/summary/schema.mjs` | 출력 스키마(구간 요약 / 최종)와 검증기. 근거 구간 ID 존재 확인, 화자/해석 구분(`SPEAKER`/`INTERPRETATION`), `facts`(값·단위·한정어·구간·원문 인용) 형식 검사, 챕터 오름차순, 개수 제한. 숫자는 있는데 `facts`가 없으면 경고로 기록 |
| `src/v1/summary/chunks.mjs` | 구간 나누기: 약 15분 또는 24,000자 단위, 전사 구간 경계 유지 |
| `src/v1/summary/prompts.mjs` | 요약 규칙(전사문 근거만 사용, 숫자·한정어·지표 보존, 조건·반론 유지, 가정을 사실로 바꾸지 않기 등)과 구간 요약 / 합치기 / 단일 요약 지시문 |
| `src/v1/summary/engine.mjs` | 짧으면 1회 호출, 길면 구간 요약 후 합치기. 호출마다 재시도 정책 적용 후 다음 모델(Gemini → Groq). **챕터 시각은 시작 구간 ID로 코드가 계산** |
| `src/v1/providers/llm.mjs` | JSON 출력 모델 공통 인터페이스. Gemini(Flash 전용, 응답 스키마 고정), Groq(무료 허용 목록 모델만, JSON 모드) |
| `tests/v1/summary*.test.mjs` | 16개 추가(총 59개) |

### 결과 형식 (`v1-summary-1`)
- `conclusion`: 핵심 결론 + 근거 구간 + facts
- `keyPoints`: 핵심 요약 3~12개. 항목마다 화자 진술/AI 해석 구분, 근거 구간, facts
- `chapters`: 시작 구간 ID, 시작·끝 시각(전사에서 계산), 제목, 요약, facts
- `warnings`: 숫자가 있는데 facts가 없는 항목
- `generation`: 방식(single/map-reduce), 구간 수, 호출별 모델·결과·토큰·재시도 기록

### 결정과 이유
- **챕터 시각을 모델에게 맡기지 않음**: 모델이 시각을 지어내거나 틀리게 쓰는 것을 막는다. 모델은 구간 번호만 고르고, 그 번호가 실제로 있는지 검증한다.
- **구간 요약은 자기 구간 번호만 인용 가능**: 다른 부분의 내용을 섞어 쓰는 것(인계 문서의 "앞뒤 구간 합치기")을 형식 단계에서 막는다.
- **숫자 누락은 3단계에서는 경고만**: 실패로 처리하면 재시도가 늘고 무료 할당을 쓴다. 판정은 8단계 숫자 검증에서 한다.
- **Groq 대체**: Gemini가 한도에 걸리거나 두 번 실패하면 Groq 무료 모델로 같은 요청을 보낸다. Groq도 결제 미연결 무료 계정을 전제로 한다.

### 검증 결과
- v1 테스트 59/59 통과 (Node 22, Node 24.22.3)
- 완료 기준 ① 2시간 가짜 전사(1,440구간): 8개 구간 요약 + 합치기 = 9회 호출. 챕터 8개의 시각이 전사 구간과 일치, 마지막 챕터 끝 = 2:00:00
- 완료 기준 ② 형식 오류 1회 → 재시도 성공, 2회 → `PROVIDER_INVALID_OUTPUT` 실패 또는 Groq 대체
- `npm run check` 통과(v1 검사 29개 파일, 문제 0)
- 전체 `npm test`(Node 24.22.2): **1024/1024 통과**. GitHub CI run 365(`6282ccd`, 3단계 포함): **통과**. 3단계 완료 기준 충족.

### 남은 이슈
- 실제 모델 출력 품질(요약 정확도, facts를 빠짐없이 넣는지)은 가짜 모델로는 알 수 없다. 6단계 실제 영상과 8단계 숫자 검증에서 확인한다.
- 2시간 영상의 구간 요약 + 합치기는 Gemini 무료 호출 9회다. 무료 분당 요청 한도에 걸리면 재시도 대기가 생긴다.

## 4단계 — 파이프라인·저장·API (2026-11-21)

### 변경 내용
| 파일 | 내용 |
|---|---|
| `src/v1/db/schema.mjs` | `v1_jobs`, `v1_transcripts`, `v1_summaries`, `v1_usage` (추가만, `CREATE ... IF NOT EXISTS`) |
| `src/v1/db/jobs.mjs` | 작업 저장소: 생성·조회·검색·갱신·삭제, 전사·요약 저장/조회, 같은 영상 작업 재사용 |
| `src/v1/db/usage.mjs` | D1 일일 상한: 키마다 조건부 UPDATE로 동시 실행에도 상한 초과 방지, 일부 실패 시 되돌림 |
| `src/v1/keys.mjs` | 기존 v0.7 암호화 키 금고 → Worker Secret 순으로 키 읽기. 키 값은 응답에 포함하지 않고 등록 여부만 표시 |
| `src/v1/pipeline.mjs` | 작업 단계: acquire → plan → (single 또는 map-1..n → reduce) → save. 단계 결과는 작게 유지하고 본문은 D1에 저장. 플랫폼 자동 재시도는 끔(승인된 정책만 적용) |
| `src/v1/workflow-entry.mjs` | Cloudflare Workflow 클래스 + 기존 사이트 진입점. **6단계 배포 때 wrangler `main`으로 전환 예정** |
| `src/v1/export.mjs` | Markdown/TXT 내보내기(전사 출처·범위·자동 생성 여부, 화자/AI 해석 표시, 챕터 시각 링크) |
| `src/v1/router.mjs` | `POST /api/v1/jobs`, `POST /api/v1/jobs/upload`, `GET /api/v1/jobs`(검색), `GET/DELETE /api/v1/jobs/:id`, `GET /api/v1/jobs/:id/export`, `GET /api/v1/usage`, `GET /api/v1/health` |
| `src/v1/entry.mjs` | v1 진입점: v0.7과 같은 Access·동일 출처 검사 후 `/api/v1/*` 처리, 나머지는 v0.7 처리기로 전달. **v0.7 `src/site-worker.mjs`는 변경 없음** |
| `src/v1/summary/engine.mjs` | 단계별 실행이 가능하도록 함수 분리(동작은 같음) |
| `tests/v1/pipeline.test.mjs` | 7개 추가(총 66개) |

### 결정과 이유
- **v1 테이블을 `migrations/`에 넣지 않음**: 기존 테스트와 배포 가드가 v0.7 마이그레이션 목록을 고정해 검사한다. 코드에서 추가 전용으로 생성하며, 운영 D1 적용은 6단계 배포 승인 때 함께 한다.
- **`wrangler.toml` 변경은 6단계로 미룸**: Workflow 바인딩과 `main` 전환은 운영 설정 변경이고, 배포 가드 테스트가 이 파일을 검사한다. 바인딩이 없으면 요청 처리 후 백그라운드(`waitUntil`)로 실행되므로 짧은 영상은 바로 쓸 수 있다.
- **구간 요약마다 별도 단계**: 중간에 실패해도 끝난 단계는 다시 하지 않아 무료 할당을 아낀다.
- **같은 영상은 기존 작업 재사용**: 다시 만들려면 `force: true`.
- **제목은 YouTube oEmbed**(무료, 키 불필요)에서 가져오고, 실패해도 작업은 계속한다.

### 검증 결과
- v1 테스트 66/66 통과 (Node 22, Node 24.22.3)
- 완료 기준 ① URL 제출 → 자막 → 요약 저장 → 재조회·검색·내보내기·삭제 전 과정 통과
- 완료 기준 ② 2시간 영상 map-3에서 실패 → 재실행 시 acquire·plan·map-1·map-2를 건너뛰고 map-3부터 완료(자막 추가 호출 0, Gemini 7회)
- 완료 기준 ③ 기존 v0.7 테이블 정의 변경 없음(실제 SQLite에서 전후 비교), v1 테이블 4개만 추가
- `/api/v1/*`는 Access 인증 없이 401, 다른 출처 쓰기는 거부
- `npm run check` 통과(v1 검사 37개 파일)
- 전체 `npm test` 1차: 1029개 중 1개 실패(`tests/durable-sqlite.test.mjs`)
  - 원인: v0.7 단일 파일 번들러(`scripts/build-dashboard.mjs`)는 고정 모듈 목록만 묶는다. `site-worker.mjs`에 v1 import를 넣자 번들(`dist/dashboard-worker.mjs`)이 깨졌다.
  - 조치: `site-worker.mjs`를 원래대로 되돌리고, v1은 별도 진입점 `src/v1/entry.mjs`로 분리했다. v0.7 운영 코드와 번들이 그대로 유지된다.
  - 재검증: 해당 테스트 + v1 69개 통과. 전체·CI는 아래 기록

### 남은 이슈
- **Workers 무료 플랜 CPU 한도**: 요청당 CPU 10ms가 한도다. 긴 전사(수천 구간)의 JSON 처리가 한도에 걸릴 수 있다. 6단계 실측으로 확인하고, 필요하면 구간 분할 저장으로 바꾼다.
- **일일 상한 기준**: UTC 날짜다. 제공자 한도의 초기화 시각과 다를 수 있다.
- 실제 Workflow 동작(재개 포함)은 Node 가짜 단계로만 시험했다. 실제 Cloudflare에서는 6단계에서 확인한다.
