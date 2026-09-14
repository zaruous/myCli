# MyCLI - AI 기반 CLI 에이전트

`MyCLI`는 LangChain.js를 기반으로 구축된 대화형 AI 커맨드 라인 에이전트입니다. Google Gemini, OpenAI, Ollama 등 다양한 언어 모델을 지원하며, 파일 시스템 탐색·수정, 코드 직접 실행, 셸 명령어 실행, MCP 서버 연동, 스킬 시스템 등 개발 작업에 필요한 도구를 제공합니다.

## 프로젝트 구조

```
mycli/
├── index.js              # 메인 진입점 (REPL 루프, @ 파일 첨부, 멀티라인 입력)
├── lib/
│   ├── agent.js          # LLM 모델 팩토리, AgentExecutor 생성
│   ├── commands.js       # 슬래시 명령어 등록 (/help, /model, /plan 등)
│   ├── tools.js          # AI 도구 정의 (read/write/edit/grep/git/execute_code 등)
│   ├── ui.js             # 스피너, readline 프롬프트, Tab 자동완성
│   ├── code-manager.js   # 파일 변경 이력, undo 관리
│   ├── diff.js           # LCS 기반 라인 diff 렌더링
│   ├── state.js          # 공유 상태 (BASE_DIR, planModeState, readFileState)
│   ├── utils.js          # 보안 유틸리티 (getSafePath, getTimestamp)
│   ├── history.js        # 명령어 히스토리 (↑↓ 탐색)
│   ├── skills.js         # 스킬 시스템 (SKILL.md 로드·실행)
│   ├── context.js        # 프로젝트 컨텍스트 파일 로드 (mycli.md)
│   ├── mcp.js            # MCP(Model Context Protocol) 클라이언트 (stdio·HTTP)
│   ├── hooks.js          # 훅 로더·이벤트 발행·실행 엔진
│   ├── hook-logger.js    # 훅 이벤트 SQLite 로거
│   └── ux-manager.js     # 별칭(alias), 명령어 추천, 페이지네이션
├── mcps/                 # MCP 서버 설정 파일 (*.json)
├── docs/                 # 개발 문서
└── .mycli/
    └── skills/           # 로컬 스킬 디렉터리
```

## ✨ 주요 기능

### AI 도구

| 도구 | 설명 |
|------|------|
| `read_file` | 파일 내용을 읽습니다. `offset`/`limit`으로 줄 범위 지정 가능. 작업 디렉터리 밖 파일은 **절대경로 + 사용자 확인** 시에만 읽기 허용 |
| `write_file` | 파일 생성·전체 수정. read-before-write 강제, diff 미리보기 후 확인 |
| `edit_file` | 파일의 특정 문자열만 교체. `replace_all` 옵션 지원 |
| `glob_files` | 글로브 패턴으로 파일 검색 (최근 수정 순 정렬) |
| `grep_files` | 정규식으로 파일 내용 검색. ripgrep 우선, JS 폴백 |
| `execute_shell_command` | 셸 명령어 실행 (Windows: PowerShell / 그 외: `/bin/sh`). 실행 전 확인 |
| `execute_code` | Node.js 코드를 직접 작성하여 샌드박스에서 실행 |
| `install_package` | npm 패키지를 샌드박스에 설치 |
| `git_status` | git 상태 확인 |
| `git_diff` | git diff 출력 |
| `git_log` | git 커밋 로그 출력 |
| `enter_plan_mode` / `exit_plan_mode` | 계획 모드 진입/종료. 계획 모드에서는 파일 수정·명령 실행이 차단됨 |
| `get_datetime` | OS의 현재 날짜·시간·타임존 반환 |
| `use_skill` | 등록된 스킬을 AI가 직접 호출 |

### 슬래시 명령어

| 명령어 | 설명 |
|--------|------|
| `/help` | 사용 가능한 명령어 목록 출력 |
| `/status` | BASE_DIR, 모델, 스킬 등 현재 상태 출력 |
| `/model [provider]` | 모델 전환 (`gemini` \| `gpt` \| `ollama` \| `vllm`) |
| `/clear` | 대화 기록 초기화 및 화면 지우기 |
| `/compact` | 대화 기록을 AI로 요약하여 압축 |
| `/list` | 현재 세션 대화 기록 출력 |
| `/save` | 대화 내용을 Markdown 파일로 저장 |
| `/session-save [name]` | 세션을 JSON으로 저장 |
| `/session-load [name]` | 저장된 세션 불러오기 (생략 시 목록) |
| `/basedir <path>` | 작업 디렉터리(BASE_DIR) 변경 |
| `/plan` | 계획 모드 진입 |
| `/plan-exit` | 계획 모드 종료 및 계획 제출 |
| `/plan-status` | 계획 모드 상태 확인 |
| `/thinking [on\|off]` | 도구 호출 입력·결과(중간 과정) 표시 접기/펴기 (생략 시 토글) |
| `/skills [on\|off]` | 스킬 로드 시 주입되는 프롬프트 전문 표시 접기/펴기 (생략 시 토글) |
| `/recent [n]` | 최근 파일 작업 이력 출력 (기본 15건) |
| `/undo` | 마지막 파일 수정 되돌리기 |
| `/tree [path]` | 디렉터리 트리 출력 (`--depth N` 지원) |
| `/alias [name] [cmd]` | 별칭 조회·등록 (`-d name`으로 삭제) |
| `/hooks` | 로드된 훅 설정 목록 출력 |
| `/hook-log` | 훅 이벤트 SQLite 로그 조회 (`--event` `--tool` `--limit` `--clear`) |
| `/<skill-name>` | 스킬 직접 실행 |
| `/exit` | CLI 종료 |

### 파일 컨텍스트 대화 (`@`)

`@` 기호로 파일을 첨부하여 AI와 대화할 수 있습니다.

```
KYJ_AI > @package.json 이 파일의 의존성을 분석해줘
```

- 입력 중 `@`를 타이핑하면 즉시 파일 선택 UI가 열립니다. (단어 중간의 `@`는 무시되므로
  `kyj@example.com` 이나 `express@4` 같은 입력은 일반 메시지로 처리됩니다.)
- 경로를 직접 적으면 선택 UI 없이 바로 첨부됩니다. **절대경로도 지원**합니다:
  `@/home/user/proj/lib/tools.js 설명해줘`
- 여러 파일을 동시에 첨부할 수 있습니다: `@index.js @lib/tools.js 비교해줘`

### 멀티라인 입력

`"""` 를 단독으로 입력하면 멀티라인 모드로 전환됩니다. 끝내려면 다시 `"""` 를 입력합니다.

```
KYJ_AI > """
  (멀티라인 모드: 입력 완료 후 새 줄에 """ 입력)
  ... 긴 프롬프트를 여러 줄로 작성
  ... """
```

### execute_code — AI 코드 실행

AI가 직접 Node.js 코드를 작성하고 격리된 샌드박스(`os.tmpdir()/mycli-sandbox/`)에서 실행합니다. 파일 변환, 데이터 가공 등 기존 도구로 처리하기 어려운 작업에 활용됩니다.

```
KYJ_AI > AI_report.md 파일을 Word 문서로 변환해줘
```

AI가 코드를 실행하기 전에 내용을 미리보기로 보여주고 확인을 요청합니다.

### 스킬 시스템

`~/.mycli/skills/` 또는 `./.mycli/skills/` 디렉터리에 스킬을 등록합니다.

```
.mycli/skills/
└── my-skill/
    └── SKILL.md
```

`SKILL.md` 형식:
```markdown
---
name: my-skill
description: 스킬 설명
disable-model-invocation: false
---

$ARGUMENTS 에 대해 분석해주세요.
```

- `$ARGUMENTS`: 슬래시 명령어 실행 시 인자로 치환됩니다.
- `disable-model-invocation: true`: AI 자동 호출 비활성화 (수동 `/명령어`로만 실행).

### MCP 서버 연동

`mcps/` 디렉터리에 JSON 설정 파일을 추가하면 MCP 서버의 도구가 자동으로 로드됩니다.
설정 파일은 **작업 디렉터리(BASE_DIR)와 CLI 실행 경로 양쪽**에서 찾습니다.

**stdio 방식** — `command` 필드를 쓰면 자식 프로세스로 서버를 띄웁니다.

```json
{
  "name": "my-server",
  "command": "node my-mcp-server.js",
  "args": [],
  "timeout": 5000
}
```

**HTTP 방식** — `url` 필드를 쓰면 Streamable HTTP 로 통신합니다.

```json
{
  "name": "remote-server",
  "url": "https://example.com/mcp",
  "token": "YOUR_TOKEN",
  "headers": { "X-Custom": "value" },
  "timeout": 10000
}
```

- `token` 은 `Authorization: Bearer <token>` 헤더로 변환됩니다.
- `headers` 로 헤더를 추가할 수 있습니다 (`token` 보다 우선순위 낮음).
- `timeout` 은 요청 하나당 제한 시간(ms)입니다. 생략 시 stdio 5000 / HTTP 10000.
- JSON 파일에 배열을 넣으면 서버를 여러 개 정의할 수 있습니다.

로드된 MCP 도구는 `mcp_<서버명>_<도구명>` 형태로 AI에게 제공됩니다.

### 계획 모드 (Plan Mode)

복잡한 작업 전에 AI가 먼저 코드베이스를 탐색하고 구현 계획을 수립하도록 강제합니다.

- 계획 모드 진입 시 `write_file`, `execute_shell_command`, `execute_code` 차단
- AI가 `exit_plan_mode`로 계획을 제출하면 사용자가 **승인 / 거절 / 피드백** 선택
- 승인 후에만 실제 구현 진행

### 에이전트 방식

| provider | 방식 | 이유 |
|---|---|---|
| `gemini` · `gpt` · `vllm` | 네이티브 tool calling | 모델이 도구 호출을 구조화된 형태로 직접 내보내므로 파싱 실패가 없고 병렬 호출이 가능 |
| `ollama` | structured chat (JSON) | `gemma2:9b` 등 로컬 모델 상당수가 네이티브 tool calling 미지원 |

도구를 지원하는 Ollama 모델(예: `llama3.1`, `qwen2.5`)을 쓰더라도 현재는 structured 방식으로 동작합니다.

### 컨텍스트 관리

대화가 길어지면 모델의 컨텍스트 한도를 넘어 요청 자체가 실패합니다.
`MYCLI_MAX_CONTEXT_TOKENS`(기본 24000) 를 넘으면 **오래된 대화부터 자동으로 정리**하고 알려줍니다.

- 내용을 버리지 않고 요약해서 남기려면 `/compact` 를 쓰세요.
- `MYCLI_MAX_CONTEXT_TOKENS=0` 으로 자동 정리를 끌 수 있습니다.
- 토큰 수는 `문자수 / 4` 로 추정한 값이며, 실제 토크나이저 기준이 아닙니다.

## ⚙️ 요구 사항

- Node.js v18 이상
- npm

## 🚀 설치 및 설정

### npm으로 전역 설치

```bash
npm install -g @callakrsos/mycli
```

### 소스에서 직접 실행

```bash
git clone <repository-url>
cd mycli
npm install
```

### 환경 변수 설정

`.env` 파일을 생성합니다 (`.env_example` 참고):

```env
# AI 공급자 선택 (gemini | gpt | ollama | vllm), 기본값: gemini
MYCLI_PROVIDER=gemini

# Google Gemini (기본값)
GOOGLE_API_KEY=YOUR_GEMINI_API_KEY

# OpenAI
OPENAI_API_KEY=YOUR_OPENAI_API_KEY

# Ollama (로컬)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma2:9b

# vLLM (OpenAI 호환 API)
VLLM_BASE_URL=http://localhost:8000
VLLM_API_KEY=EMPTY
# 생략하면 /v1/models 의 첫 번째 모델을 자동 감지합니다
VLLM_MODEL=

# 작업 디렉터리 (미설정 시 CLI 실행 경로)
MYCLI_WORKDIR=C:\Users\yourname\workspace

# 훅 이벤트 SQLite 로깅 (기본 활성, false 로 끄기)
MYCLI_HOOK_LOG=true
MYCLI_HOOK_LOG_DB=

# 대화 기록 자동 압축 임계치 (추정 토큰 수, 기본 24000 / 0 이면 비활성)
MYCLI_MAX_CONTEXT_TOKENS=24000
```

`MYCLI_PROVIDER` 를 설정하지 않으면 `GOOGLE_API_KEY` → `OPENAI_API_KEY` → `ollama` 순으로 자동 감지합니다.

## ▶️ 사용법

```bash
# npm 전역 설치 후
mycli

# 소스에서 직접 실행
node index.js
```

## 🔒 보안

- `BASE_DIR` 외부 경로 접근 차단 (`path.relative` 기반 — 접두사가 겹치는 형제 디렉터리도 차단)
- 단 하나의 예외: `read_file` 은 **절대경로**로 지정한 외부 파일을 **사용자 확인(기본값 N)** 후 읽을 수 있음.
  상대경로(`../`)로는 벗어날 수 없고, `write_file`·`edit_file`·`glob_files`·`grep_files`·`@` 첨부는 계속 차단
- 파일을 변경하거나 명령을 실행하기 전에 **항상 사용자 확인**을 받음
  (`write_file`, `edit_file`, `execute_shell_command`, `execute_code`, `install_package`)
- 파일 수정 시 read-before-write 강제 및 외부 수정 감지 (mtime 기반)
- 일부 범위만 읽은 파일의 전체 덮어쓰기 차단 (읽지 않은 내용 손실 방지)
- `install_package`의 패키지명 형식 검증 + 셸을 거치지 않는 실행 (인자 주입 방지)
- `execute_code` 자식 프로세스에서 API 키·토큰 환경변수 제거
- 계획 모드에서 파일 수정·명령 실행 차단

### ⚠️ 보안 한계 (알고 쓰세요)

- `rm`, `sudo`, `shutdown` 등의 **차단 목록은 보조 수단일 뿐 방어선이 아닙니다.**
  구분자(`;`, `&&`, `|`)로 나눈 각 구간의 명령어까지 검사하지만, 차단 목록에 없는
  명령으로 얼마든지 같은 피해를 낼 수 있습니다. **실질적인 안전장치는 실행 전 확인 프롬프트입니다.**
- 작업 디렉터리 밖 파일 읽기를 승인하면 **그 절대경로는 CLI 세션이 끝날 때까지 재확인 없이** 읽힙니다.
  `read_file` 을 호출하는 주체는 사용자가 아니라 LLM이므로, 읽어들인 파일·MCP 응답에 심어진 지시문이
  민감한 경로(`~/.ssh`, `~/.aws`, `.env`)를 읽도록 유도할 수 있습니다. **확인 프롬프트에 뜬 절대경로를 반드시 읽고 승인하세요.**
- `execute_code`의 "샌드박스"는 **별도의 작업 디렉터리일 뿐 격리가 아닙니다.**
  실행되는 코드는 파일 시스템과 네트워크에 제한 없이 접근할 수 있습니다.
  신뢰할 수 없는 내용을 다룰 때는 컨테이너나 VM 안에서 CLI를 실행하세요.

## 📄 라이선스

이 프로젝트는 [Apache 2.0 License](LICENSE.txt)를 따릅니다.
