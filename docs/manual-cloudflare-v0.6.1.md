# 일반 웹 배포 안내 — v0.6.1

현재 상태: 코드 준비 및 Node 테스트 41 PASS. 사용자 Cloudflare 배포, Access 로그인, 원격 D1, 실제 제공자 API는 NOT RUN.
기존 v0.6에 단일 파일 웹 편집기 배포 경로와 SQLite 디스크 재열기 테스트만 추가했다. AI 기능은 그대로 비활성이다.

## 준비

- 사용자 일반 웹에서 Cloudflare에 로그인한다. 기존 MAP/BANSIGHT/PORTFLOW/뉴스봇의 Worker, DB, Access 정책을 편집하지 않는다.
- Workers 무료 플랜인지 확인한다. Zero Trust 가입이 필요하다면 Free를 선택하고 카드 등록·유료 플랜·유료 도메인이 필요한 화면에서는 진행하지 않는다.
- 새 Worker 이름: youtube-ai-analyzer-private. 새 D1 이름: youtube-ai-analyzer-private-db. 동일 이름의 리소스가 이미 있다면 덮어쓰지 말고 알려준다.
- 전체 계정의 Protect all Workers는 사용하지 않는다. 새 Worker 하나에만 Access를 적용한다.
- 서비스 코드/자산은 dist/dashboard-worker.mjs에 모두 포함된다. Dashboard 편집기 배포에는 npm, 터미널, GitHub 연결이 필요 없다.

## 1. 새 D1 생성

Cloudflare Storage & databases → D1 → Create database에서 youtube-ai-analyzer-private-db를 생성한다.
새 DB의 Console에서 이 패키지의 schema.sql을 실행한다. 여러 문장을 한꺼번에 받지 못하면 세미콜론 기준으로 나누어 순서대로 실행한다.
아래 읽기 전용 SQL로 4개 테이블이 생성됐는지 확인한다.

```sql
SELECT name FROM sqlite_master WHERE type='table'
AND name IN ('jobs','usage_events','provider_credentials','provider_credential_events')
ORDER BY name;
```

4개 이름이 나오는 것만 스키마 생성 증거다. 앱의 원격 저장 PASS 증거는 아직 아니다.

## 2. 새 Worker 생성 및 단일 파일 적용

Workers & Pages → Create application에서 새 Worker 생성 경로를 사용한다.
기본 Hello World 생성 시에는 비밀값이나 사용자 데이터를 넣지 않는다.
생성 직후 Edit code에서 기본 코드를 **dist/dashboard-worker.mjs 전체 내용**으로 교체하고 Deploy한다.
worker 파일을 텍스트 편집기로 열어 전체 복사할 수 있도록 dist/dashboard-worker.txt도 함께 제공한다.

설정이 없는 이 코드는 모든 HTML/JS/CSS/API 요청에 503 ACCESS_NOT_CONFIGURED를 반환한다. 초기 Hello World에는 앱 데이터나 키가 없다.
본인 Access 설정을 마칠 때까지 API 키를 등록하지 않는다.
이 경로는 자산이 코드 내부에 포함되어 ASSETS 바인딩이 필요 없다. 기존 wrangler.toml 기반 다중 파일 배포와 섞지 않는다.

## 3. D1 바인딩

새 Worker → Settings 또는 Bindings → Add binding → D1 database.
Variable name은 대문자 **DB**, database는 방금 만든 **youtube-ai-analyzer-private-db**만 선택한다.
저장/배포가 필요하면 이 새 Worker만 대상으로 수행한다.

## 4. 개별 Worker Access

새 Worker → Access → Protect this Worker behind Access → **All traffic**.
Authentication policy는 본인 이메일 한 개만 허용하는 정책을 만든다.
Everyone, 모든 이메일 도메인, Bypass, 다른 기존 정책 재사용은 선택하지 않는다.
이메일 일회용 코드 로그인 또는 기존의 본인 로그인 공급자를 사용한다.
Apply Access 후 해당 애플리케이션 정보에서 AUD를 확인한다.
Zero Trust 설정에서 Team domain을 확인한다.
개별 Worker UI가 없으면 설정을 추측하지 말고 해당 화면을 알려준다. 다른 Worker 보호나 도메인 구매로 대체하지 않는다.

## 5. Variables / Secrets

새 Worker 설정에서 아래 값만 추가하고 적용한다.

| 이름 | 유형 | 값 |
|---|---|---|
| ACCESS_TEAM_DOMAIN | Text | https://본인팀.cloudflareaccess.com (끝 / 없음) |
| ACCESS_AUD | Text | 방금 생성한 Access 애플리케이션 AUD |
| ACCESS_OWNER_EMAIL | Secret | 정책에 허용한 본인 이메일 |
| KEY_ENCRYPTION_KEY_B64 | Secret | 암호학적 난수 32바이트의 Base64 |
| ENABLE_LIVE_FREE | Text | false |
| ALLOW_PAID_API | Text | false |
| SITE_DEPLOYED | Text | true |

ADMIN_TOKEN은 설정하지 않는다. 제공자 키는 이 단계에서 Worker 일반 변수에 넣지 않는다.
SITE_DEPLOYED는 배포 사실 표기일 뿐, 보안 테스트나 AI 검증 PASS를 의미하지 않는다.

암호화 루트 생성: 패키지의 tools/root-key-generator.html을 사용자 본인의 브라우저에서 연다.
네트워크 요청, 외부 스크립트, 브라우저 저장소 없이 Web Crypto로 32바이트를 생성한다.
생성/복사 후 Cloudflare의 KEY_ENCRYPTION_KEY_B64 **Secret 입력칸**에만 붙여 넣는다.
다음으로 루트를 본인의 암호화된 비밀번호 관리자에 보관하고 생성기 탭을 닫는다.
이것은 한 번의 초기 설정 도구이며, 운영 앱은 Cloudflare에서 실행된다.
기존 v0.6 문서의 'Cloudflare 화면에서 생성'은 실제 내장 생성 기능을 확인하지 못했으므로 가정하지 않는다.
루트를 채팅, 스크린샷, 코드, Text 변수에 넣지 않는다. 분실하거나 새 값으로 덮어쓰면 기존 API 키 복호화가 불가능하다.

## 6. 실제 원격 인수 테스트 — 결과를 직접 확인

각 항목은 원격 증거를 확인한 후에만 PASS로 표시한다. 아래는 수행 절차이며 아직 실행 결과가 아니다.

1. 비로그인 시크릿 창에서 앱 /, /app.js, /style.css, /api/health를 연다.
   본인 인증 전에는 앱 본문이나 JSON 데이터가 보이지 않아야 한다. Access 로그인 페이지로 이동하는 것은 정상이다.
2. 본인 로그인 후 앱이 열리고 /api/health의 storageConfigured가 true인지 확인한다.
   mode=MOCK_ONLY, realCalls=false, productionReady=false가 정상이다.
3. 새 분석 → 자막 파일 모드에서 examples/sample.srt를 선택하고 원본 길이 98분, 제목 'REMOTE_STORAGE_TEST'로 저장한다.
   D1 저장 표시와 PARTIAL_TRANSCRIPT 상태를 확인한다.
4. 분석 이력에서 제목 검색 → 리포트 열기 → 새로고침 후 재열기.
   로그인 세션을 종료하고 다시 로그인하거나 새 브라우저 창에서 같은 기록이 보이는지 확인한다.
5. D1 Console에서 아래 SQL의 n이 1인지 확인한다. 같은 제목으로 여러 번 만들면 여러 건이므로 테스트 제목에 시각을 붙여 구분한다.

```sql
SELECT COUNT(*) AS n FROM jobs WHERE title='REMOTE_STORAGE_TEST';
SELECT title,status,duration_seconds,created_at FROM jobs WHERE title='REMOTE_STORAGE_TEST';
```

6. 실제 키를 넣기 **전에** 설정 → Groq에 NON_REAL_API_KEY_STORAGE_TEST를 등록한다.
   이 값은 의도적으로 가짜 키이며 외부 제공자 호출은 발생하지 않는다.
   새로고침 후 '암호화 저장됨 · 미검증'을 확인하고 D1 Console에서 아래 구조 증거를 확인한다.

```sql
SELECT provider,cipher_version,length(iv_b64) AS iv_len,
length(ciphertext_b64) AS ciphertext_len FROM provider_credentials;
SELECT name FROM pragma_table_info('provider_credentials');
```

   groq 행의 version=1, iv_len=16, ciphertext_len>0이고 평문 api_key 컬럼이 없어야 한다.
   이 구조만으로 실제 루트 복호화/로그 미유출을 전부 입증했다고 주장하지 않는다.
7. 가짜 키를 NON_REAL_API_KEY_ROTATION_TEST로 교체 → 새로고침 → 삭제.
   아래 SQL로 제거와 SET_OR_ROTATE/DELETE 이벤트를 확인한다.

```sql
SELECT COUNT(*) AS n FROM provider_credentials WHERE provider='groq';
SELECT provider,event_type,at FROM provider_credential_events ORDER BY at DESC LIMIT 5;
```

8. 이후 실제 Supadata/Gemini/Groq 키는 앱의 보안 설정에 직접 등록한다. 원문을 보내지 않는다.
   등록은 저장 검증이며 유효한 제공자 연결이나 무료 quota 검증을 뜻하지 않는다.
9. 테스트 이력 삭제는 사용자 본인이 삭제할 테스트 기록만 대상으로 한다. 실제 분석 자료는 삭제하지 않는다.
   제거 후 이력 목록과 D1 조회에서 해당 테스트 건이 사라지는지 확인한다.
10. 브라우저 개발자 도구 Network에서 GET /api/settings/providers 응답에 원문 키가 없는지 본인이 확인한다.
    Local/Session Storage에도 키가 없어야 한다. PUT 요청은 TLS로 키를 서버에 전송하므로 요청 본문에는 키가 존재한다.
    따라서 Network HAR, 요청 본문, Secret 설정 화면, 로그를 채팅에 공유하지 않는다.

다른 이메일 로그인 차단과 외부 Origin 쓰기 차단은 로컬 서명 토큰 테스트로 확인했다.
실제 Access 비소유자 정책·원격 CSRF는 별도 원격 검증 전까지 NOT RUN이다.
Cloudflare 원격 CPU 한도 및 실제 Web Crypto 호환성도 배포 테스트 전에는 NOT RUN이다.

## 비용 / 저장 범위 / 미구현

- 무료 Workers/D1/Access 조건만 사용한다. 계정이 이미 유료 Workers 플랜이면 신규 리소스도 계정 요금 체계를 따르므로 중단하고 확인한다.
- 무료 한도는 계정 전체 다른 앱 사용량과 공유될 수 있다. 기존 앱을 수정하지 않아도 추가 사용량은 발생한다.
- 이 앱의 실제 AI 호출 경로는 비활성이다. ENABLE_LIVE_FREE를 true로 바꾸지 않는다.
- 보고서와 audit는 D1에 지속 저장된다. 원본 스크립트와 음성 파일 전체는 현재 저장하지 않는다.
- 지속 저장은 브라우저 종료 후 유지한다는 뜻이며, 무제한 보관·데이터 손실 불가능을 보장하지 않는다. 계정/DB 삭제와 저장 한도의 영향을 받는다.
- URL 자막/AI 요약/Groq 전사/120분 청크/쿼터 예약·정산/보고서 내보내기는 이 배포 경로에서 아직 미구현 또는 미연결이다.
- 루트 키 회전·백업 자동화는 미구현이다. 제공자 키 교체는 구현돼 있다.

## 확인된 개발 결과 (2026-10-10)

| 항목 | 결과 | 증거 범위 |
|---|---|---|
| 기존+추가 자동 테스트 | PASS 41/41 | Node, 모의 외부 API 및 로컬 SQLite |
| 파일 SQLite 재열기 후 보고서/암호문 재조회 | PASS | 로컬 SQLite, 원격 D1 아님 |
| 단일 Worker 자산 인증 차단 및 유효 서명 자산 제공 | PASS | Node, 테스트 RSA/JWKS |
| 배포 release gate | BLOCKED_DEPLOY | D1/Access/Secrets 미검증 |
| Cloudflare 계정 원격 배포 | NOT RUN | 로그인 요청 403 |
| 원격 D1 지속 저장 | NOT RUN | 사용자 적용 후 검증 필요 |
| 원격 API 키 저장/교체/삭제 | NOT RUN | 사용자 적용 후 검증 필요 |
| 실제 제공자 호출 및 98분 전사 | NOT RUN | 라이브 미연결 |

## 공식 참고 (2026-10-10 확인)

- 개별 Worker Access: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Dashboard 시작: https://developers.cloudflare.com/workers/get-started/dashboard/
- Workers/D1 무료 한도: https://developers.cloudflare.com/workers/platform/pricing/

다음 공유 내용은 새 Worker 이름/URL, D1 바인딩 이름, 설정 완료 여부, 오류 문구 등 비밀값 없는 정보만이다.
