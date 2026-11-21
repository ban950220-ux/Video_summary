# 연계용 API (다른 프로젝트가 요약을 가져가는 방법)

대상: BANSIGHT 등 같은 소유자의 다른 프로젝트. 읽기 전용이다.

## 인증
- Cloudflare Access **서비스 토큰**을 프로젝트마다 따로 만든다(예: `bansight-reader`).
- Worker 변수 `V1_READER_TOKEN_CLIENT_ID`에 그 토큰의 Client ID를 넣는다. 현재 읽기 토큰은 1개만 지원한다.
- 요청 헤더: `CF-Access-Client-Id`, `CF-Access-Client-Secret`. Secret은 가져가는 쪽의 비밀 저장소에만 둔다.
- 이 토큰으로 할 수 있는 것은 **아래 두 GET뿐**이다. 쓰기, 전사·교정, 사용량, 키 상태, 실행기 API는 403이고 화면은 401이다.

## 엔드포인트
| 요청 | 설명 |
|---|---|
| `GET /api/v1/jobs?q=&limit=&offset=` | 요약 목록(최신순, 최대 100). 항목: `id`, `videoId`, `url`, `title`, `status`, `transcriptSource`, `createdAt`, `options.publishedAt`, `options.correctedFrom` |
| `GET /api/v1/jobs/{id}/export?format=json` | 요약 1건. `status`가 `DONE`인 작업만 가능(아니면 404) |

## JSON 형식 (`schema: "video-summary-export-v1"`)
- `video`: `id`, `url`, `title`, `publishedAt`
  - `publishedAt`은 `YYYY-MM-DD`. PC 실행기로 처리한 영상만 채워지고, 그 외에는 `null`이다.
- `summarizedAt`, `reviewState`
  - `AUTO_NOT_HUMAN_REVIEWED`: 자동 요약, 사람 검토 전
  - `AUTO_WITH_MANUAL_TRANSCRIPT_CORRECTIONS`: 수동 교정을 반영해 다시 요약
- `transcript`: `source`, `coverage`, `segments`, `uncertainSegments`
  - `source`: `supadata-native`(YouTube 자막), `gemini-video`, `pc-whisper`, `legacy-d1`, `upload`
- `conclusion`, `statements[]`
  - `kind`: `CONCLUSION` / `KEY_POINT` / `CLAIM` / `CAUSE` / `CONTEXT` / `UNCERTAINTY`
  - `attribution`: `SPEAKER`(화자가 직접 말함) / `INTERPRETATION`(AI 정리·추론)
  - `synthesized`: 화자 진술이지만 떨어진 여러 구간을 묶은 경우 `true`
  - `evidence[]`: `segmentId`, `startSec`, `url`(영상 시각 링크), `text`(원문 문장), `transcriptFlags`
  - `numbers[]`: `surface`, `value`, `unit`, `qualifier`, `quote`와 아래 두 검사 결과
    - `verification`: 요약과 전사 대조. `VERIFIED` / `MISMATCH` / `UNVERIFIABLE`와 사유 코드
    - `reListen`: 영상을 다시 들은 결과. `CONFIRMED` / `DIFFERS`(+`heardValues`) / `NOT_CHECKED`. 실행하지 않았으면 `null`
- `chapters[]`: `startSec`, `endSec`, `url`, `title`, `summary`, `numbers[]`
- `checks`: 숫자 검사 요약, 다시 듣기 요약, 분석 실행 여부

## 사용 시 주의
- 진술은 **영상이 말한 내용**이다. 외부 사실 확인을 거친 값이 아니다.
- 숫자는 `verification.status === "VERIFIED"`이고 `reListen`이 `DIFFERS`가 아닌 것만 그대로 쓰기를 권한다. 그 외에는 `evidence.url`로 직접 확인한다.
- 시점 기준(PIT)이 필요하면 `video.publishedAt`을 쓴다. `null`이면 `summarizedAt`은 "늦어도 이때는 존재"의 상한으로만 쓴다.
- 형식이 바뀌면 `schema` 값이 바뀐다(`-v2`).
