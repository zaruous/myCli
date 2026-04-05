# Hook 시스템 사용 가이드

KYJ CLI의 훅 시스템을 사용하면 CLI 이벤트 수명주기의 특정 시점에 사용자 정의 셸 명령을 자동으로 실행할 수 있습니다.

---

## 목차

1. [개요](#개요)
2. [설정 파일](#설정-파일)
3. [이벤트 종류](#이벤트-종류)
4. [환경변수 (파라미터)](#환경변수-파라미터)
5. [훅 작성 방법](#훅-작성-방법)
6. [실전 예제](#실전-예제)
7. [SQLite 이벤트 로그](#sqlite-이벤트-로그)
8. [슬래시 명령어](#슬래시-명령어)
9. [주의사항](#주의사항)

---

## 개요

훅은 다음 흐름에 따라 실행됩니다.

```
사용자 입력
    │
    ▼
[PreUserPromptSubmit] ← 훅 실행
    │
    ▼
AI 처리 + 도구 호출
    │
    ├─ [PreToolCall]  ← 훅 실행 (exit code ≠ 0 이면 도구 차단)
    ├─ 도구 실행
    └─ [PostToolCall] ← 훅 실행
    │
    ▼
AI 최종 응답
    │
    ▼
[Stop] ← 훅 실행
```

모든 이벤트는 **빌트인 SQLite 로거**에 자동 기록됩니다. (`MYCLI_HOOK_LOG=true` 기본값)

---

## 설정 파일

훅은 JSON 파일로 정의합니다.

| 위치 | 적용 범위 |
|---|---|
| `~/.mycli/hooks.json` | 전역 (모든 프로젝트) |
| `.mycli/hooks.json` | 프로젝트 로컬 (전역에 추가 병합) |

두 파일이 모두 있으면 **전역 항목 뒤에 로컬 항목이 append**됩니다.

### 스키마

```json
{
  "hooks": {
    "<이벤트명>": [
      {
        "matcher": "<정규식>",
        "hooks": [
          {
            "type": "command",
            "command": "<실행할 셸 명령>",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `matcher` | 선택 | 매칭 대상에 테스트할 정규식. 생략 시 `.*` (전체 허용) |
| `type` | 선택 | `"command"` 또는 생략 |
| `command` | 필수 | 실행할 셸 명령어 |
| `timeout` | 선택 | 밀리초 단위 타임아웃 (기본: 10000ms) |

### matcher 매칭 대상

| 이벤트 | matcher가 테스트하는 값 |
|---|---|
| `PreUserPromptSubmit` | 사용자 입력 문자열 |
| `PreToolCall` | 도구 이름 (`write_file`, `read_file` 등) |
| `PostToolCall` | 도구 이름 |
| `Stop` | AI 최종 응답 문자열 |

---

## 이벤트 종류

### `PreUserPromptSubmit`
사용자 입력이 AI로 전달되기 **직전**에 발생합니다.

### `PreToolCall`
AI가 도구를 실행하기 **직전**에 발생합니다.
- 훅 프로세스가 **exit code ≠ 0**으로 종료되면 해당 도구 실행이 **차단**됩니다.

### `PostToolCall`
도구 실행이 **완료된 직후**에 발생합니다.

### `Stop`
AI가 **최종 응답을 완료**했을 때 발생합니다.

---

## 환경변수 (파라미터)

훅 프로세스는 아래 환경변수를 통해 컨텍스트 정보를 받습니다.

### 공통 (모든 이벤트)

| 변수 | 값 |
|---|---|
| `MYCLI_EVENT` | 이벤트 이름 (`PreToolCall` 등) |
| `MYCLI_BASE_DIR` | 현재 작업 디렉터리 |
| `MYCLI_PROVIDER` | 현재 모델 (`gemini` / `gpt` / `ollama`) |

### `PreUserPromptSubmit`

| 변수 | 값 |
|---|---|
| `MYCLI_INPUT` | 사용자 입력 문자열 |

### `PreToolCall`

| 변수 | 값 |
|---|---|
| `MYCLI_TOOL_NAME` | 도구 이름 |
| `MYCLI_TOOL_INPUT` | 도구 입력 (JSON 문자열) |
| `MYCLI_INPUT` | 현재 턴의 사용자 입력 |

### `PostToolCall`

| 변수 | 값 |
|---|---|
| `MYCLI_TOOL_NAME` | 도구 이름 |
| `MYCLI_TOOL_INPUT` | 도구 입력 (JSON 문자열) |
| `MYCLI_TOOL_OUTPUT` | 도구 실행 결과 |
| `MYCLI_TOOL_EXIT_CODE` | 성공 여부 (`0` = 정상) |
| `MYCLI_INPUT` | 현재 턴의 사용자 입력 |

### `Stop`

| 변수 | 값 |
|---|---|
| `MYCLI_OUTPUT` | AI 최종 응답 전체 텍스트 |
| `MYCLI_INPUT` | 원래 사용자 입력 |

### `MYCLI_HOOK_OUTPUT`
직전 훅의 stdout이 다음 훅에 `MYCLI_HOOK_OUTPUT`으로 전달됩니다. 여러 훅을 파이프처럼 연결할 때 활용하세요.

---

## 훅 작성 방법

### 인라인 셸 명령

간단한 경우 `command`에 직접 작성합니다.

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [
          { "command": "echo AI 응답 완료 >> ~/mycli.log" }
        ]
      }
    ]
  }
}
```

### 외부 스크립트 호출

복잡한 로직은 Node.js 스크립트로 분리합니다.

```json
{
  "hooks": {
    "PreToolCall": [
      {
        "matcher": "write_file|edit_file",
        "hooks": [
          { "command": "node ~/.mycli/hooks/guard-write.js" }
        ]
      }
    ]
  }
}
```

**`~/.mycli/hooks/guard-write.js` 예시:**

```js
// 환경변수에서 도구 입력을 파싱
const input = JSON.parse(process.env.MYCLI_TOOL_INPUT || '{}');
const filePath = input.filePath || '';

// 보호 경로 차단
const PROTECTED = ['/etc/', '/System/', 'C:\\Windows\\'];
const isProtected = PROTECTED.some(p => filePath.startsWith(p));

if (isProtected) {
  console.error(`[guard] 보호된 경로입니다: ${filePath}`);
  process.exit(1); // exit 1 → 도구 실행 차단
}

process.exit(0); // exit 0 → 정상 실행
```

### `MYCLI_TOOL_INPUT` 파싱

`MYCLI_TOOL_INPUT`은 JSON 문자열입니다. `jq` 또는 Node.js로 파싱하세요.

```bash
# bash + jq
FILE_PATH=$(echo "$MYCLI_TOOL_INPUT" | jq -r '.filePath')
echo "파일 경로: $FILE_PATH"
```

```js
// Node.js
const { filePath, content } = JSON.parse(process.env.MYCLI_TOOL_INPUT);
```

---

## 실전 예제

### 예제 1: 모든 사용자 입력 로그 기록

```json
{
  "hooks": {
    "PreUserPromptSubmit": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "command": "echo %DATE% %TIME% %MYCLI_INPUT% >> %USERPROFILE%\\mycli-input.log"
          }
        ]
      }
    ]
  }
}
```

> Windows에서는 `%VARIABLE%`, Linux/macOS에서는 `$VARIABLE` 형식을 사용하세요.

---

### 예제 2: 특정 도구 실행 시 알림

```json
{
  "hooks": {
    "PostToolCall": [
      {
        "matcher": "execute_code|execute_shell_command",
        "hooks": [
          { "command": "node -e \"console.log('[알림] 코드/명령 실행 완료:', process.env.MYCLI_TOOL_NAME)\"" }
        ]
      }
    ]
  }
}
```

---

### 예제 3: `write_file` 실행 전 Git 상태 확인 및 차단

```json
{
  "hooks": {
    "PreToolCall": [
      {
        "matcher": "write_file",
        "hooks": [
          { "command": "node ~/.mycli/hooks/check-git-clean.js" }
        ]
      }
    ]
  }
}
```

**`~/.mycli/hooks/check-git-clean.js`:**

```js
import { execSync } from 'child_process';

try {
  const status = execSync('git status --porcelain', {
    cwd: process.env.MYCLI_BASE_DIR,
    encoding: 'utf-8',
  });

  if (status.trim()) {
    console.error('[guard] 커밋되지 않은 변경사항이 있습니다. 먼저 커밋 후 진행하세요.');
    process.exit(1); // 차단
  }
} catch {
  // git 저장소 아님 → 무시
}

process.exit(0);
```

---

### 예제 4: 키워드 포함 입력 감지 및 경고

```json
{
  "hooks": {
    "PreUserPromptSubmit": [
      {
        "matcher": "삭제|delete|rm -rf|drop table",
        "hooks": [
          { "command": "node -e \"console.warn('[경고] 위험한 작업이 감지되었습니다:', process.env.MYCLI_INPUT)\"" }
        ]
      }
    ]
  }
}
```

---

### 예제 5: AI 응답 완료 후 데스크톱 알림 (Windows)

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "command": "powershell -Command \"[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('AI 응답 완료')\"",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

---

### 예제 6: 훅 체이닝 (`MYCLI_HOOK_OUTPUT` 활용)

여러 훅의 stdout이 순서대로 다음 훅의 `MYCLI_HOOK_OUTPUT`으로 전달됩니다.

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [
          { "command": "echo STEP1_DONE" },
          { "command": "node -e \"console.log('이전 훅 출력:', process.env.MYCLI_HOOK_OUTPUT)\"" }
        ]
      }
    ]
  }
}
```

---

## SQLite 이벤트 로그

### 활성화 설정 (`.env`)

```dotenv
# 기본값: true (활성화)
MYCLI_HOOK_LOG=true

# 로그 DB 경로 (기본: ~/.mycli/hook-log.db)
MYCLI_HOOK_LOG_DB=
```

비활성화하려면:
```dotenv
MYCLI_HOOK_LOG=false
```

### DB 스키마

```sql
CREATE TABLE hook_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT,     -- PreToolCall 등
  tool_name   TEXT,     -- 도구 이름
  tool_input  TEXT,     -- JSON 문자열
  tool_output TEXT,     -- 도구 실행 결과
  user_input  TEXT,     -- 사용자 입력
  ai_output   TEXT,     -- AI 최종 응답
  provider    TEXT,     -- gemini / gpt / ollama
  base_dir    TEXT,     -- 작업 디렉터리
  created_at  DATETIME  -- 기록 시각
);
```

DB 파일은 기본적으로 `~/.mycli/hook-log.db`에 저장되며, 어떤 SQLite 클라이언트로도 열람할 수 있습니다.

```bash
# sqlite3 CLI로 직접 조회
sqlite3 ~/.mycli/hook-log.db "SELECT event, tool_name, user_input, created_at FROM hook_events ORDER BY id DESC LIMIT 20;"
```

---

## 슬래시 명령어

### `/hooks`
현재 로드된 훅 설정과 SQLite 로거 상태를 출력합니다.

```
/hooks
```

출력 예시:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  로드된 훅 설정
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  PreToolCall (1개 항목)
    matcher: write_file|edit_file
      → node ~/.mycli/hooks/guard-write.js

  SQLite 로거    활성 (SQLite 로깅 중)
```

---

### `/hook-log`
SQLite에 기록된 이벤트 로그를 조회합니다.

```
/hook-log                          # 최근 20건 출력
/hook-log --event PreToolCall      # 특정 이벤트만 필터
/hook-log --tool write_file        # 특정 도구만 필터
/hook-log --limit 50               # 출력 건수 지정
/hook-log --clear                  # 전체 로그 삭제 (확인 프롬프트)
```

---

## 주의사항

### 차단 동작
- `PreToolCall` 훅만 차단 기능이 있습니다.
- 다른 이벤트(`PreUserPromptSubmit`, `PostToolCall`, `Stop`)는 exit code와 무관하게 차단되지 않습니다.

### 타임아웃
- 기본 타임아웃은 **10초(10000ms)**입니다.
- 타임아웃이 발생하면 경고를 출력하고 해당 훅을 건너뜁니다. CLI는 계속 동작합니다.
- 빠른 반응이 필요한 `PreToolCall` 훅은 타임아웃을 짧게 설정하세요.

### 오류 처리
- 훅 실행 중 오류(명령어 없음, 파일 없음 등)는 경고를 출력하고 **CLI를 중단하지 않습니다.**
- `PreToolCall`에서 차단이 필요하면 반드시 **`process.exit(1)`**을 명시적으로 호출하세요.

### 환경변수 주의
- `MYCLI_TOOL_INPUT`은 JSON 문자열이므로 직접 사용 시 파싱이 필요합니다.
- 긴 AI 응답이 담긴 `MYCLI_OUTPUT`을 명령줄 인자로 직접 넘기면 OS 인자 길이 제한에 걸릴 수 있습니다. 스크립트 파일에서 환경변수로 읽는 방식을 권장합니다.

### Windows 환경
- 명령어에서 환경변수는 `%MYCLI_INPUT%` 형식을 사용합니다.
- Node.js 스크립트를 훅으로 사용하면 크로스 플랫폼 호환성이 높아집니다.
- PowerShell을 사용할 경우 `powershell -Command "..."` 형식으로 호출하세요.
