/**
 * lib/agent.js
 * LLM 모델 선택, 공유 메모리, AgentExecutor 생성
 */
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
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
export function getModel(provider) {
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
  const model = getModel(provider);

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
  return new AgentExecutor({ agent, tools, verbose: false, maxIterations: 10, handleParsingErrors: true });
}
