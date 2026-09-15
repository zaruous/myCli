import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { planModeState } from '../../lib/state.js';

export const packageTool = new DynamicStructuredTool({
  name: 'install_package', description: 'execute_code에서 사용할 npm 패키지를 격리된 샌드박스에 설치합니다. execute_code 호출 전에 필요한 패키지가 있으면 먼저 호출하세요.',
  schema: z.object({ packages: z.array(z.string()).describe('설치할 패키지 이름 목록 (예: ["docx", "marked"])') }),
  func: async ({ packages }) => {
    if (planModeState.active) return '차단됨: 계획 모드 중입니다.';
    const sandboxDir = path.join(os.tmpdir(), 'mycli-sandbox');
    try {
      await fs.mkdir(sandboxDir, { recursive: true });
      const pkgPath = path.join(sandboxDir, 'package.json');
      if (!fssync.existsSync(pkgPath)) await fs.writeFile(pkgPath, JSON.stringify({ name: 'mycli-sandbox', version: '1.0.0', type: 'module' }), 'utf-8');
      console.log(chalk.gray(`[install_package] 설치 중: ${packages.join(', ')} → ${sandboxDir}`));
      const result = await new Promise(resolve => { const child = spawn('npm', ['install', '--prefix', sandboxDir, ...packages], { shell: true, cwd: sandboxDir }); let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data.toString('utf-8'); }); child.stderr.on('data', data => { stderr += data.toString('utf-8'); }); child.on('close', code => resolve({ code, stdout, stderr })); child.on('error', error => resolve({ code: -1, stdout: '', stderr: error.message })); });
      if (result.code !== 0) return `패키지 설치 실패 (exit ${result.code}):\n${result.stderr.trim()}`;
      console.log(chalk.green(`✅ 설치 완료: ${packages.join(', ')}`));
      return `설치 성공: ${packages.join(', ')}\n샌드박스: ${sandboxDir}`;
    } catch (error) { return `install_package 오류: ${error.message}`; }
  },
});
