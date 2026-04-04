/**
 * lib/commands.js
 * 슬래시 명령어 등록 — registerCommands(program, cliState, refs)
 *
 * cliState = {
 *   memory, tools, skills, mcpTools, projectContext,
 *   executor       (get/set — /model·/session-load 에서 교체),
 *   currentProvider (get/set — /model·/session-load 에서 교체),
 * }
 *
 * refs = {
 *   handleChat   : (input: string) => Promise<void>,
 *   askQuestion  : ()              => Promise<void>,
 * }
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';
import chalk from 'chalk';

import { saveHistory } from './history.js';
import { getTimestamp, getSafePath } from './utils.js';
import { getBaseDir, setBaseDir, planModeState } from './state.js';
import { getRecentOps, getUndoCount, undoLastOp } from './code-manager.js';
import { getAliases, saveAlias, deleteAlias, paginate } from './ux-manager.js';
import { getModel, createAgentExecutor } from './agent.js';

/**
 * Commander program 에 모든 슬래시 명령어를 등록합니다.
 *
 * @param {import('commander').Command} program
 * @param {{
 *   memory: import('@langchain/classic/memory').BufferMemory,
 *   tools: any[],
 *   skills: any[],
 *   mcpTools: any[],
 *   projectContext: string|null,
 *   executor: any,
 *   currentProvider: string
 * }} cliState  - 뮤터블 상태 객체 (executor·currentProvider 는 직접 프로퍼티 할당으로 변경)
 * @param {{ handleChat: Function, askQuestion: Function }} refs - 지연 바인딩 함수 참조
 */
export function registerCommands(program, cliState, refs) {
  const { memory, tools, skills, mcpTools, projectContext } = cliState;

  // 편의 래퍼 — 항상 최신 값을 읽도록 refs 를 통해 호출
  const handleChat  = (...args) => refs.handleChat(...args);
  const askQuestion = ()       => refs.askQuestion();

  // ── /help ──────────────────────────────────────────────
  program
    .command('/help')
    .description('사용 가능한 명령어 목록을 출력합니다.')
    .action(async () => {
      const builtinCmds = [
        { cmd: '/help',                desc: '사용 가능한 명령어 목록 출력' },
        { cmd: '/status',              desc: 'BASE_DIR, 모델, 스킬 등 현재 상태 출력' },
        { cmd: '/model [provider]',    desc: '모델 전환 (gemini | gpt | ollama)' },
        { cmd: '/clear',               desc: '대화 기록 초기화' },
        { cmd: '/compact',             desc: '대화 기록을 AI로 요약하여 압축' },
        { cmd: '/list',                desc: '현재 세션 대화 기록 출력' },
        { cmd: '/save',                desc: '대화 내용을 Markdown 파일로 저장' },
        { cmd: '/session-save [name]', desc: '세션을 JSON으로 저장' },
        { cmd: '/session-load [name]', desc: '저장된 세션 불러오기 (생략 시 목록)' },
        { cmd: '/basedir <path>',      desc: '작업 디렉터리 변경' },
        { cmd: '/plan',                desc: '계획 모드 진입' },
        { cmd: '/plan-exit',           desc: '계획 모드 종료 및 계획 제출' },
        { cmd: '/plan-status',         desc: '계획 모드 상태 확인' },
        { cmd: '/recent [n]',          desc: '최근 파일 작업 이력 출력 (기본 15건)' },
        { cmd: '/undo',                desc: '마지막 파일 수정 되돌리기' },
        { cmd: '/tree [path]',         desc: '디렉터리 트리 출력 (--depth N 지원)' },
        { cmd: '/alias [name] [cmd]',  desc: '별칭 조회·등록 (-d name 으로 삭제)' },
        { cmd: '/exit',                desc: 'CLI 종료' },
      ];

      console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(chalk.bold.cyan('  KYJ CLI 명령어 목록'));
      console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(chalk.bold('\n[기본 명령어]'));
      for (const { cmd, desc } of builtinCmds) {
        console.log(`  ${chalk.green(cmd.padEnd(22))} ${desc}`);
      }
      if (skills.length > 0) {
        console.log(chalk.bold('\n[스킬]'));
        for (const s of skills) {
          const tag = s.disableModelInvocation ? chalk.gray('[수동]') : chalk.blue('[AI]  ');
          console.log(`  ${tag} ${chalk.green(('/' + s.name).padEnd(20))} ${s.description}`);
        }
      }
      console.log(chalk.bold('\n[입력 방식]'));
      console.log(`  ${chalk.green('@<파일명>'.padEnd(22))} 파일을 첨부하여 질문`);
      console.log(`  ${chalk.green('<일반 텍스트>'.padEnd(22))} AI에게 메시지 전송`);
      console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

      await saveHistory('/help');
      askQuestion();
    });

  // ── /clear ──────────────────────────────────────────────
  program
    .command('/clear')
    .description('현재까지의 대화 내용을 모두 지웁니다.')
    .action(async () => {
      await memory.clear();
      console.log(chalk.yellow('✅ 채팅 기록이 지워졌습니다.'));
      askQuestion();
    });

  // ── /basedir ────────────────────────────────────────────
  program
    .command('/basedir <path>')
    .description('작업 디렉터리(BASE_DIR)를 변경합니다.')
    .action(async (newPath) => {
      try {
        const absolutePath = path.resolve(getBaseDir(), newPath);
        const stats = await fs.stat(absolutePath);
        if (stats.isDirectory()) {
          setBaseDir(absolutePath);
          console.log(chalk.yellow(`✅ BASE_DIR이 변경되었습니다: ${absolutePath}`));
        } else {
          console.error(chalk.red('❌ 오류: 지정한 경로가 디렉터리가 아닙니다.'));
        }
      } catch (error) {
        console.error(chalk.red(`❌ 오류: 경로를 찾을 수 없거나 접근할 수 없습니다: ${error.message}`));
      }
      await saveHistory(`/basedir ${newPath}`);
      askQuestion();
    });

  // ── /save ───────────────────────────────────────────────
  program
    .command('/save')
    .description('현재까지의 대화 내용을 Markdown 파일로 저장합니다.')
    .action(async () => {
      const timestamp = getTimestamp();
      const fileName  = `chathistory_${timestamp}.md`;
      const historyData = await memory.loadMemoryVariables({});
      const messages  = historyData.chat_history || [];

      if (messages.length === 0) {
        console.log(chalk.yellow('✅ 채팅 기록이 없습니다.'));
      } else {
        let formattedHistory = `# 📝 채팅 기록 (${timestamp})\n\n`;
        messages.forEach(message => {
          const type    = message._getType();
          const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2);
          if (type === 'human') formattedHistory += `**🧑 Human:**\n${content}\n\n---\n\n`;
          else if (type === 'ai') formattedHistory += `**🤖 AI:**\n${content}\n\n---\n\n`;
        });
        try {
          const safePath = getSafePath(fileName);
          await fs.writeFile(safePath, formattedHistory, 'utf-8');
          console.log(chalk.yellow(`✅ 채팅 기록이 '${safePath}' 파일로 저장되었습니다.`));
        } catch (error) {
          console.error(chalk.red('❌ 파일 저장 중 오류가 발생했습니다:'), error.message);
        }
      }
      await saveHistory('/save');
      askQuestion();
    });

  // ── /list ───────────────────────────────────────────────
  program
    .command('/list')
    .description('현재까지의 대화 내용을 콘솔에 출력합니다.')
    .action(async () => {
      const historyData = await memory.loadMemoryVariables({});
      const messages    = historyData.chat_history || [];

      if (messages.length === 0) {
        console.log(chalk.yellow('✅ 채팅 기록이 없습니다.'));
      } else {
        const lines = [chalk.bold('\n--- 📝 채팅 기록 ---')];
        messages.forEach(message => {
          const type    = message._getType();
          const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2);
          if (type === 'human') lines.push(`\n🧑 Human:\n${content}`);
          else if (type === 'ai') lines.push(`\n🤖 AI:\n${content}`);
        });
        lines.push(chalk.bold('\n--- 기록 끝 ---\n'));
        await paginate(lines.join('\n'), 20);
      }
      await saveHistory('/list');
      askQuestion();
    });

  // ── /exit ───────────────────────────────────────────────
  program
    .command('/exit')
    .description('CLI 에이전트를 종료합니다.')
    .action(() => {
      console.log(chalk.yellow('프로그램을 종료합니다. 안녕히 계세요!'));
      process.exit(0);
    });

  // ── /plan ───────────────────────────────────────────────
  program
    .command('/plan')
    .description('계획 모드(Plan Mode)에 진입합니다. 복잡한 작업 전에 탐색/설계 단계로 전환합니다.')
    .action(async () => {
      if (planModeState.active) {
        console.log(chalk.yellow('이미 계획 모드 중입니다. /plan-exit 으로 계획을 제출하세요.'));
      } else {
        planModeState.active    = true;
        planModeState.enteredAt = new Date();
        console.log(chalk.cyan('\n[계획 모드 진입]'));
        console.log(chalk.gray('  • write_file, execute_shell_command 차단됨'));
        console.log(chalk.gray('  • glob_files, grep_files, read_file로 코드베이스를 탐색하세요'));
        console.log(chalk.gray('  • 계획이 준비되면 /plan-exit 또는 exit_plan_mode 도구를 사용하세요'));
      }
      await saveHistory('/plan');
      askQuestion();
    });

  // ── /plan-exit ──────────────────────────────────────────
  program
    .command('/plan-exit')
    .description('계획 모드를 종료합니다.')
    .action(async () => {
      if (!planModeState.active) {
        console.log(chalk.yellow('계획 모드 중이 아닙니다. /plan 으로 먼저 진입하세요.'));
      } else {
        planModeState.active    = false;
        planModeState.enteredAt = null;
        console.log(chalk.green('✅ 계획 모드를 종료합니다. 일반 모드로 전환되었습니다.'));
      }
      await saveHistory('/plan-exit');
      askQuestion();
    });

  // ── /plan-status ────────────────────────────────────────
  program
    .command('/plan-status')
    .description('현재 계획 모드 상태를 확인합니다.')
    .action(async () => {
      if (planModeState.active) {
        const elapsed = planModeState.enteredAt
          ? Math.round((Date.now() - planModeState.enteredAt) / 1000)
          : 0;
        console.log(chalk.cyan(`[계획 모드 활성] 경과 시간: ${elapsed}초`));
        console.log(chalk.gray('  write_file, execute_shell_command 차단 중'));
      } else {
        console.log(chalk.gray('[일반 모드] 계획 모드 비활성'));
      }
      await saveHistory('/plan-status');
      askQuestion();
    });

  // ── /model ──────────────────────────────────────────────
  program
    .command('/model [provider]')
    .description('AI 모델을 전환합니다. provider: gemini | gpt | ollama')
    .action(async (provider) => {
      const valid = ['gemini', 'gpt', 'ollama'];
      if (!provider) {
        console.log(chalk.bold('\n사용 가능한 모델:'));
        for (const p of valid) {
          const mark = p === cliState.currentProvider ? chalk.green('▶') : ' ';
          console.log(`  ${mark} ${p}`);
        }
        console.log();
        await saveHistory('/model');
        askQuestion();
        return;
      }
      if (!valid.includes(provider)) {
        console.log(chalk.red(`❌ 알 수 없는 provider: ${provider}. (gemini | gpt | ollama)`));
        await saveHistory(`/model ${provider}`);
        askQuestion();
        return;
      }
      if (provider === cliState.currentProvider) {
        console.log(chalk.yellow(`이미 ${provider} 모델을 사용 중입니다.`));
        await saveHistory(`/model ${provider}`);
        askQuestion();
        return;
      }
      try {
        process.stdout.write(chalk.gray(`모델 전환 중: ${cliState.currentProvider} → ${provider} ...`));
        cliState.currentProvider = provider;
        cliState.executor = await createAgentExecutor(projectContext, tools, skills, provider);
        process.stdout.write('\r' + ' '.repeat(50) + '\r');
        console.log(chalk.green(`✅ 모델이 ${provider}로 전환되었습니다.`));
      } catch (e) {
        console.error(chalk.red(`❌ 모델 전환 실패: ${e.message}`));
      }
      await saveHistory(`/model ${provider}`);
      askQuestion();
    });

  // ── /status ─────────────────────────────────────────────
  program
    .command('/status')
    .description('현재 CLI 상태를 출력합니다.')
    .action(async () => {
      const historyData = await memory.loadMemoryVariables({});
      const msgCount    = (historyData.chat_history || []).length;
      const estTokens   = (historyData.chat_history || [])
        .reduce((sum, m) => sum + Math.ceil(
          (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).length / 4
        ), 0);

      console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(chalk.bold.cyan('  KYJ CLI 현재 상태'));
      console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(`  ${'BASE_DIR'.padEnd(14)} ${chalk.yellow(getBaseDir())}`);
      console.log(`  ${'모델'.padEnd(14)} ${chalk.yellow(cliState.currentProvider)}`);
      console.log(`  ${'계획 모드'.padEnd(14)} ${planModeState.active ? chalk.cyan('활성') : chalk.gray('비활성')}`);
      console.log(`  ${'대화 메시지'.padEnd(14)} ${chalk.yellow(msgCount + '개')} (약 ${estTokens} 토큰)`);
      console.log(`  ${'스킬'.padEnd(14)} ${skills.length > 0 ? chalk.yellow(skills.map(s => '/' + s.name).join(', ')) : chalk.gray('없음')}`);
      console.log(`  ${'MCP 도구'.padEnd(14)} ${mcpTools.length > 0 ? chalk.yellow(mcpTools.length + '개') : chalk.gray('없음')}`);
      console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

      await saveHistory('/status');
      askQuestion();
    });

  // ── /compact ────────────────────────────────────────────
  program
    .command('/compact')
    .description('대화 기록을 AI로 요약하여 컨텍스트를 압축합니다.')
    .action(async () => {
      const historyData = await memory.loadMemoryVariables({});
      const messages    = historyData.chat_history || [];
      if (messages.length < 4) {
        console.log(chalk.yellow('대화 기록이 너무 짧아 압축이 필요하지 않습니다.'));
        await saveHistory('/compact');
        askQuestion();
        return;
      }

      process.stdout.write(chalk.gray('대화 기록 요약 중...'));
      try {
        const model = getModel(cliState.currentProvider);
        const historyText = messages.map(m => {
          const type    = m._getType();
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return `[${type === 'human' ? '사용자' : 'AI'}]: ${content}`;
        }).join('\n\n');

        const summaryResponse = await model.invoke(
          `다음 대화 기록을 핵심 내용 위주로 간결하게 한국어로 요약해주세요. 중요한 결정사항, 작업 내역, 현재 컨텍스트를 보존해주세요:\n\n${historyText}`
        );
        const summary = typeof summaryResponse.content === 'string'
          ? summaryResponse.content
          : JSON.stringify(summaryResponse.content);

        await memory.clear();
        await memory.saveContext({ input: '[이전 대화 요약]' }, { output: summary });

        process.stdout.write('\r' + ' '.repeat(30) + '\r');
        console.log(chalk.green(`✅ 대화 기록이 압축되었습니다. (${messages.length}개 메시지 → 요약 1개)`));
        console.log(chalk.gray('\n요약 내용:'));
        console.log(chalk.gray(summary));
        console.log();
      } catch (e) {
        process.stdout.write('\r' + ' '.repeat(30) + '\r');
        console.error(chalk.red(`❌ 요약 실패: ${e.message}`));
      }
      await saveHistory('/compact');
      askQuestion();
    });

  // ── /session-save ────────────────────────────────────────
  program
    .command('/session-save [name]')
    .description('현재 대화 세션을 JSON으로 저장합니다. name 생략 시 타임스탬프로 저장.')
    .action(async (name) => {
      const historyData = await memory.loadMemoryVariables({});
      const messages    = historyData.chat_history || [];
      if (messages.length === 0) {
        console.log(chalk.yellow('저장할 대화 기록이 없습니다.'));
        await saveHistory('/session-save');
        askQuestion();
        return;
      }

      const sessionDir  = path.join(os.homedir(), '.mycli', 'sessions');
      await fs.mkdir(sessionDir, { recursive: true });

      const fileName    = `${name || getTimestamp()}.json`;
      const filePath    = path.join(sessionDir, fileName);
      const sessionData = {
        version: 1,
        provider: cliState.currentProvider,
        baseDir: getBaseDir(),
        savedAt: new Date().toISOString(),
        messages: messages.map(m => ({
          type:    m._getType(),
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
      };

      try {
        await fs.writeFile(filePath, JSON.stringify(sessionData, null, 2), 'utf-8');
        console.log(chalk.green(`✅ 세션이 저장되었습니다: ${filePath}`));
      } catch (e) {
        console.error(chalk.red(`❌ 세션 저장 실패: ${e.message}`));
      }
      await saveHistory(`/session-save ${name || ''}`);
      askQuestion();
    });

  // ── /session-load ────────────────────────────────────────
  program
    .command('/session-load [name]')
    .description('저장된 세션을 불러옵니다. name 생략 시 목록을 표시합니다.')
    .action(async (name) => {
      const sessionDir = path.join(os.homedir(), '.mycli', 'sessions');

      if (!name) {
        let files;
        try { files = (await fs.readdir(sessionDir)).filter(f => f.endsWith('.json')); }
        catch { files = []; }
        if (files.length === 0) {
          console.log(chalk.yellow('저장된 세션이 없습니다.'));
        } else {
          console.log(chalk.bold('\n저장된 세션:'));
          for (const f of files) console.log(`  ${chalk.green(f.replace('.json', ''))}`);
          console.log();
        }
        await saveHistory('/session-load');
        askQuestion();
        return;
      }

      const fileName = name.endsWith('.json') ? name : `${name}.json`;
      const filePath = path.join(sessionDir, fileName);
      try {
        const raw         = await fs.readFile(filePath, 'utf-8');
        const sessionData = JSON.parse(raw);

        await memory.clear();
        for (let i = 0; i < sessionData.messages.length - 1; i += 2) {
          const human = sessionData.messages[i];
          const ai    = sessionData.messages[i + 1];
          if (human && ai) await memory.saveContext({ input: human.content }, { output: ai.content });
        }

        if (sessionData.provider && sessionData.provider !== cliState.currentProvider) {
          cliState.currentProvider = sessionData.provider;
          cliState.executor = await createAgentExecutor(projectContext, tools, skills, cliState.currentProvider);
        }

        console.log(chalk.green(`✅ 세션을 불러왔습니다: ${fileName}`));
        console.log(chalk.gray(`   저장 시각: ${sessionData.savedAt}`));
        console.log(chalk.gray(`   메시지: ${sessionData.messages.length}개 / 모델: ${sessionData.provider}`));
      } catch (e) {
        if (e.code === 'ENOENT') console.error(chalk.red(`❌ 세션 파일을 찾을 수 없습니다: ${fileName}`));
        else console.error(chalk.red(`❌ 세션 로드 실패: ${e.message}`));
      }
      await saveHistory(`/session-load ${name}`);
      askQuestion();
    });

  // ── /recent ──────────────────────────────────────────────
  program
    .command('/recent [n]')
    .description('최근 파일 작업 이력을 출력합니다.')
    .action(async (n) => {
      const count = parseInt(n, 10) || 15;
      const ops   = getRecentOps(count);

      if (ops.length === 0) {
        console.log(chalk.yellow('아직 파일 작업 이력이 없습니다.'));
        await saveHistory('/recent');
        askQuestion();
        return;
      }

      const typeIcon  = { read: chalk.blue('📖 읽기'), write: chalk.green('✏️  쓰기'), edit: chalk.cyan('🔧 편집') };
      const typeColor = { read: chalk.blue, write: chalk.green, edit: chalk.cyan };

      console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(chalk.bold.cyan('  최근 파일 작업 이력'));
      console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      ops.forEach((op, i) => {
        const time    = new Date(op.timestamp).toLocaleTimeString('ko-KR');
        const icon    = typeIcon[op.type] ?? op.type;
        const relPath = path.relative(getBaseDir(), op.filePath) || op.filePath;
        console.log(`  ${chalk.gray(String(i + 1).padStart(2))}  ${icon}  ${typeColor[op.type]?.(relPath) ?? relPath}  ${chalk.gray(time)}`);
      });
      const undoCnt = getUndoCount();
      console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(chalk.gray(`  되돌리기 가능: ${undoCnt}건  (/undo 로 마지막 수정 취소)\n`));

      await saveHistory('/recent');
      askQuestion();
    });

  // ── /undo ────────────────────────────────────────────────
  program
    .command('/undo')
    .description('마지막 파일 수정을 되돌립니다.')
    .action(async () => {
      if (getUndoCount() === 0) {
        console.log(chalk.yellow('되돌릴 작업이 없습니다.'));
        await saveHistory('/undo');
        askQuestion();
        return;
      }

      const { confirmed } = await inquirer.prompt([{
        type: 'confirm', name: 'confirmed',
        message: `마지막 파일 수정을 되돌리시겠습니까? (${getUndoCount()}건 남음)`,
        default: true,
      }]);

      if (!confirmed) {
        console.log(chalk.gray('취소했습니다.'));
        await saveHistory('/undo');
        askQuestion();
        return;
      }

      try {
        const result = await undoLastOp();
        const rel    = path.relative(getBaseDir(), result.filePath);
        if (result.action === 'deleted')  console.log(chalk.green(`✅ 되돌리기 완료: 신규 파일 삭제 → ${rel}`));
        else                              console.log(chalk.green(`✅ 되돌리기 완료: 이전 내용 복원 → ${rel}`));
      } catch (e) {
        console.error(chalk.red(`❌ 되돌리기 실패: ${e.message}`));
      }
      await saveHistory('/undo');
      askQuestion();
    });

  // ── /tree ────────────────────────────────────────────────
  program
    .command('/tree [targetPath]')
    .description('디렉터리 트리를 출력합니다. --depth N 으로 깊이 제한.')
    .option('--depth <n>', '최대 깊이 (기본 3)', '3')
    .action(async (targetPath, opts) => {
      const maxDepth = parseInt(opts.depth, 10) || 3;
      const IGNORE   = new Set(['node_modules', '.git', '.idea', '.vscode', 'dist', 'coverage', '__pycache__']);
      const rootDir  = targetPath ? path.resolve(getBaseDir(), targetPath) : getBaseDir();

      async function buildTree(dir, prefix, depth) {
        if (depth > maxDepth) return '';
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); }
        catch { return ''; }
        const filtered = entries
          .filter(e => !IGNORE.has(e.name) && !e.name.startsWith('.'))
          .sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
        let out = '';
        for (let i = 0; i < filtered.length; i++) {
          const e = filtered[i];
          const isLast    = i === filtered.length - 1;
          const connector  = isLast ? '└── ' : '├── ';
          const nextPrefix = prefix + (isLast ? '    ' : '│   ');
          const label      = e.isDirectory() ? chalk.cyan.bold(e.name + '/') : e.name;
          out += `${prefix}${connector}${label}\n`;
          if (e.isDirectory()) out += await buildTree(path.join(dir, e.name), nextPrefix, depth + 1);
        }
        return out;
      }

      try {
        const rootLabel = chalk.cyan.bold(path.relative(getBaseDir(), rootDir) || path.basename(rootDir)) + '/';
        const tree      = await buildTree(rootDir, '', 1);
        await paginate(`${rootLabel}\n${tree}`, 30);
      } catch (e) {
        console.error(chalk.red(`❌ 트리 출력 실패: ${e.message}`));
      }
      await saveHistory(`/tree ${targetPath || ''}`);
      askQuestion();
    });

  // ── /alias ───────────────────────────────────────────────
  program
    .command('/alias [name] [command...]')
    .description('별칭을 조회·등록합니다. "/alias -d name" 으로 삭제.')
    .option('-d, --delete <name>', '별칭 삭제')
    .action(async (name, commandParts, opts) => {
      if (opts.delete) {
        const deleted = await deleteAlias(opts.delete);
        console.log(deleted
          ? chalk.green(`✅ 별칭 '${opts.delete}' 삭제 완료`)
          : chalk.yellow(`'${opts.delete}' 별칭이 없습니다.`));
        await saveHistory(`/alias -d ${opts.delete}`);
        askQuestion();
        return;
      }

      if (!name) {
        const entries = Object.entries(getAliases());
        console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        console.log(chalk.bold.cyan('  등록된 별칭'));
        console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
        if (entries.length === 0) {
          console.log(chalk.gray('  등록된 별칭이 없습니다.'));
          console.log(chalk.gray('  사용법: /alias <이름> <명령어>'));
          console.log(chalk.gray('  예시:   /alias ss /session-save'));
        } else {
          for (const [alias, cmd] of entries) console.log(`  ${chalk.green(('/' + alias).padEnd(16))} → ${chalk.yellow(cmd)}`);
        }
        console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
        await saveHistory('/alias');
        askQuestion();
        return;
      }

      if (!commandParts || commandParts.length === 0) {
        console.log(chalk.red('❌ 매핑할 명령어를 입력하세요. 예: /alias ss /session-save'));
        await saveHistory(`/alias ${name}`);
        askQuestion();
        return;
      }
      const cmd = commandParts.join(' ');
      await saveAlias(name, cmd);
      console.log(chalk.green(`✅ 별칭 등록: /${name}  →  ${cmd}`));
      await saveHistory(`/alias ${name} ${cmd}`);
      askQuestion();
    });

  // ── Skill 동적 등록 ─────────────────────────────────────
  for (const skill of skills) {
    program
      .command(`/${skill.name} [args...]`)
      .description(skill.description)
      .action(async (args) => {
        const argsStr     = Array.isArray(args) ? args.join(' ') : (args || '');
        const finalPrompt = skill.prompt.replace(/\$ARGUMENTS/g, argsStr);
        await saveHistory(`/${skill.name} ${argsStr}`.trim());
        await handleChat(finalPrompt);
      });
  }
}
