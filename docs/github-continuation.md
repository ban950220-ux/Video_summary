# GitHub에서 이어서 개발하기

저장소: ban950220-ux/Video_summary. 현재 공개 저장소다.
공개 코드 저장소와 본인 전용 실행 사이트는 별도이다. 실제 API 키, 암호화 루트,
전사 원문, 분석 데이터, Cloudflare 로그인 정보는 GitHub에 저장하지 않는다.

현재 제공하는 구성:

- v0.6.1 소스, 화면, D1 schema, 보안 테스트, 웹 편집기용 단일 Worker.
- GitHub Actions는 표준 ubuntu-latest에서 Node 24로 구문 검사 및 41개 테스트만 수행한다.
- 실제 Cloudflare API 호출/배포, Secret 읽기, D1 생성/변경은 수행하지 않는다.
- CI 녹색은 Node/SQLite/mock 검증 성공이다. Cloudflare/Access/실제 AI PASS는 아니다.

GitHub 연결만으로 Cloudflare 리소스 관리 권한을 얻지 않는다.
Cloudflare GitHub integration을 사용자 일반 웹에서 새 Worker에 한 번 설정하면,
설정된 브랜치 변경에 따라 Cloudflare가 빌드/배포할 수 있다.
연결 권한은 이 Video_summary 저장소 하나로 제한한다.
기존 Worker, D1 또는 기존 앱의 GitHub 연결을 수정하지 않는다.

2026-10-10 당시의 자동 배포 상태(이력):

- wrangler.toml은 workers_dev=false이고 D1 및 Access 설정도 아직 없다.
- npm run release:gate는 원격 증거를 확인하지 못해 종료 코드 2를 반환한다.
- Cloudflare 연결의 초기 deploy command를 npm run release:gate로 두면 코드가 실제 배포되지 않는다.
- 보호된 새 Worker/D1/Access를 수동 초기 설정하고 원격 검증한 뒤,
  해당 Worker를 가리키는 config, 독립 D1 UUID, 보호된 route, Secret 보존,
  재검증 조건과 deploy command를 함께 정리한 후 자동 배포를 활성화한다.
- 지금 바로 기본 npx wrangler deploy를 활성화하지 않는다.

Cloudflare GitHub integration은 코드 빌드/배포 경로다.
Access 정책 관리, 계정 무료 플랜 확인, D1 초기 생성, Secret 등록은 별도 초기 설정이다.
이 연결로 에이전트가 D1 이력이나 API 키를 자유롭게 읽게 되는 것은 아니다.

현재 진행 상황 (2026-10-10):

- 사용자가 연결 권한을 변경한 후 README 실제 쓰기가 성공했다.
- 운영 Worker는 사용자가 만든 holy-rice-b914이다.
- 사용자가 본인 로그인, D1 스키마 4개 생성, 샘플 분석 저장 후 재조회,
  가짜 제공자 키 등록/교체/삭제, 실제 3개 제공자 키 등록을 확인했다.
- 위 원격 결과는 USER_REPORTED이며 에이전트 직접 원격 검증 PASS가 아니다.
- 실제 AI 제공자 호출은 NOT RUN이고 ENABLE_LIVE_FREE=false를 유지한다.
- 당시 이 저장소의 wrangler.toml은 미설정 템플릿이었다. 이후 운영 Worker/D1 식별자를
  반영한 리뷰 브랜치를 준비했다. 최신 배포 설정과 차단 조건은
  [production-git-build.md](production-git-build.md)를 따른다.

다음 사용자 조치:

Cloudflare 일반 웹에서 기존의 이번 프로젝트 Worker holy-rice-b914의 Git 연동 화면을 연다.
Video_summary만 선택하고, 기본 자동 deploy command를 활성화하기 전에
Worker 이름, build/deploy command, production branch를 비밀값 없이 확인한다.
Cloudflare 설정 자동화를 위해 실제 Worker 이름과 독립 D1 UUID를 source config에 연결하는
별도 작업이 필요하다. 기존 사이트 보호/Secret을 보존하고 라이브 AI는 계속 차단한다.

참고:
https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/
https://docs.github.com/en/billing/concepts/product-billing/github-actions
