import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { getBaseDir, planModeState } from '../../lib/state.js';

export const shellTool = new DynamicStructuredTool({
  name: 'execute_shell_command',
  description: '터미널(셸) 명령어를 실행하고 결과를 반환합니다. ipconfig, ls, pwd, date 같은 시스템 확인용 명령에 사용하세요.',
  schema: z.object({ command: z.string().describe('실행할 셸 명령어 (예: ipconfig)') }),
  func: async ({ command }) => {
    if (planModeState.active) return '차단됨: 현재 계획 모드(Plan Mode) 중입니다. 시스템 명령어는 계획 승인 후 실행하세요.';
    const blocklist = ['rm', 'del', 'sudo', 'su', 'shutdown', 'reboot'];
    const commandBase = command.split(' ')[0];
    if (blocklist.includes(commandBase)) return `에러: 보안상의 이유로 '${commandBase}' 명령어는 실행할 수 없습니다.`;
    console.log(chalk.gray(`[툴 실행] 셸 명령어 실행: ${command}`));
    return new Promise(resolve => {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', `chcp 65001 > $null; ${command}`], { cwd: getBaseDir() });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data.toString('utf-8'); });
      child.stderr.on('data', data => { stderr += data.toString('utf-8'); });
      child.on('close', code => { let output = `종료 코드: ${code}\n`; if (stdout.trim()) output += `STDOUT:\n${stdout.trim()}\n`; if (stderr.trim()) output += `STDERR:\n${stderr.trim()}\n`; resolve(code === 0 ? `명령어 실행 성공:\n${output}` : `명령어 실행 중 에러 발생:\n${output}`); });
      child.on('error', error => resolve(`명령어 실행 실패: ${error.message}`));
    });
  },
});
