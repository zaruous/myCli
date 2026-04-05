#!/usr/bin/env node
/**
 * index.js — thin orchestrator
 *
 * 역할: 초기화, handleChat, handleAttach, askQuestion, selectFile
 * 도구 정의  → lib/tools.js
 * 모델/에이전트 → lib/agent.js
 * 슬래시 명령어 → lib/commands.js
 * 스피너      → lib/ui.js
 */
import search from "./search/search/dist/index.js";
import fs from "fs/promises";
import path from "path";
import 'dotenv/config';
import { glob } from 'glob';
import chalk from 'chalk';
import { Command } from 'commander';

import { getBaseDir, planModeState } from './lib/state.js';
import { getSafePath } from './lib/utils.js';
import { loadHistory, saveHistory, getHistory } from './lib/history.js';
import { loadSkills } from './lib/skills.js';
import { loadProjectContext } from './lib/context.js';
import { loadMcpTools } from './lib/mcp.js';
import { loadAliases, resolveAlias, suggestCommand } from './lib/ux-manager.js';
import { startSpinner, updateSpinner, stopSpinner, promptWithHistory, confirmPrompt, inputPrompt } from './lib/ui.js';
import { baseTools } from './lib/tools.js';
import { memory, createAgentExecutor } from './lib/agent.js';
import { registerCommands } from './lib/commands.js';
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

// =========================================================
// startCLI
// =========================================================
async function startCLI() {
  await loadHistory();
  const skills        = await loadSkills();
  const projectContext = await loadProjectContext();
  const mcpTools      = await loadMcpTools();
  await loadAliases();

  if (process.env.MYCLI_WORKDIR) {
    console.log(chalk.gray(`[작업공간] ${getBaseDir()}  (MYCLI_WORKDIR)`));
  }
  if (projectContext) console.log(chalk.gray('[컨텍스트] 프로젝트 컨텍스트 파일이 로드되었습니다.'));
  if (mcpTools.length > 0) console.log(chalk.gray(`[MCP] ${mcpTools.length}개 MCP 도구가 로드되었습니다.`));

  // ── use_skill 도구 (AI → 스킬 호출) ─────────────────────
  const invokableSkillsForTool = skills.filter(s => !s.disableModelInvocation);
  const useSkillTool = invokableSkillsForTool.length > 0
    ? new DynamicStructuredTool({
        name: "use_skill",
        description: "등록된 스킬을 실행합니다. 사용자 요청이 스킬 목록의 작업과 일치하거나, /skill-name 슬래시 명령을 언급할 때 이 도구를 먼저 호출하세요.",
        schema: z.object({
          skill: z.string().describe("실행할 스킬 이름 (예: review, explain). 앞의 '/'는 생략 가능"),
          args:  z.string().optional().describe("스킬에 전달할 인자 (SKILL.md의 $ARGUMENTS로 치환됨)"),
        }),
        func: async ({ skill, args }) => {
          const normalizedName = skill.startsWith('/') ? skill.slice(1) : skill;
          const found = invokableSkillsForTool.find(s => s.name === normalizedName);
          if (!found) {
            const list = invokableSkillsForTool.map(s => `- ${s.name}: ${s.description}`).join('\n');
            return `알 수 없는 스킬: "${normalizedName}"\n\nAI 호출 가능한 스킬:\n${list}`;
          }
          const expanded = found.prompt.replace(/\$ARGUMENTS/g, args || '');
          console.log(chalk.gray(`[스킬] '${found.name}' 실행 중...`));
          return `[스킬 '${found.name}' 로드됨]\n\n${expanded}`;
        },
      })
    : null;

  const tools = [...baseTools, ...mcpTools, ...(useSkillTool ? [useSkillTool] : [])];

  // ── 뮤터블 CLI 상태 ──────────────────────────────────────
  // 기본 provider: 환경변수 > API 키 자동 감지 순서
  let defaultProvider = process.env.MYCLI_PROVIDER || 'gemini';
  if (!process.env.GOOGLE_API_KEY && defaultProvider === 'gemini') {
    if (process.env.OPENAI_API_KEY) defaultProvider = 'gpt';
    else defaultProvider = 'ollama';
    console.log(chalk.yellow(`[경고] GOOGLE_API_KEY 없음 → '${defaultProvider}' 로 자동 전환`));
  }

  const cliState = {
    memory,
    tools,
    skills,
    mcpTools,
    projectContext,
    currentProvider: defaultProvider,
    executor: await createAgentExecutor(projectContext, tools, skills, defaultProvider),
  };

  // ── Commander 초기화 ─────────────────────────────────────
  const program = new Command();
  program.exitOverride();

  // ── 배너 ─────────────────────────────────────────────────
  console.log(chalk.blue.bold(`
 _  __ __   __     _   ____ _     ___
| |/ / \\ \\ / /    | | / ___| |   |_ _|
| ' /   \\ V /  _  | || |   | |    | |
| . \\    | |  | |_| || |___| |___ | |
|_|\\_\\   |_|   \\___/  \\____|_____|___|
`));
  console.log(chalk.green("KYJ CLI에 오신 것을 환영합니다! '/help'를 입력해 명령어를 확인하세요."));
  if (skills.length > 0) {
    console.log(chalk.gray(`[스킬] ${skills.length}개 로드됨: ${skills.map(s => '/' + s.name).join(', ')}`));
  }

  // ── 지연 바인딩 refs (commands.js 가 askQuestion/handleChat 을 사용) ──
  const refs = {};

  // ── 명령어 등록 ──────────────────────────────────────────
  registerCommands(program, cliState, refs);

  // =========================================================
  // handleChat
  // =========================================================
  const handleChat = async (userInput, { skipHistory = false } = {}) => {
    if (!userInput.trim()) { askQuestion(); return; }
    if (!skipHistory) await saveHistory(userInput);

    const controller   = new AbortController();
    const sigintHandler = () => {
      stopSpinner();
      console.log(chalk.yellow('\n[명령어 실행 취소]'));
      controller.abort();
    };

    try {
      process.once('SIGINT', sigintHandler);
      const history = await memory.loadMemoryVariables({});

      startSpinner('생각 중...');
      let finalOutput = '';
      let streaming   = false;

      const eventStream = cliState.executor.streamEvents(
        { input: userInput, chat_history: history.chat_history },
        { version: 'v2', signal: controller.signal }
      );

      for await (const event of eventStream) {
        if (event.event === 'on_tool_start') {
          if (streaming) { process.stdout.write('\n'); streaming = false; }
          updateSpinner(`툴 실행: ${event.name}`);
        } else if (event.event === 'on_tool_end') {
          updateSpinner('생각 중...');
        } else if (event.event === 'on_llm_stream') {
          const raw   = event.data?.chunk?.message?.content ?? '';
          const chunk = Array.isArray(raw)
            ? raw.map(c => (typeof c === 'string' ? c : (c?.text ?? ''))).join('')
            : typeof raw === 'string' ? raw : '';
          if (chunk) {
            if (!streaming) {
              stopSpinner();
              process.stdout.write(`${chalk.blue.bold('🤖:')} `);
              streaming = true;
            }
            process.stdout.write(chunk);
            finalOutput += chunk;
          }
        } else if (event.event === 'on_chain_end' && event.name === 'AgentExecutor') {
          if (!streaming) {
            const raw = event.data?.output?.output ?? event.data?.output ?? '';
            finalOutput = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
          }
        }
      }

      if (streaming) {
        process.stdout.write('\n');
      } else {
        stopSpinner();
        if (finalOutput) process.stdout.write(`${chalk.blue.bold('🤖:')} ${finalOutput}\n`);
      }
      process.stdout.write('\n');
      await memory.saveContext({ input: userInput }, { output: String(finalOutput) });

    } catch (error) {
      stopSpinner();
      if (error.name !== 'AbortError') console.error(chalk.red('❌ 오류 발생:'), error.message);
    } finally {
      process.removeListener('SIGINT', sigintHandler);
      askQuestion();
    }
  };

  // =========================================================
  // handleAttach  (@ 파일 첨부, 다중 지원)
  // =========================================================
  const handleAttach = async (rawInput) => {
    await saveHistory(rawInput);
    const MAX_FILE_SIZE = 1_000_000;

    const tokens    = rawInput.trim().split(/\s+/);
    const atTokens  = tokens.filter(t => t.startsWith('@'));
    const nonAtText = tokens.filter(t => !t.startsWith('@')).join(' ').trim();

    const selectedFiles = [];
    for (const token of atTokens) {
      const keyword = token.length > 1 ? token.slice(1) : '';
      console.log(chalk.gray(`\n파일 선택 중 (키워드: ${keyword || '전체'})...`));
      const file = await selectFile(keyword);
      if (file) selectedFiles.push(file);
    }
    if (atTokens.length === 0) {
      const file = await selectFile('');
      if (file) selectedFiles.push(file);
    }

    if (selectedFiles.length === 0) {
      console.log(chalk.yellow('파일이 선택되지 않았습니다.'));
      askQuestion();
      return;
    }

    const fileSections = [];
    for (const selectedFile of selectedFiles) {
      try {
        const safePath = getSafePath(selectedFile);
        let fileContent = await fs.readFile(safePath, 'utf-8');
        if (fileContent.length > MAX_FILE_SIZE) {
          console.log(chalk.yellow(`경고: '${selectedFile}' 파일이 1MB를 초과하여 앞부분만 사용합니다.`));
          fileContent = fileContent.substring(0, MAX_FILE_SIZE) + '\n... (파일 내용이 너무 길어 뒷부분이 잘렸습니다)';
        }
        fileSections.push(`[파일: ${selectedFile}]\n\`\`\`\n${fileContent}\n\`\`\``);
      } catch (error) {
        console.error(chalk.red(`❌ '${selectedFile}' 파일 읽기 오류:`), error.message);
      }
    }

    if (fileSections.length === 0) { askQuestion(); return; }

    console.log(chalk.gray(`\n${fileSections.length}개 파일 첨부됨: ${selectedFiles.join(', ')}`));

    let question = nonAtText;
    if (!question) {
      question = await inputPrompt(chalk.cyan('첨부된 파일에 대해 질문하세요:'));
    }

    if (!question) {
      console.log(chalk.yellow('질문이 입력되지 않았습니다.'));
      askQuestion();
      return;
    }

    await handleChat(`다음 파일 내용을 참고하여 질문에 답해주세요:\n\n${fileSections.join('\n\n')}\n\n[질문]\n${question}`, { skipHistory: true });
  };

  // =========================================================
  // askQuestion  (메인 REPL 루프)
  // =========================================================
  const askQuestion = async () => {
    try {
      const prompt = planModeState.active
        ? chalk.cyan.bold('KYJ_AI [계획모드] >')
        : chalk.green.bold('KYJ_AI >');
      const slashCmds = program.commands.map(c => '/' + c.name());
      const rawLine = await promptWithHistory(prompt, getHistory(), slashCmds, selectFile);

      // 멀티라인 모드: """ 로 시작하면 종료 """ 까지 수집
      let userInput = rawLine;
      if (rawLine.trim() === '"""') {
        console.log(chalk.gray('  (멀티라인 모드: 입력 완료 후 새 줄에 """ 입력)'));
        const lines = [];
        while (true) {
          const line = await inputPrompt(chalk.gray('  ...'));
          if (line.trim() === '"""') break;
          lines.push(line);
        }
        userInput = lines.join('\n');
        if (!userInput.trim()) { askQuestion(); return; }
      }

      let processInput = userInput.trim();
      const firstArg   = processInput.split(' ')[0];

      if (firstArg.startsWith('/')) {
        // 별칭 해석
        const resolved = resolveAlias(processInput);
        if (resolved) {
          console.log(chalk.gray(`[별칭] ${firstArg} → ${resolved}`));
          processInput = resolved;
        }

        const args = processInput.split(' ');
        try {
          program.parse(args, { from: 'user' });
        } catch (e) {
          if (e.code === 'commander.unknownCommand') {
            const knownCmds = program.commands.map(c => '/' + c.name());
            const suggestion = suggestCommand(args[0], knownCmds);
            if (suggestion) {
              console.log(chalk.yellow(`알 수 없는 명령어: ${args[0]}`));
              console.log(chalk.cyan(`  혹시 이 명령어를 찾으셨나요?  ${chalk.bold(suggestion)}`));
            } else {
              console.log(chalk.yellow(`알 수 없는 명령어: ${args[0]}  (/help 로 목록 확인)`));
            }
            askQuestion();
          } else if (e.code !== 'commander.executeSubCommandAsync') {
            console.error(chalk.red(`명령어 처리 중 오류: ${e.message}`));
            askQuestion();
          }
        }
      } else if (processInput.includes('@')) {
        await handleAttach(userInput);
      } else {
        await handleChat(userInput);
      }

    } catch (error) {
      if (error?.name === 'ExitPromptError') {
        const confirmExit = await confirmPrompt('정말로 종료하시겠습니까?');
        if (confirmExit) {
          console.log(chalk.yellow('프로그램을 종료합니다. 안녕히 계세요!'));
          process.exit(0);
        } else {
          askQuestion();
        }
      } else {
        console.error(chalk.red('오류 발생:'), error);
        askQuestion();
      }
    }
  };

  // refs 완성 — 이후 command action 에서 사용 가능
  refs.handleChat  = handleChat;
  refs.askQuestion = askQuestion;

  // 시작
  if (process.argv.slice(2).length > 0) {
    program.parse(process.argv);
  } else {
    askQuestion();
  }
}

// =========================================================
// selectFile  (@ 첨부용 파일 선택 UI)
// =========================================================
async function selectFile(initialInput = '') {
  const allFiles = await glob('**/*', {
    cwd: getBaseDir(),
    ignore: ['node_modules/**', '.git/**', '*.env', '**/node_modules/**', '**/.git/**', '.m2/**', '.idea/**'],
  });
  const initialFiles = initialInput
    ? allFiles.filter(f => f.toLowerCase().includes(initialInput.toLowerCase()))
    : allFiles;

  return await search({
    message: '첨부할 파일을 선택하세요:',
    source: async (input) => {
      if (input === undefined) return initialFiles;
      if (!input) return allFiles;
      return allFiles.filter(f => f.toLowerCase().includes(input.toLowerCase()));
    },
  });
}

// =========================================================
// 진입점
// =========================================================
if (!process.env.MYCLI_TEST) {
  startCLI();
}

export { baseTools, memory };
