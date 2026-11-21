# v1 배포 절차서 (6단계)

- 대상: 기존 Worker `holy-rice-b914`, 기존 D1 `youtube-ai-analyzer-private-db`
- 상태: **운영 코드(dede9fb3) 위에 v1을 통합한 배포 준비 완료 (2026-11-21).** 배포는 사용자 승인 후. 이 클라우드 세션은 Cloudflare 계정에 접근하지 않는다.
- 기준: 운영 중인 코드 `production/dede9fb3/`(GitHub 원본 없음, 사용자 제공 ZIP, 해시 검증). GitHub의 옛 v0.7 소스(`src/site-worker.mjs`)는 배포에 쓰지 않는다.

## 1. 바뀌는 것과 그대로인 것

| 항목 | 배포 후 |
|---|---|
| 운영 화면(`/`)과 API(`/api/*`, 수동 요약 보관·텍스트 검토 포함) | **그대로** (운영 코드 `dede9fb3`를 v1 진입점이 그대로 넘겨줌) |
| 새 v1 화면 | `/v1/` 추가 |
| 새 v1 API | `/api/v1/*` 추가 (Access 인증·동일 출처 검사 동일) |
| Worker 진입점 | `runtime/primary.mjs` → `src/v1/workflow-entry.mjs`(내부에서 운영 코드 호출) |
| 정적 파일 | 운영 `assets/` 그대로 + `/v1/` 추가 (`dist/v1-assets`) |
| Workflow | `video-summary-v1` 새로 생성 (무료 플랜 범위) |
| D1 | v0.7 테이블 그대로. **v1 첫 요청 때 `v1_` 테이블 4개가 추가로 생성됨** |
| 변수·Secret·Access | 그대로 (`keep_vars`, 기존 변수는 설정 파일에 쓰지 않음). 새 변수 `V1_LIVE_PROVIDERS=true`만 추가 |

## 2. 배포 전 확인

- [x] 운영 버전 `dede9fb3`(2026-11-09) 확인, 운영 코드 확보·해시 검증
- [x] D1 테이블 목록 확인(수동 요약 보관 테이블 존재 → 운영 코드 위에 통합해 해결)
- [x] API 키 등록(사용자 보고), GitHub Secrets 등록(사용자 보고)
- [ ] 배포 워크플로를 main에 추가(아래 3장 참고)
- [ ] `check` 모드 실행으로 토큰·D1 접근 확인
- D1 백업: D1은 **Time Travel**로 최근 7일(무료 플랜) 안의 시점으로 되돌릴 수 있다. 배포 워크플로가 배포 직전 복원 지점(bookmark)을 기록한다. 대시보드에는 내보내기 버튼이 없고, 전체 내보내기는 PC에서 `npx wrangler d1 export youtube-ai-analyzer-private-db --remote --output=backup.sql`로 한다(GitHub에 올리지 않는다).

## 3. 배포 방법: GitHub Actions

1. **워크플로를 main에 추가해야 한다.** GitHub는 기본 브랜치(main)에 있는 워크플로만 Actions 화면에 "Run workflow" 버튼으로 보여 준다. `.github/workflows/deploy-v1.yml` 한 파일만 main에 넣는 PR을 만들어 병합한다.
2. Actions → **Deploy v1 (manual)** → Run workflow
   - Use workflow from: `claude/serene-cori-0jdusg`
   - mode: **check** 먼저 실행 → 토큰 확인(`wrangler whoami`), D1 복원 지점, 배포 리허설만 하고 배포하지 않는다.
   - 확인 후 mode: **deploy**, confirm: `holy-rice-b914`
3. 실행 요약에 D1 복원 지점과 새 버전 ID가 남는다.

## 4. 배포 직후 확인

| 순서 | 확인 | 기대 결과 |
|---|---|---|
| 1 | 기존 화면 `/` 열기, 이전 보고서·수동 요약 보관·텍스트 검토 열기 | 배포 전과 동일 |
| 2 | `/api/v1/health` | `paidApiAllowed: false`, `durableJobs: true` |
| 3 | `/v1/` → 설정 탭 | 키 등록됨, 유료 차단됨 |
| 4 | https://youtu.be/gadedKEuLaQ (자막 있음) | 전사 출처 "YouTube 기존 자막", 결론·챕터 생성 |
| 5 | https://youtu.be/vujhk4dNlGA (자동 생성 자막) | 기존 자막으로 처리되거나, 없으면 "Gemini 영상 전사". 어느 경로였는지 기록 |
| 6 | 2hUkTmwYm3A | 전사 출처 "기존 저장 전사(v0.7)", 새 전사 호출 없음 |
| 7 | 각 결과 다시 열기, Markdown 내보내기, 라이브러리 검색 | 저장·재조회 일치 |
| 8 | Android Chrome에서 `/v1/` → 홈 화면에 추가 | 아이콘, 주소창 없는 실행, 로그인 유지 |

이 검증에서 Gemini 호출별 `promptTokens`(결과의 `generation.calls`)를 기록해 구간 지정 시 토큰 사용량(남은 이슈)을 확인한다.

## 5. 되돌리기

- Cloudflare 대시보드 → Deployments → `dede9fb3` → **Rollback**, 또는 `npx wrangler rollback dede9fb3-38d2-49b8-ad67-32b4ed51937a`
- D1을 되돌려야 하면 실행 요약의 복원 지점으로 `npx wrangler d1 time-travel restore youtube-ai-analyzer-private-db --bookmark=<값>`
- v0.7 데이터는 변경되지 않으므로 코드만 되돌리면 된다. 추가된 `v1_` 테이블은 남아도 v0.7에 영향이 없다.
