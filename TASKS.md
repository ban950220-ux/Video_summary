# 남은 작업

완료 기준과 세부 내용은 `docs/v1/DESIGN.md` 5장, 진행 기록은 `docs/v1/PROGRESS.md`를 따른다.

- [x] 0단계: 설계 문서 승인 (2026-11-21)
- [x] 1단계: 기반 구성 — 문서, `src/v1` 골격, 검사, CI
- [x] 2단계: 자막·전사 확보 (Supadata native, Gemini 구간 전사, 업로드 파서)
- [x] 3단계: 요약 엔진 (map-reduce, 스키마 고정, `facts` 포함, 1회 재시도)
- [x] 4단계: Workflow·D1 `v1_` 테이블·API
- [x] 5단계: 화면·PWA (이전 보고서 읽기 전용 탭 포함)
- [ ] 6단계: 배포(별도 승인)·실제 영상 3개 검증·Android 설치 확인
- [ ] 7단계: PC 실행기 + Groq Whisper, MP3 업로드 재연결
- [x] 8단계: 분석(8-B) + 숫자 근거 검증(8-A) — 운영 실검증 완료
- [ ] 6단계 이후: 수동 배포 워크플로(`deploy.yml`, Worker 이름 입력 확인) 추가
