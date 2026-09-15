import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { getBaseDir, planModeState } from '../../lib/state.js';
import { confirmPrompt } from '../../lib/ui.js';

export const codeTool = new DynamicStructuredTool({
  name: 'execute_code', description: 'Node.js 코드를 격리된 샌드박스에서 실행합니다. 파일 변환·데이터 처리 등 기존 도구로 불가능한 작업에 사용하세요. 실행 전 사용자 승인을 받습니다. 코드 내에서 process.env.MYCLI_WORKDIR로 작업 디렉터리에 접근하세요.',
  schema: z.object({ code: z.string().describe('실행할 Node.js 코드 (ESM import 문법 사용 가능)'), description: z.string().describe('이 코드가 무엇을 하는지 한 줄 설명'), packages: z.array(z.string()).optional().describe('코드에서 사용하는 npm 패키지 목록 (install_package 없이 표시 목적)'), inputFiles: z.array(z.string()).optional().describe('읽을 파일 경로 목록 (MYCLI_WORKDIR 기준 상대경로)'), outputFiles: z.array(z.string()).optional().describe('생성될 파일 경로 목록 (MYCLI_WORKDIR 기준 상대경로)'), timeout: z.number().int().positive().optional().describe('타임아웃(ms), 기본값 30000') }),
  func: async ({ code, description, packages, inputFiles, outputFiles, timeout = 30000 }) => {
    if (planModeState.active) return '차단됨: 계획 모드 중입니다.';
    const sandboxDir = path.join(os.tmpdir(), 'mycli-sandbox'), workdir = getBaseDir(), width = 62;
    console.log('\n' + chalk.bold.cyan('┌' + '─'.repeat(width) + '┐'));
    console.log(chalk.bold.cyan('│') + chalk.bold(' 코드 실행 요청'.padEnd(width)) + chalk.bold.cyan('│'));
    console.log(chalk.bold.cyan('├' + '─'.repeat(width) + '┤'));
    console.log(chalk.cyan('│') + chalk.bold(' 목적: ') + description.slice(0, width - 7).padEnd(width - 7) + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.dim(` 환경:  Node.js • 샌드박스: ${sandboxDir}`.slice(0, width).padEnd(width)) + chalk.cyan('│'));
    console.log(chalk.cyan('│') + chalk.dim(` 작업공간: ${workdir}`.slice(0, width).padEnd(width)) + chalk.cyan('│'));
    if (packages?.length) console.log(chalk.cyan('│') + chalk.yellow(` 패키지: ${packages.join(', ')}`.slice(0, width).padEnd(width)) + chalk.cyan('│'));
    if (inputFiles?.length) console.log(chalk.cyan('│') + chalk.dim(` 입력:  ${inputFiles.join(', ')}`.slice(0, width).padEnd(width)) + chalk.cyan('│'));
    if (outputFiles?.length) console.log(chalk.cyan('│') + chalk.green(` 출력:  ${outputFiles.join(', ')}`.slice(0, width).padEnd(width)) + chalk.cyan('│'));
    const lines = code.split('\n');
    console.log(chalk.cyan('│') + chalk.dim(` 코드:  ${lines.length}줄`.padEnd(width)) + chalk.cyan('│'));
    console.log(chalk.bold.cyan('├' + '─'.repeat(width) + '┤'));
    lines.forEach((line, index) => { const lineNo = chalk.dim(`${String(index + 1).padStart(3)} │ `); const content = line.length > width - 6 ? line.slice(0, width - 9) + chalk.dim('...') : line; console.log(chalk.cyan('│') + ' ' + lineNo + content); });
    console.log(chalk.bold.cyan('└' + '─'.repeat(width) + '┘'));
    if (!await confirmPrompt('이 코드를 실행하시겠습니까?')) return '취소됨: 코드 실행이 취소되었습니다.';
    const scriptPath = path.join(sandboxDir, `script-${Date.now()}.mjs`);
    try {
      await fs.mkdir(sandboxDir, { recursive: true });
      const pkgPath = path.join(sandboxDir, 'package.json');
      if (!fssync.existsSync(pkgPath)) await fs.writeFile(pkgPath, JSON.stringify({ name: 'mycli-sandbox', version: '1.0.0', type: 'module' }), 'utf-8');
      await fs.writeFile(scriptPath, code, 'utf-8');
      console.log(chalk.gray(`[execute_code] 실행 중... (타임아웃: ${timeout / 1000}초)`));
      const result = await new Promise(resolve => { const child = spawn('node', [scriptPath], { cwd: sandboxDir, env: { ...process.env, MYCLI_WORKDIR: getBaseDir() }, shell: false }); let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); resolve({ code: -1, stdout, stderr: 'TIMEOUT: 실행 시간 초과' }); }, timeout); child.stdout.on('data', data => { stdout += data.toString('utf-8'); }); child.stderr.on('data', data => { stderr += data.toString('utf-8'); }); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); }); child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: error.message }); }); });
      const output = []; if (result.stdout.trim()) output.push(`STDOUT:\n${result.stdout.trim()}`); if (result.stderr.trim()) output.push(`STDERR:\n${result.stderr.trim()}`);
      if (result.code === 0) { console.log(chalk.green('✅ 실행 완료 (exit 0)')); return `실행 성공 (exit 0):\n${output.join('\n') || '(출력 없음)'}`; }
      return `실행 실패 (exit ${result.code}):\n${output.join('\n')}`;
    } catch (error) { return `execute_code 오류: ${error.message}`; } finally { await fs.unlink(scriptPath).catch(() => {}); }
  },
});
