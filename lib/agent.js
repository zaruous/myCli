/**
 * lib/agent.js
 * LLM 모델 선택, 공유 메모리, AgentExecutor 생성
 */
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
// vLLM은 OpenAI 호환 API이므로 ChatOpenAI에 baseURL만 교체해서 사용
import { AgentExecutor, createStructuredChatAgent } from "@langchain/classic/agents";
import { BufferMemory } from "@langchain/classic/memory";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import 'dotenv/config';

import { baseTools } from './tools.js';

// ─────────────────────────────────────────────────────────
// 공유 메모리 (싱글턴)
// ─────────────────────────────────────────────────────────
export const memory = new BufferMemory({ memoryKey: "chat_history", returnMessages: true });

// ─────────────────────────────────────────────────────────
// 모델 팩토리
// ─────────────────────────────────────────────────────────
export async function getModel(provider) {
  if (provider === 'gemini') {
    return new ChatGoogleGenerativeAI({
      model: "gemini-2.5-flash",
      apiKey: process.env.GOOGLE_API_KEY,
      temperature: 0,
      streaming: true,
    });
  }
  if (provider === 'ollama' || provider === 'llama') {
    return new ChatOllama({
      baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
      model:   process.env.OLLAMA_MODEL    || "gemma2:9b",
      temperature: 0,
    });
  }
  if (provider === 'vllm') {
    const baseURL = (process.env.VLLM_BASE_URL || "http://localhost:8000").replace(/\/$/, '') + '/v1';
    const apiKey  = process.env.VLLM_API_KEY || "EMPTY";
    let modelName = process.env.VLLM_MODEL && process.env.VLLM_MODEL !== 'default'
      ? process.env.VLLM_MODEL
      : null;

    if (!modelName) {
      // VLLM_MODEL 미설정 시 /v1/models 에서 첫 번째 모델 자동 감지
      try {
        const res = await fetch(`${baseURL}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json();
          modelName = data.data?.[0]?.id ?? null;
        } else {
          let body = '';
          try { body = await res.text(); } catch {}
          throw new Error(`vLLM /v1/models 응답 오류 HTTP ${res.status}${body ? ' — ' + body.slice(0, 200) : ''}`);
        }
      } catch (e) {
        throw new Error(`vLLM 모델 자동 감지 실패: ${e.message}\n.env 에서 VLLM_MODEL을 직접 지정하세요.`);
      }
    }

    if (!modelName) throw new Error('vLLM에서 사용 가능한 모델을 찾을 수 없습니다. VLLM_MODEL을 .env에 설정하세요.');

    return new ChatOpenAI({
      modelName,
      apiKey,
      configuration: { baseURL },
      temperature: 0,
      streaming: true,
    });
  }
  // 기본: gpt
  return new ChatOpenAI({
    modelName: "gpt-4o",
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
    streaming: true,
  });
}

// ─────────────────────────────────────────────────────────
// AgentExecutor 생성
// ─────────────────────────────────────────────────────────
export async function createAgentExecutor(projectContext = null, tools = baseTools, skills = [], provider = 'gemini') {
  const model = await getModel(provider);

  const contextSection = projectContext
    ? `\n\n## 프로젝트 컨텍스트\n${projectContext}`
    : '';

  const invokableSkills  = skills.filter(s => !s.disableModelInvocation);
  const skillsSection    = invokableSkills.length > 0
    ? `\n\n## 사용 가능한 스킬\n사용자 요청이 아래 스킬과 일치하면 반드시 use_skill 도구를 먼저 호출하세요 (BLOCKING REQUIREMENT):\n${invokableSkills.map(s => `- ${s.name}: ${s.description}`).join('\n')}\n슬래시 명령어(예: /review, /explain)를 언급하거나 스킬 목록의 작업을 요청할 때는 use_skill을 가장 먼저 호출하세요.`
    : '';

  const promptTemplate = ChatPromptTemplate.fromMessages([
    ['system', `You are a helpful assistant. You have access to tools. Your job is to help the user with their requests. The user is a developer. You should respond in Korean.${contextSection}${skillsSection}

## 계획 모드 (Plan Mode)
다음 조건 중 하나라도 해당하면 구현 전에 반드시 enter_plan_mode를 먼저 호출하세요:
- 여러 파일을 수정해야 하는 비자명한 작업
- 구현 방법이 여러 가지인 경우 (아키텍처 결정 필요)
- 요구사항이 불명확하여 탐색이 먼저 필요한 경우
- 기존 코드에 영향을 주는 리팩터링

단순 작업(오타 수정, 단순 버그 픽스, 명확한 단일 파일 수정)은 계획 모드 없이 바로 진행하세요.
계획 모드 중에는 write_file과 execute_shell_command가 차단됩니다.

## 파일 작업 규칙
- 파일을 수정하기 전에 반드시 read_file로 먼저 읽어야 합니다.
- 파일을 검색할 때는 glob_files(패턴으로 파일 찾기) 또는 grep_files(내용 검색)를 활용하세요.
- grep_files의 output_mode: 'files_with_matches'(파일 목록), 'content'(일치 줄), 'count'(개수)
- 큰 파일은 read_file의 offset/limit으로 일부만 읽으세요.

## 코드 실행 (execute_code / install_package)
기존 도구(read_file, write_file 등)로 처리할 수 없는 작업(파일 형식 변환, 데이터 가공, 외부 라이브러리 활용 등)은 직접 Node.js 코드를 작성해 실행하세요.

규칙:
- 필요한 npm 패키지가 있으면 execute_code 전에 반드시 install_package를 먼저 호출하세요.
- 코드에서 작업 디렉터리 경로는 process.env.MYCLI_WORKDIR 환경변수로 가져오세요.
- 생성한 파일 경로는 반드시 console.log로 출력해서 사용자에게 알려주세요.
- 코드는 단일 목적으로 간결하게 작성하고, 오류 발생 시 명확한 메시지를 출력하세요.
- execute_code 결과(STDOUT/STDERR)를 확인하고 실패 시 코드를 수정해 재시도하세요.
- execute_code 호출 시 packages(사용 패키지), inputFiles(읽을 파일), outputFiles(생성될 파일) 필드를 항상 채우세요. 사용자가 실행 전에 무엇이 일어나는지 명확히 볼 수 있어야 합니다.

You have access to the following tools:

{tools}

To use a tool, please use the following format. The 'action' should be one of [{tool_names}].
 The "action_input" MUST be a JSON object, with keys matching the arguments of the tool.

For example:
{{
\t"action": "tool_name",
\t"action_input": {{
\t\t"arg_name": "arg_value"
\t}}
}}

When you have a response to say to the Human, or if you do not need to use a tool, you MUST use the format:
{{
\t"action": "Final Answer",
\t"action_input": "<your response here>"
}}
`],
    new MessagesPlaceholder("chat_history"),
    ["human", "{input}"],
    new MessagesPlaceholder({ variableName: "agent_scratchpad", optional: true }),
  ]);

  const agent = await createStructuredChatAgent({ llm: model, tools, prompt: promptTemplate });
  return new AgentExecutor({
    agent,
    tools,
    verbose: false,
    maxIterations: 10,
    handleParsingErrors: (e) =>
      `응답 형식이 올바르지 않습니다. 반드시 아래 두 형식 중 하나로만 응답하세요.\n` +
      `도구 사용 시: {"action":"tool_name","action_input":{...}}\n` +
      `최종 답변 시: {"action":"Final Answer","action_input":"<한국어 응답>"}\n` +
      `오류 내용: ${e.message}`,
  });
}
