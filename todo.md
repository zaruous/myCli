# MyCLI TODO

## 🔴 높은 우선순위

- [x] `/help` 명령어 구현 — 등록된 슬래시 명령어 목록을 출력
- [x] `edit_file` 도구 추가 — `old_string` → `new_string` 방식의 부분 수정 (전체 파일 교체 없이)
- [x] 스트리밍 토큰 출력 — AI 응답을 실시간으로 한 글자씩 출력
- [x] `execute_shell_command` UTF-8 인코딩 처리 — PowerShell 한글 깨짐 방지 (`chcp 65001`)

## 🟡 중간 우선순위

- [x] `/model <provider>` 명령어 — 런타임에 Gemini / GPT-4o / Ollama 전환
- [x] 컨텍스트 길이 관리 — 대화 누적 토큰 초과 방지 (`/compact` 또는 자동 요약)
- [x] `/status` 명령어 — 현재 BASE_DIR, 모델, 로드된 스킬, 계획 모드 상태 출력
- [x] 세션 저장/복원 — 저장된 대화를 불러와 이어서 대화 가능

## 🟢 낮은 우선순위

- [x] 다중 파일 첨부 — `@` 로 여러 파일 동시 첨부
- [x] Git 통합 도구 — `git_status`, `git_diff`, `git_log` 등 AI 도구 추가
- [x] 멀티라인 입력 — 코드 블록·긴 텍스트 붙여넣기 지원

## 🔵 코드 매니저 & UX 관리자

- [x] `lib/code-manager.js` — 파일 작업 이력 추적 (read/write/edit), 되돌리기 스택 관리
- [x] `lib/ux-manager.js` — Levenshtein 오타 추천, 별칭 관리, 페이지네이션
- [x] `/recent` 명령어 — 최근 파일 작업 이력 (읽기·쓰기·편집) 타임라인 출력
- [x] `/undo` 명령어 — 마지막 파일 수정 되돌리기 (백업 기반, 새 파일이면 삭제)
- [x] `/tree [경로] [--depth N]` 명령어 — 디렉터리 트리 구조 시각화
- [x] `/alias` 명령어 — 사용자 정의 단축 명령어 등록·조회·삭제 (`~/.mycli/aliases.json`)
- [x] 명령어 오타 감지 → 유사 명령어 자동 추천 (레벤슈타인 거리 ≤ 3)
- [x] 긴 출력 자동 페이지네이션 — `/tree`, `/list` 등 20줄 초과 시 --More-- 스타일 표시
