# 구조

## v1 (개발 중)

자세한 설계는 `docs/v1/DESIGN.md`에 있다.

```
브라우저/PWA ──► Worker holy-rice-b914 (Access JWT 검증, 정적 화면 + /api/v1/*)
                     │
                     ▼
              Cloudflare Workflow (작업 단계별 저장·재시도)
                1 메타데이터 → 2 자막/전사 확보 → 3 정규화·구간 나누기
                → 4 구간 요약 → 5 핵심 요약 + 챕터 → 6 검증·저장
                     │
                     ▼
              D1: v1_jobs, v1_transcripts, v1_summaries, v1_usage
```

자막/전사 확보는 아래 순서로 시도한다.
1. Supadata `mode=native`
2. Gemini YouTube URL 구간 전사
3. PC 실행기(yt-dlp → Groq Whisper)
4. 사용자 업로드

| 경로 | 역할 | 상태 |
|---|---|---|
| `src/v1/config.mjs` | 설정, 무료 전용 강제, 일일 상한 | 1단계 |
| `src/v1/errors.mjs` | 오류 코드·메시지 | 1단계 |
| `src/v1/http.mjs` | JSON 응답, 요청 본문 제한, 동일 출처 검사 | 1단계 |
| `src/v1/router.mjs` | `/api/v1/*` 라우터 (아직 운영 진입점에 연결 안 됨) | 1단계 |
| `scripts/v1-lint.mjs` | 구문·파일 길이·줄 길이 검사 | 1단계 |
| `src/v1/youtube.mjs`, `transcript.mjs`, `captions.mjs` | URL 해석, 공통 전사 형식, 업로드 파서 | 2단계 |
| `src/v1/retry.mjs`, `usage.mjs` | 재시도 정책, 일일 상한 | 2단계 |
| `src/v1/legacy-transcripts.mjs` | v0.7 전사 읽기 전용 재사용 | 2단계 |
| `src/v1/providers/*.mjs` | Supadata(native 전용), Gemini(구간 전사, Flash 전용) | 2단계 |
| `src/v1/acquire.mjs` | 전사 확보 순서 실행·기록 | 2단계 |
| `src/v1/summary/*.mjs` | 구간 나누기, 지시문, 출력 스키마·검증, 요약 엔진 | 3단계 |
| `src/v1/providers/llm.mjs` | Gemini·Groq JSON 출력 모델 | 3단계 |

## 기존 v0.7 (운영 중, 유지)

- 진입점: `src/site-worker.mjs`. Access 검증 후 `/api/*`는 `src/worker.mjs`·`src/live.mjs`로 보내고, 정적 화면은 `web/site/`에서 제공한다.
- 재사용 예정: `src/access.mjs`, `src/vault.mjs`, `src/core.mjs`, `src/audio.mjs`, `scripts/local-*`
- 이전 검토 문서: `docs/legacy/`
- v1이 운영에서 확인되기 전에는 삭제하지 않는다.
