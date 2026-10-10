# YouTube AI Analyzer v0.6.1 — 일반 웹 배포 패키지

먼저 docs/manual-cloudflare-v0.6.1.md를 읽으세요.

1. 새 D1: youtube-ai-analyzer-private-db → schema.sql 실행.
2. 새 Worker: youtube-ai-analyzer-private → dist/dashboard-worker.txt 전체 코드 복사·배포.
3. DB 바인딩 → 새 Worker에만 Access All traffic / 본인 이메일만 허용.
4. 문서의 변수/Secret 등록 → 원격 저장 및 키 관리 인수 테스트.

키는 채팅에 보내지 마세요. 라이브 AI 호출은 비활성 상태를 유지하세요.
로컬 자동 테스트 41 PASS. 실제 Cloudflare 배포/원격 D1/제공자 호출 NOT RUN.

Cloudflare 웹 편집기에 붙여 넣는 단일 파일에는 화면 자산이 포함되어 별도 정적 파일 업로드가 필요 없습니다.
운영은 클라우드이며 PC 상시 실행이 필요 없습니다.

개발자가 테스트를 재실행하려면 Node 24에서 npm run check 및 npm test를 실행합니다.
npm test가 단일 Worker를 먼저 재생성합니다. 이 Node 요구는 사용자 웹 배포에는 필요 없습니다.
