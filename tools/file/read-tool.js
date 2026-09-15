import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs/promises';
import { getSafePath } from '../../lib/utils.js';
import { readFileState } from '../../lib/state.js';
import { recordOp } from '../../lib/code-manager.js';
import { MAX_READ_SIZE_BYTES } from '../utils/helpers.js';

export const readFileTool = new DynamicStructuredTool({
  name: 'read_file',
  description: '파일 내용을 읽습니다. offset/limit으로 줄 범위를 지정할 수 있습니다. 큰 파일은 나눠서 읽으세요.',
  schema: z.object({
    filePath: z.string().describe('읽을 파일 경로'),
    offset: z.number().int().nonnegative().optional().describe('읽기 시작 줄 번호 (1-based, 생략 시 처음부터)'),
    limit: z.number().int().positive().optional().describe('읽을 줄 수 (생략 시 전체)'),
  }),
  func: async ({ filePath, offset, limit }) => {
    try {
      const safePath = getSafePath(filePath);
      const stat = await fs.stat(safePath);
      if (stat.size > MAX_READ_SIZE_BYTES && !offset && !limit) return `파일 크기(${(stat.size / 1024).toFixed(0)}KB)가 ${MAX_READ_SIZE_BYTES / 1024}KB를 초과합니다. offset과 limit을 사용해 일부만 읽으세요.`;
      const lines = (await fs.readFile(safePath, 'utf-8')).split('\n');
      const startIdx = offset ? Math.max(0, offset - 1) : 0;
      const endIdx = limit ? Math.min(startIdx + limit, lines.length) : lines.length;
      const numbered = lines.slice(startIdx, endIdx).map((line, i) => `${String(startIdx + i + 1).padStart(4)}\t${line}`).join('\n');
      const isPartial = startIdx > 0 || endIdx < lines.length;
      const rangeNote = isPartial ? ` [${startIdx + 1}-${endIdx}줄 / 전체 ${lines.length}줄]` : ` [전체 ${lines.length}줄]`;
      readFileState.set(safePath, { timestamp: Math.floor(stat.mtimeMs), isPartial });
      recordOp({ type: 'read', filePath: safePath });
      return `[파일: ${filePath}${rangeNote}]\n${numbered}`;
    } catch (error) { return `파일 읽기 실패: ${error.message}`; }
  },
});
