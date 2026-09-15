import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { getSafePath } from '../../lib/utils.js';
import { planModeState, readFileState } from '../../lib/state.js';
import { confirmPrompt } from '../../lib/ui.js';
import { computeLineDiff, renderDiffWithContext } from '../../lib/diff.js';
import { recordOp } from '../../lib/code-manager.js';

export const writeFileTool = new DynamicStructuredTool({
  name: 'write_file',
  description: '파일을 생성하거나 덮어씁니다. 반드시 read_file로 읽은 후에 사용하세요.',
  schema: z.object({ filePath: z.string().describe('저장할 파일 경로'), content: z.string().describe('저장할 파일의 전체 내용') }),
  func: async ({ filePath, content }) => {
    if (planModeState.active) return '차단됨: 현재 계획 모드(Plan Mode) 중입니다. 파일을 수정하려면 exit_plan_mode로 계획을 제출하고 승인받은 후 진행하세요.';
    try {
      const safePath = getSafePath(filePath);
      let isNew = false, beforeContent = null;
      try {
        const stat = await fs.stat(safePath);
        const readRecord = readFileState.get(safePath);
        if (!readRecord) return `오류: 파일을 먼저 read_file로 읽어야 합니다. (${filePath})`;
        if (Math.floor(stat.mtimeMs) > readRecord.timestamp) return `오류: 마지막 읽기 이후 파일이 외부에서 수정되었습니다. read_file로 다시 읽은 후 시도하세요. (${filePath})`;
      } catch (error) { if (error.code === 'ENOENT') isNew = true; else throw error; }
      let diffDisplay = '';
      if (!isNew) {
        beforeContent = await fs.readFile(safePath, 'utf-8');
        const diffResult = computeLineDiff(beforeContent, content);
        if (!diffResult.some(diff => diff.type !== 'same')) return `변경 없음: 파일 내용이 동일합니다. (${filePath})`;
        diffDisplay = renderDiffWithContext(diffResult);
      } else {
        const lines = content.split('\n');
        const preview = lines.slice(0, 50).map(line => chalk.green(`+ ${line}`)).join('\n');
        diffDisplay = lines.length > 50 ? preview + chalk.gray(`\n  ... (총 ${lines.length}줄, 처음 50줄만 표시)`) : preview;
      }
      console.log(chalk.bold(`\n[${isNew ? '신규 파일' : '파일 변경'}: ${filePath}]`));
      console.log(diffDisplay);
      if (!await confirmPrompt(isNew ? '이 파일을 생성하시겠습니까?' : '이 변경사항을 적용하시겠습니까?')) return `취소됨: 파일 저장이 취소되었습니다. (${filePath})`;
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, content, 'utf-8');
      const newStat = await fs.stat(safePath);
      readFileState.set(safePath, { timestamp: Math.floor(newStat.mtimeMs), isPartial: false });
      recordOp({ type: 'write', filePath: safePath, before: beforeContent, after: content });
      return isNew ? `성공: 파일이 생성되었습니다. (${filePath})` : `성공: 파일이 수정되었습니다. (${filePath})`;
    } catch (error) { return `파일 쓰기 실패: ${error.message}`; }
  },
});
