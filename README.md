# MyCLI - AI 기반 CLI 에이전트

`MyCLI`는 LangChain.js를 기반으로 구축된 대화형 AI 커맨드 라인 에이전트입니다. Google Gemini, OpenAI, Ollama 등 다양한 언어 모델을 지원하며, 파일 시스템 탐색·수정, 셸 명령어 실행, MCP 서버 연동, 스킬 시스템 등 개발 작업에 필요한 도구를 제공합니다.

## 프로젝트 구조

```
mycli/
├── index.js          # 메인 진입점 (에이전트, 도구 정의, CLI 루프)
├── lib/
│   ├── state.js      # 공유 상태 (BASE_DIR, planModeState, readFileState)
│   ├── utils.js      # 보안 유틸리티 (getSafePath, getTimestamp)
│   ├── history.js    # 명령어 히스토리 관리
│   ├── skills.js     # 스킬 시스템 (SKILL.md 로드)
│   ├── context.js    # 프로젝트 컨텍스트 파일 로드
│   ├── diff.js       # LCS 기반 라인 diff 유틸리티
│   └── mcp.js        # MCP(Model Context Protocol) 클라이언트
├── mcps/             # MCP 서버 설정 파일 (*.json)
└── .mycli/
    └── skills/       # 로컬 스킬 디렉터리
```

## ✨ 주요 기능

### AI 도구
- **`read_file`**: 파일 내용을 읽습니다. `offset`/`limit`으로 줄 범위 지정 가능.
- **`write_file`**: 파일을 생성하거나 수정합니다. read-before-write 강제, diff 미리보기 후 확인.
- **`glob_files`**: 글로브 패턴으로 파일을 검색합니다 (최근 수정 순 정렬).
- **`grep_files`**: 정규식으로 파일 내용을 검색합니다. ripgrep 우선, JS 폴백 지원.
- **`execute_shell_command`**: 안전 모드에서 셸 명령어를 실행합니다.
- **`enter_plan_mode` / `exit_plan_mode`**: 계획 모드 진입/종료. 계획 모드에서는 파일 수정·명령 실행이 차단됩니다.
- **`use_skill`**: 등록된 스킬을 AI가 직접 호출합니다.

### 슬래시 명령어
| 명령어 | 설명 |
|--------|------|
| `/help` | 사용 가능한 명령어 목록 출력 |
| `/list` | 현재 세션 대화 기록 출력 |
| `/save` | 대화 내용을 Markdown 파일로 저장 |
| `/clear` | 대화 기록 초기화 |
| `/basedir <path>` | 작업 디렉터리(BASE_DIR) 변경 |
| `/plan` | 계획 모드 진입 |
| `/plan-exit` | 계획 모드 종료 및 AI에게 계획 제출 요청 |
| `/plan-status` | 계획 모드 상태 확인 |
| `/<skill-name>` | 스킬 직접 실행 |
| `/exit` | CLI 종료 |

### 파일 컨텍스트 대화 (`@`)
`@` 기호로 파일을 첨부하여 질문할 수 있습니다.
```
KYJ_AI > @package.json
```
파일 선택 UI가 열리고, 선택 후 해당 파일 내용을 컨텍스트로 질문할 수 있습니다.

### 스킬 시스템
`~/.mycli/skills/` 또는 `./.mycli/skills/` 디렉터리에 스킬을 등록할 수 있습니다.

각 스킬은 디렉터리 안의 `SKILL.md` 파일로 정의됩니다:
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
- `disable-model-invocation: true`: AI 자동 호출을 비활성화하고 수동 `/명령어`로만 실행합니다.

### MCP 서버 연동
`mcps/` 디렉터리에 JSON 설정 파일을 추가하면 MCP 서버의 도구가 자동으로 로드됩니다.

```json
{
  "name": "my-server",
  "command": "node my-mcp-server.js",
  "args": []
}
```

로드된 MCP 도구는 `mcp_<서버명>_<도구명>` 형태로 AI에게 제공됩니다.

### 계획 모드 (Plan Mode)
복잡한 작업 전에 AI가 먼저 코드베이스를 탐색하고 구현 계획을 수립하도록 강제합니다.

- 계획 모드 진입 시 `write_file`, `execute_shell_command` 차단
- AI가 `exit_plan_mode`로 계획을 제출하면 사용자가 승인/거절/피드백 선택
- 승인 후에만 실제 구현 진행

## ⚙️ 요구 사항

- Node.js v18 이상
- npm

## 🚀 설치 및 설정

1. **의존성 설치**:
   ```bash
   git clone <repository-url>
   cd mycli
   npm install
   ```

2. **환경 변수 설정**:
   `.env` 파일을 생성하고 사용할 AI 공급자의 API 키를 설정합니다.

   - **Google Gemini** (기본값):
     ```
     GOOGLE_API_KEY="YOUR_GEMINI_API_KEY"
     ```
   - **OpenAI**:
     ```
     OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
     ```
   - **Ollama**:
     ```
     OLLAMA_BASE_URL="http://localhost:11434"
     OLLAMA_MODEL="gemma2:9b"
     ```

## ▶️ 사용법

```bash
node index.js
```

또는 전역 설치 후:
```bash
npm install -g .
mycli
```

## 🔒 보안

- `BASE_DIR` 외부 경로 접근 차단
- `rm`, `del`, `sudo`, `shutdown` 등 위험 명령어 차단
- 파일 수정 시 read-before-write 강제 및 외부 수정 감지 (mtime 기반)
- 계획 모드에서 파일 수정·명령 실행 차단

## 📄 라이선스

이 프로젝트는 [Apache 2.0 License](LICENSE.txt)를 따릅니다.
