# YouTube AI Analyzer — Work/Cloudflare 배포 핸드오프 v0.5

> 날짜 2026-10-10. **배포·실 API 요청·Cloudflare 원격 D1 쓰기 미실행**. 현재 산출물은 배포 준비 코드 및 테스트 증거이지 운영 서비스가 아닙니다.

## 완료한 코드 범위

- `web/site/`: 모바일/PC 반응형 UI. 화면: 새 영상 분석, 분석 라이브러리(검색/재열람/삭제), 리소스, API 암호화 등록·교체·삭제.
- `src/site-worker.mjs`: 앱 정적 자산과 API를 모두 Cloudflare Access JWT 검증 뒤에 제공. 토큰이 없는 요청은 거부. CSP/HSTS, `Origin` 비교 및 JSON Content-Type 검사로 CSRF 방어.
- `src/access.mjs`: Access 조직 JWKS의 RS256 서명, 발급처(issuer), audience, 만료, 발급 시간, 본인 이메일 확인. 인증 미설정 시 503.
- `src/worker.mjs`: 원문 미보관 D1 요약 이력, 제공자별 비밀키 AES-GCM 암호화 보관(마스터 키는 Worker Secret), 무료 한도 조회 시 공급자 잔여량 UNKNOWN, 기본 유료 예산 0.
- `web/demo.html`: 완전 독립형 오프라인 데모. 이 파일은 클라우드 영구 저장을 하지 않음.

## Cloudflare 무료 계정 준비

1. Cloudflare에 무료 계정을 만들고 별도 신규 프로젝트 공간을 사용. 기존 MAP/BANSIGHT/PORTFLOW/뉴스봇 리소스 변경 금지.
2. Cloudflare Workers + D1 이용 가능 여부와 무료 한도를 확인. 별도 개인 접근용 호스트명 확보(소유 도메인 또는 실제 Access 보호가 가능한 Workers endpoint). 본인만 접근하도록 **Cloudflare Zero Trust → Access → Applications** 에서 보호할 호스트명 등록, allow 정책은 본인 이메일 한 개만 지정. 확인 전에 호스트를 외부 공개하지 않는다.
3. Access 화면에서 Team Domain (예: `https://myteam.cloudflareaccess.com`) 및 Application Audience(AUD) tag 확인.
4. Worker 환경변수 `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` / `ACCESS_OWNER_EMAIL` 설정. 아무 것도 설정되지 않았다면 HTTP 503 반환(안전하게 차단).
5. D1 데이터베이스 `youtube-ai-analyzer-private`를 **새로 생성**하고, 실제 생성 ID를 `wrangler.toml`의 `[[d1_databases]]` binding `DB`에 설정. `schema.sql` DDL 적용. 테스트 계정/권한으로 저장-재조회-삭제 확인.
6. `KEY_ENCRYPTION_KEY_B64`는 난수 32바이트를 Base64로 인코딩해 Cloudflare Worker **Secret**으로만 입력. 예: 신뢰할 수 있는 터미널의 `openssl rand -base64 32` 결과를 앱 코드나 채팅이 아닌 Cloudflare Secret에 입력. 유출 또는 분실 시 기존 암호화 API 키 복구 불가/교체 필요. 백업·회전 정책 마련.
7. 정적 자산은 `web/site` 폴더, Worker entry `src/site-worker.mjs`, `[assets] binding=ASSETS, run_worker_first=true` 확인. `workers_dev=false`인 상태에서는 별도의 실제 라우트/호스트 설정 필요. **검증되지 않은 우회 workers.dev URL 노출 금지**.
8. 실제 배포 이후 `SITE_DEPLOYED=true`로 확인된 Worker 환경만 건강 상태에서 배포 표시하며, 이 값은 서비스 기능 PASS 판정과 별개입니다. 별도 Work 모드/사용자 관리 Cloudflare 계정에서 deploy 수행. 배포 직전 현재 Access 정책 검증 및 유료 서비스 연동 OFF 확인. 공개 배포는 사용자 확인 후 수행.
9. 사이트 접근 후 사이트 `설정 > API 보안 설정` 에서 Supadata/Gemini/Groq 무료 키 등록. 브라우저 네트워크 요청 HTTPS 확인. API 키가 D1 plaintext, HTTP GET, 브라우저 localStorage, 로그에 나타나지 않는지 QA. 실제 키 검증·AI 호출은 아직 미구현/미활성화; 연결됨 상태는 키 저장 상태일 뿐 공급자 API 동작 보증 아님.

## 검증 절차

- 오프라인 단위/통합 코드: `npm run check && npm test` (33/33 PASS 확인).
- Chromium mocked frontend 테스트: desktop 1440×900, mobile 390×844. SRT 업로드→결과→라이브러리→usage→key 입력 UI E2E (MOCK PASS). 테스트는 Cloudflare Access 및 실제 DB/네트워크 호출을 대신하지 않음.
- 실제 호스팅 QA (NOT RUN): 로그인 전 정적 경로 `/`, `/style.css`, `/app.js` 모두 401/접근 차단; owner 로그인 200; 타인 이메일/위조 토큰/만료 토큰 거부; Origin 없는 DELETE/PUT/POST 차단; 전체 이력 D1 영속성; 관리자의 암호화 키 등록·삭제·마스터 키 로테이션; 휴대폰 네트워크 접근; 소스 접근 약관; 월 비용 $0 보장.
- 기능 (NOT RUN): 실제 Supadata `mode=native` 자막 API, 실제 Gemini 번역·요약, Groq 음성 전사, 2h 오디오 청크 업로드, 사용자 보유 음성 파일 권한/크기, 전사 누락 독립 검증, 공급자 사용량 확정/예측.

## 독립 Work 모드 실행 지시 (Work 브라우저 작업이 가능한 세션에 전달)

다음 기획서와 압축 소스를 열고 **이미 구현된 코드를 새 프로젝트로 배포**한다. 기존 BANSIGHT/MAP/PORTFLOW/뉴스봇을 수정하지 않는다. Cloudflare 계정은 사용자가 직접 인증하며, 비밀키를 대화에 노출하지 않는다. Cloudflare 무료 플랜/Access/DB/Secret 및 미배포 gate를 정확히 확인한다. 유료 설정은 사용자의 별도 명시 승인 전 중단한다. 자체 임시 주소를 공개하지 않고 보호된 접속만 검증한다. 실제 D1 저장, Access JWT 검증 및 사이트 키 암호화 동작을 재현하고, 근거·테스트 로그와 URL(보호된 경우) 보고. Groq/Gemini/Supadata live calls 및 2시간 전사는 미구현 상태이므로 QA 성공으로 포장하지 않는다. 후속 작업 우선순위: 제공자 실제 API 연동(무료), 큐, 120분 음성 분할, 전사 검증/한국어 번역.

## 비용·권한 Gate

- 사이트 키를 등록하는 것은 무료 API 호출 승인과 다르다. 실제 무료 계정/한도 검증 후 별도 ENABLE_LIVE_FREE gate.
- `ALLOW_PAID_API=false`, 월 유료 API 예산 $0. 월/연 유료 구독·자동 충전 금지.
- Cloudflare, Access, D1, R2/Queues 및 provider 구독/토큰 권한·가격은 배포 시점 재확인. 허가된 무료 제공을 벗어나면 사용자에게 대기/추가 승인 요청.

## 기술 레퍼런스

- https://developers.cloudflare.com/workers/static-assets/binding/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/d1/platform/pricing/
