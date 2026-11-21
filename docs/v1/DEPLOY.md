# v1 배포 절차서 (6단계)

- 대상: 기존 Worker `holy-rice-b914`, 기존 D1 `youtube-ai-analyzer-private-db`
- 상태: **준비 완료. 배포는 사용자 승인 후에만 진행한다.** 이 클라우드 세션은 Cloudflare 계정에 접근하지 않는다.

## 1. 바뀌는 것과 그대로인 것

| 항목 | 배포 후 |
|---|---|
| 기존 v0.7 화면(`/`)과 API(`/api/*`) | **그대로** (같은 코드를 v1 진입점이 그대로 넘겨줌) |
| 새 v1 화면 | `/v1/` 추가 |
| 새 v1 API | `/api/v1/*` 추가 (Access 인증·동일 출처 검사 동일) |
| Worker 진입점 | `src/site-worker.mjs` → `src/v1/workflow-entry.mjs` |
| 정적 파일 | `web/site` → `dist/v1-assets` (v0.7 파일 + `/v1/`) |
| Workflow | `video-summary-v1` 새로 생성 (무료 플랜 범위) |
| D1 | v0.7 테이블 그대로. **v1 첫 요청 때 `v1_` 테이블 4개가 추가로 생성됨** |
| 변수·Secret·Access | 그대로 (`keep_vars = true`) |

## 2. 배포 전 확인 (사용자)

1. Cloudflare 대시보드 → `holy-rice-b914` → Deployments: **현재 버전 ID·배포 시각을 기록**한다(되돌리기용).
2. D1 콘솔에서 테이블 목록 확인: `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`
   - `0021` 수동 요약 테이블이 있으면 알려 주세요. PR #41 계열이 운영 중이라는 뜻이며, 이 경우 v1 배포가 그 화면을 덮어쓸 수 있어 배포 전에 다시 검토한다.
3. 사이트 "API 보안 설정"에 Supadata·Gemini(무결제 프로젝트) 키가 등록되어 있는지 확인한다.
4. (권장) D1 백업: `npx wrangler d1 export youtube-ai-analyzer-private-db --remote --output=backup-YYYYMMDD.sql`
   - 이 파일은 PC(예: `D:\ClaudeWork`)에만 보관하고 GitHub에 올리지 않는다.

## 3. 배포 방법 (하나 선택)

### A. 사용자 PC에서 직접 (권장: 처음 한 번)
```bash
git fetch origin claude/serene-cori-0jdusg
git checkout claude/serene-cori-0jdusg
npm ci
npm run check
npm run test:v1
node scripts/v1-build-assets.mjs
npx wrangler deploy -c wrangler.v1.toml
```
`npx wrangler login`이 필요할 수 있다.

### B. GitHub Actions 수동 배포
- 저장소 Settings → Secrets → `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` 등록
- Actions → "Deploy v1 (manual)" → Run workflow → `holy-rice-b914` 입력

## 4. 배포 직후 확인

| 순서 | 확인 | 기대 결과 |
|---|---|---|
| 1 | 기존 화면 `/` 열기, 이전 보고서 하나 열기 | v0.7과 동일하게 동작 |
| 2 | `/api/v1/health` | `paidApiAllowed: false`, `durableJobs: true` |
| 3 | `/v1/` → 설정 탭 | 키 등록됨, 유료 차단됨 |
| 4 | 자막 있는 짧은 공개 영상 | 전사 출처 "YouTube 기존 자막", 결론·챕터 생성 |
| 5 | 자막 없는 공개 영상 | 전사 출처 "Gemini 영상 전사", 범위 표시 |
| 6 | 2hUkTmwYm3A | 전사 출처 "기존 저장 전사(v0.7)", 새 전사 호출 없음 |
| 7 | 각 결과 다시 열기, Markdown 내보내기, 라이브러리 검색 | 저장·재조회 일치 |
| 8 | Android Chrome에서 `/v1/` → 홈 화면에 추가 | 아이콘, 주소창 없는 실행, 로그인 유지 |

이 검증에서 Gemini 호출별 `promptTokens`(결과의 `generation.calls`)를 기록해 구간 지정 시 토큰 사용량(남은 이슈)을 확인한다.

## 5. 되돌리기

- Cloudflare 대시보드 → Deployments → 2-1에서 기록한 이전 버전 → **Rollback**, 또는 `npx wrangler rollback <이전 버전 ID>`
- v0.7 데이터는 변경되지 않으므로 코드만 되돌리면 된다. 추가된 `v1_` 테이블은 남아도 v0.7에 영향이 없다.
