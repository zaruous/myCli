import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs/promises';
import chalk from 'chalk';
import { getSafePath } from '../../lib/utils.js';
import { planModeState, readFileState } from '../../lib/state.js';
import { confirmPrompt } from '../../lib/ui.js';
import { computeLineDiff, renderDiffWithContext } from '../../lib/diff.js';
import { recordOp } from '../../lib/code-manager.js';

export const editFileTool = new DynamicStructuredTool({
  name: 'edit_file',
  description: '파일의 특정 부분만 수정합니다. old_string을 new_string으로 교체합니다. 반드시 read_file로 읽은 후에 사용하세요. old_string은 파일 내에서 유일한 문자열이어야 합니다.',
  schema: z.object({ filePath: z.string().describe('수정할 파일 경로'), old_string: z.string().describe('교체할 기존 문자열 (파일 내에서 정확히 한 번만 등장해야 함)'), new_string: z.string().describe('교체될 새 문자열'), replace_all: z.boolean().optional().describe('true이면 old_string의 모든 등장을 교체 (기본값: false)') }),
  func: async ({ filePath, old_string, new_string, replace_all = false }) => {
    if (planModeState.active) return '차단됨: 현재 계획 모드(Plan Mode) 중입니다.';
    try {
      const safePath = getSafePath(filePath), readRecord = readFileState.get(safePath);
      if (!readRecord) return `오류: 파일을 먼저 read_file로 읽어야 합니다. (${filePath})`;
      const stat = await fs.stat(safePath);
      if (Math.floor(stat.mtimeMs) > readRecord.timestamp) return `오류: 마지막 읽기 이후 파일이 외부에서 수정되었습니다. read_file로 다시 읽은 후 시도하세요. (${filePath})`;
      const content = await fs.readFile(safePath, 'utf-8');
      const occurrences = content.split(old_string).length - 1;
      if (occurrences === 0) return `오류: 지정한 old_string을 파일에서 찾을 수 없습니다. (${filePath})\n탐색 문자열:\n${old_string}`;
      if (!replace_all && occurrences > 1) return `오류: old_string이 파일에서 ${occurrences}번 등장합니다. 더 많은 컨텍스트를 포함하여 유일하게 만들거나, replace_all: true를 사용하세요.`;
      const newContent = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
      console.log(chalk.bold(`\n[파일 편집: ${filePath}]`));
      console.log(renderDiffWithContext(computeLineDiff(content, newContent)));
      if (!await confirmPrompt('이 변경사항을 적용하시겠습니까?')) return `취소됨: 편집이 취소되었습니다. (${filePath})`;
      await fs.writeFile(safePath, newContent, 'utf-8');
      const newStat = await fs.stat(safePath);
      readFileState.set(safePath, { timestamp: Math.floor(newStat.mtimeMs), isPartial: false });
      recordOp({ type: 'edit', filePath: safePath, before: content, after: newContent });
      return `성공: ${replace_all ? occurrences : 1}곳이 수정되었습니다. (${filePath})`;
    } catch (error) { return `편집 실패: ${error.message}`; }
  },
});
