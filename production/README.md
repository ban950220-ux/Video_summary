# 운영 코드 백업: dede9fb3

`holy-rice-b914`에서 2026-11-09부터 운영 중인 버전(`dede9fb3-38d2-49b8-ad67-32b4ed51937a`)의 배포 산출물이다. 사용자가 2026-11-21 제공한 `video-summary-release-candidate-v1.zip`에서 가져왔다.

- 이 코드의 원본 소스는 GitHub의 어느 브랜치에도 없다(Codex 로컬 작업에서 빌드·배포됨). 수동 요약 보관(`yta_manual_summary_*`), 텍스트 검토 읽기(`/api/text-review-summaries`), 루트 PWA 설치 파일이 여기에만 있다.
- `runtime/primary.mjs`: 단일 번들 Worker(`handleSiteRequest` 내보냄). `assets/`: 정적 파일.
- 모든 파일은 `DEPLOYMENT-REVIEW.json`의 SHA-256·크기와 일치한다(`tests/v1/deploy-config.test.mjs`가 매번 확인).
- 제외: `.wrangler/cache/cf.json`(배포 위치 정보, 운영에 불필요).
- **수정 금지.** v1은 `src/v1/entry.mjs`에서 이 처리기를 그대로 감싸 `/v1/`, `/api/v1/*`만 추가한다.
- 되돌리기 기준: 이 버전 `dede9fb3`, 그 이전 `cafa3ca3`(`PRODUCTION-RECEIPT.json`).
