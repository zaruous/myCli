# MyCLI TODO

## 🔴 높은 우선순위

### AI 자율 코드 실행 (Code Interpreter)
> 유스케이스마다 전용 도구를 추가하는 대신, AI가 스스로 코드를 작성·실행해 목표를 달성하는 범용 능력 부여.
> 예: "이 마크다운을 Word로 변환해줘" → AI가 변환 코드를 직접 작성 → 실행 → 파일 생성

- [x] `execute_code` 도구 추가
  - AI가 Node.js 코드를 문자열로 전달하면 임시 파일(`os.tmpdir()`)에 저장 후 `node` 프로세스로 실행
  - stdout/stderr/exit code를 AI에게 반환
  - 실행 전 사용자에게 코드를 보여주고 승인 요청 (write_file과 동일 패턴)
  - 타임아웃 설정 (기본 30초)
  - 계획 모드 중 차단

- [x] `install_package` 도구 추가
  - `execute_code`와 연동: 코드 실행 전 필요한 npm 패키지를 임시 디렉터리에 설치
  - `npm install --prefix <tmpDir> <패키지명>` 방식으로 프로젝트 의존성 오염 없이 격리 설치
  - 설치 결과(성공/실패)를 AI에게 반환

- [x] 시스템 프롬프트에 코드 실행 지침 추가
  - "파일 변환, 데이터 처리, 계산 등 기존 도구로 불가한 작업은 `execute_code`로 Node.js 코드를 작성해 직접 실행하라"
  - "필요한 패키지가 있으면 `install_package`로 먼저 설치하라"
  - "코드는 단일 책임, 결과는 stdout으로 출력, 생성 파일 경로는 반드시 보고하라"

- [x] `/help` 명령어 구현 — 등록된 슬래시 명령어 목록을 출력
- [x] `edit_file` 도구 추가 — `old_string` → `new_string` 방식의 부분 수정 (전체 파일 교체 없이)
- [x] 스트리밍 토큰 출력 — AI 응답을 실시간으로 한 글자씩 출력
- [x] `execute_shell_command` UTF-8 인코딩 처리 — PowerShell 한글 깨짐 방지 (`chcp 65001`)
- [x] `get_datetime` 도구 추가 — OS 현재 날짜·시간·타임존·ISO 8601·Unix 타임스탬프 반환

## 🟡 중간 우선순위

- [x] `/model <provider>` 명령어 — 런타임에 Gemini / GPT-4o / Ollama 전환
- [x] 컨텍스트 길이 관리 — 대화 누적 토큰 초과 방지 (`/compact` 또는 자동 요약)
- [x] `/status` 명령어 — 현재 BASE_DIR, 모델, 로드된 스킬, 계획 모드 상태 출력
- [x] 세션 저장/복원 — 저장된 대화를 불러와 이어서 대화 가능

## 🟢 낮은 우선순위

- [x] `@` 인라인 파일 피커 — 입력 도중 `@` 를 타이핑하는 순간 즉시 인터랙티브 파일 선택 UI를 띄우고, 선택된 파일명을 현재 커서 위치에 삽입. 입력 시작이 `@` 인 경우에만 동작하는 현재 구조 개선.

- [x] 채팅 입력 히스토리 탐색 — AI와 대화 후 UP/DOWN 키로 이전·이후 입력 내용을 커맨드 입력창에 불러오기 (readline history 또는 직접 구현)

- [x] 다중 파일 첨부 — `@` 로 여러 파일 동시 첨부
- [x] Git 통합 도구 — `git_status`, `git_diff`, `git_log` 등 AI 도구 추가
- [x] 멀티라인 입력 — 코드 블록·긴 텍스트 붙여넣기 지원

## 🔵 Hook 시스템

> 사용자가 정의한 셸 명령(hook)을 CLI 이벤트 수명주기의 특정 시점에 자동 실행.
> Claude Code의 hooks와 동일한 개념: 이벤트 → 매처 → 커맨드 실행.

### 설계

#### 설정 파일
- 위치: `~/.mycli/hooks.json` (전역) 또는 `.mycli/hooks.json` (프로젝트 로컬, 우선)
- JSON 스키마:

```json
{
  "hooks": {
    "PreUserPromptSubmit": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "echo '$MYCLI_INPUT' >> ~/mycli-input.log" }
        ]
      }
    ],
    "PreToolCall": [
      {
        "matcher": "write_file|execute_code",
        "hooks": [
          { "type": "command", "command": "node ~/.mycli/hooks/pre-tool.js" }
        ]
      }
    ],
    "PostToolCall": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "node ~/.mycli/hooks/post-tool.js" }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [
          { "type": "command", "command": "notify-send 'KYJ CLI' 'AI 응답 완료'" }
        ]
      }
    ]
  }
}
```

#### 이벤트 종류 및 환경변수

**공통 (모든 이벤트)**
| 변수 | 값 |
|---|---|
| `MYCLI_EVENT` | 이벤트 이름 (`PreToolCall` 등) |
| `MYCLI_BASE_DIR` | 현재 작업 디렉터리 |
| `MYCLI_PROVIDER` | 현재 모델 (`gemini` / `gpt` / `ollama`) |

**`PreUserPromptSubmit`** — 사용자 입력이 AI로 전달되기 직전
| 변수 | 값 |
|---|---|
| `MYCLI_INPUT` | 사용자 입력 문자열 |

**`PreToolCall`** — AI 도구 실행 직전 (exit code ≠ 0 이면 실행 차단)
| 변수 | 값 |
|---|---|
| `MYCLI_TOOL_NAME` | 도구 이름 (`write_file`, `execute_code` 등) |
| `MYCLI_TOOL_INPUT` | 도구 입력 JSON 문자열 |
| `MYCLI_INPUT` | 현재 턴의 원래 사용자 입력 |

**`PostToolCall`** — AI 도구 실행 직후
| 변수 | 값 |
|---|---|
| `MYCLI_TOOL_NAME` | 도구 이름 |
| `MYCLI_TOOL_INPUT` | 도구 입력 JSON 문자열 |
| `MYCLI_TOOL_OUTPUT` | 도구 실행 결과 문자열 |
| `MYCLI_TOOL_EXIT_CODE` | 성공 여부 (`0` = 정상) |
| `MYCLI_INPUT` | 현재 턴의 원래 사용자 입력 |

**`Stop`** — AI 최종 응답 완료
| 변수 | 값 |
|---|---|
| `MYCLI_OUTPUT` | AI 최종 응답 전체 텍스트 |
| `MYCLI_INPUT` | 원래 사용자 입력 |

#### 동작 규칙
- `matcher`: 이벤트별 키 문자열(도구명, 입력 등)에 대해 정규식 테스트. 통과 시 hooks 배열 순차 실행
- hook 프로세스가 **0이 아닌 exit code**로 종료되면 해당 이벤트를 **차단** (PreToolCall만 해당)
- hook의 **stdout**은 `MYCLI_HOOK_OUTPUT` 변수로 다음 hook에 전달. PostToolCall/Stop에서는 AI 컨텍스트에 주입 가능 (옵션)
- hook 실행 타임아웃: 기본 10초 (설정 가능: `"timeout": 5000`)
- 실행 오류(ENOENT 등)는 경고만 출력, CLI 중단 없음

#### 파일 구조

```
lib/
  hooks.js          ← 신규: Hook 로더 · 이벤트 발행 · 실행 엔진
  hook-logger.js    ← 신규: SQLite 내역 기록 (빌트인 훅)
index.js            ← PreUserPromptSubmit, Stop 훅 발행 지점 추가
lib/tools.js        ← PreToolCall / PostToolCall 발행 지점 추가 (baseTools wrapper)
~/.mycli/
  hooks.json        ← 전역 훅 설정
  hook-log.db       ← SQLite 로그 DB
```

#### `lib/hooks.js` 주요 API

```js
// 훅 설정 로드 (startCLI에서 호출)
export async function loadHooks(): Promise<void>

// 이벤트 발행 — 해당 이벤트의 모든 훅을 순차 실행
// returns: { blocked: boolean, output: string }
export async function emitHook(event: string, env: Record<string, string>): Promise<HookResult>
```

---

### 빌트인 훅: SQLite 이벤트 로거

> `MYCLI_HOOK_LOG=true` (기본값)일 때 모든 이벤트를 `~/.mycli/hook-log.db`에 자동 기록.
> `lib/hook-logger.js`가 `emitHook` 내부에서 사용자 훅과 별도로 항상 먼저 실행됨.

#### .env 설정 변수

```dotenv
# 훅 이벤트 SQLite 기록 (기본 활성화)
MYCLI_HOOK_LOG=true

# 로그 DB 경로 (기본: ~/.mycli/hook-log.db)
MYCLI_HOOK_LOG_DB=
```

#### DB 스키마 (`hook_events` 테이블)

```sql
CREATE TABLE IF NOT EXISTS hook_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT    NOT NULL,               -- PreToolCall 등
  tool_name   TEXT,                           -- PreToolCall/PostToolCall 전용
  tool_input  TEXT,                           -- JSON 문자열
  tool_output TEXT,                           -- PostToolCall 전용
  user_input  TEXT,                           -- 해당 턴의 사용자 입력
  ai_output   TEXT,                           -- Stop 전용
  provider    TEXT,                           -- gemini / gpt / ollama
  base_dir    TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### `lib/hook-logger.js` 주요 API

```js
// DB 초기화 (startCLI에서 loadHooks 직후 호출)
export async function initHookLogger(): Promise<void>

// 이벤트 1건 기록 (emitHook 내부에서 자동 호출)
export async function logHookEvent(env: Record<string, string>): Promise<void>
```

#### `/hook-log` 슬래시 명령어

```
/hook-log            최근 20건 테이블 출력
/hook-log --event PreToolCall   특정 이벤트만 필터
/hook-log --tool write_file     특정 도구만 필터
/hook-log --limit 50            출력 건수 지정
/hook-log --clear               전체 로그 삭제 (확인 프롬프트)
```

### 구현 체크리스트

- [x] `lib/hooks.js` — 훅 로더 및 실행 엔진 구현
  - 전역 + 로컬 hooks.json 로드 (로컬 우선 merge)
  - matcher 정규식 테스트
  - 환경변수 주입하여 `spawn` 실행
  - exit code 기반 차단 / stdout 캡처
  - 타임아웃 처리
- [x] `lib/hook-logger.js` — SQLite 빌트인 로거 구현
  - `better-sqlite3` 패키지 사용 (동기 API로 단순하게)
  - `MYCLI_HOOK_LOG` 환경변수로 활성화 여부 제어 (기본 `true`)
  - `MYCLI_HOOK_LOG_DB` 환경변수로 DB 경로 오버라이드
  - `initHookLogger()` — 테이블 생성 (없으면)
  - `logHookEvent(env)` — 이벤트 1건 INSERT
- [x] `.env.example` — `MYCLI_HOOK_LOG`, `MYCLI_HOOK_LOG_DB` 항목 추가
- [x] `index.js` — `PreUserPromptSubmit` 훅 발행 (`handleChat` 진입 시)
- [x] `index.js` — `Stop` 훅 발행 (AI 최종 응답 완료 후)
- [x] `lib/tools.js` — `baseTools` 각 도구에 `PreToolCall` / `PostToolCall` 훅 발행 래퍼 적용
- [x] `lib/commands.js` — `/hook-log` 슬래시 명령어 구현 (필터·페이지네이션)
- [x] `/hooks` 슬래시 명령어 — 현재 로드된 훅 목록 출력
- [x] `/hooks`, `/hook-log` 명령어를 `/help` 목록에 추가
- [x] 훅 실행 시 `chalk.gray('[훅]')` 로그 출력 (verbose 옵션 고려)
- [x] 타임아웃·오류 발생 시 경고 출력, CLI 계속 진행

## 🔵 코드 매니저 & UX 관리자

- [x] `lib/code-manager.js` — 파일 작업 이력 추적 (read/write/edit), 되돌리기 스택 관리
- [x] `lib/ux-manager.js` — Levenshtein 오타 추천, 별칭 관리, 페이지네이션
- [x] `/recent` 명령어 — 최근 파일 작업 이력 (읽기·쓰기·편집) 타임라인 출력
- [x] `/undo` 명령어 — 마지막 파일 수정 되돌리기 (백업 기반, 새 파일이면 삭제)
- [x] `/tree [경로] [--depth N]` 명령어 — 디렉터리 트리 구조 시각화
- [x] `/alias` 명령어 — 사용자 정의 단축 명령어 등록·조회·삭제 (`~/.mycli/aliases.json`)
- [x] 명령어 오타 감지 → 유사 명령어 자동 추천 (레벤슈타인 거리 ≤ 3)
- [x] 긴 출력 자동 페이지네이션 — `/tree`, `/list` 등 20줄 초과 시 --More-- 스타일 표시
