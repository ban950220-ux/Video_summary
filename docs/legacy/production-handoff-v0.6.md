# YouTube AI Analyzer — Cloudflare Work mode 배포 핸드오프 v0.6

2026-10-10. 실제 계정 Cloudflare/Supadata/Gemini/Groq 무료 API 키 발급은 사용자 완료. 키 원문은 ChatGPT 채팅에 노출하지 않는다. **실제 Cloudflare 계정 접속·배포·D1 원격 테스트·API 호출은 아직 하지 않음.**

## Work 실행 업무 및 권한

- ChatGPT **Work 모드**를 직접 선택하고 클라우드 브라우저로 Cloudflare 대시보드에 로그인한다(사용자 직접 인증, 2FA 지원). 이 일반 채팅은 Work 모드로 전환하거나 Cloudflare UI를 대신 조작할 수 없다.
- 해당 프로젝트에만 작업. BANSIGHT, MAP, PORTFLOW, 뉴스봇, 기존 Worker 및 D1을 수정/삭제하지 말 것. 새 리소스 `youtube-ai-analyzer-private` 생성만 허용.
- 유료 요금제, 신용카드 등록, 월·연 구독, 공개 배포, 다른 사람 초대는 승인 없이 실행하지 않는다. 클라우드에서는 Owner-only Access 보호 후에만 실제 접속을 연다. 테스트 URL 접근은 보호된 상태여야 한다.

## 순서

1. 무료 Cloudflare 계정의 Zero Trust가 설정됐는지 확인한다. **개별 Worker 보호** 또는 개별 호스트 보호를 사용할 수 있는지 공식 UI에서 확인한다. 전체 계정 Worker 보호 정책 변경은 기존 사이트에 영향 줄 수 있으므로 하지 않는다.
2. 새 D1 `youtube-ai-analyzer-private` 생성, 새 데이터베이스 UUID를 `wrangler.toml`에 설정, `schema.sql`만 원격 적용. D1 무료 한도와 계정 과금 설정을 사용자와 확인.
3. 새 Worker를 `src/site-worker.mjs`, `web/site/` 자산으로 배포하되 Access Owner-only를 최우선 설정. 배포 직후 공개 URL이 생기더라도 **서버 자체 JWT Fail Closed**가 먼저 적용되고 실제 권한/키 설정 전 503/401을 반환하도록 유지. 기존 `workers_dev=false` 구성은 라우트가 없어 UI 접속 불가능; `workers.dev`를 사용한다면 그 호스트 또는 해당 Worker에 Access 보호를 적용하고 안전하게 `workers_dev=true` 전환. 다른 Worker 영향 금지.
4. 개별 Access 정책에서 본인 이메일 한 명만 허용. Team domain, application AUD를 확인하여 `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_OWNER_EMAIL`에 안전하게 등록. 이메일은 Worker Secret으로 넣는 편이 좋다. Access JWT 서명/issuer/audience/email 검증을 직접 테스트한다.
5. `KEY_ENCRYPTION_KEY_B64`: 브라우저/채팅에서 생성하지 말고 Cloudflare Secret 관리 화면에서 32-byte random을 Base64로 변환해 넣는다. 배포 코드/환경변수 일반값에는 넣지 않는다. 복구 불가능성/키 회전 정책 기록. `wrangler secret put`은 곧바로 배포를 수행하므로 원치 않으면 dashboard 또는 `versions secret put` 순서를 확인한다.
6. DB 테이블에 실제 이력 SRT 1건을 생성→검색→재열람→삭제하고 Access 인증 전/비소유 이메일/CSRF 공격을 차단하는지 점검한다. 사이트 API 보안 설정에서 Supadata/Gemini/Groq 키 각각 등록 후 서버에 **암호문만** 저장·GET은 등록 여부만 반환하는지 확인. 비밀 값은 Worker 로그/브라우저 저장소/응답에 표시하지 않는다.
7. Live provider 검증은 별도 단계: 무료 API key 계정이 정말 **요금 청구 불가능한 무료 티어**인지 각 콘솔에서 실측/확인하고, 잔여 quota와 429/402 시 차단 테스트 후 `ENABLE_LIVE_FREE`로 제한된 단계별 단일 호출만 허용. 현재 `src/provider-keys.mjs`는 서버 내부 브릿지만 있고 사이트 라우터·quota reservation 연결이 아직 없다. **절대 기능 구현 전 Live를 켜지 말 것.**
8. Supadata `mode=native` 1건 → 기존 자막 / 206 시 1크레딧 기록 → Gemini 한국어 요약 1건 → 사용자 제공 짧은 음성으로 Groq 1건 → 각 사용량 계측을 검증하고 120분 청크 분할은 별도 추가한다. `FULL_TRANSCRIPT_VERIFIED`는 타임스탬프만으로 부여하지 않는다.

## 계정 작업 완료 정의

- 보호되지 않은 요청은 페이지 자산과 API 모두 읽지 못한다.
- 로그인 성공 후 라이브러리 D1 쓰기/검색/재열람/삭제 1회씩 실증.
- 암호화 API 키 저장/교체/삭제, 앱과 Cloudflare 로그에 원문 유출 없음.
- DB·worker 바인딩·Access 및 앱 내부 보호가 함께 적용됨.
- 별도 라이브 AI API 테스트 미완료면 **사이트 DEPLOYED / AI NOT_LIVE**라고 보고하고 과대평가하지 않음.

## 실행 전 테스트

`npm run check && npm test` → v0.6 로컬 테스트 38/38 PASS.
`npm run release:gate` → 계정 설정 없는 소스의 경우 `BLOCKED_DEPLOY`, 예상 결과.

## 참고 문서

- https://developers.cloudflare.com/workers/configuration/cloudflare-access/ (2026-08-18 신규 Worker-level 보호)
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/d1/get-started/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/
