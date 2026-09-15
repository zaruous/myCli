import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { getBaseDir } from '../../lib/state.js';
import { getSafePath } from '../../lib/utils.js';
import { GLOB_MAX_RESULTS } from '../utils/helpers.js';

const ignored = ['node_modules/**', '.git/**', '**/node_modules/**', '**/.git/**'];

export const globFilesTool = new DynamicStructuredTool({
  name: 'glob_files',
  description: "글로브 패턴으로 파일을 검색합니다. '**/*.js', 'src/**/*.ts' 같은 패턴을 사용하세요. 결과는 최근 수정 순으로 정렬됩니다.",
  schema: z.object({ pattern: z.string().describe('글로브 패턴 (예: **/*.js, src/**/*.ts)'), path: z.string().optional().describe('검색 디렉터리 (생략 시 현재 BASE_DIR)') }),
  func: async ({ pattern, path: searchPath }) => {
    try {
      const baseDir = searchPath ? getSafePath(searchPath) : getBaseDir(), start = Date.now();
      const files = await glob(pattern, { cwd: baseDir, ignore: ignored, nodir: true });
      const stats = await Promise.allSettled(files.map(file => fs.stat(path.join(baseDir, file))));
      const sorted = files.map((file, i) => ({ file, mtime: stats[i].status === 'fulfilled' ? (stats[i].value.mtimeMs ?? 0) : 0 })).sort((a, b) => b.mtime - a.mtime).map(item => item.file);
      const result = sorted.slice(0, GLOB_MAX_RESULTS), truncated = sorted.length > GLOB_MAX_RESULTS;
      if (!result.length) return '파일을 찾을 수 없습니다.';
      return [`${result.length}개 파일 발견 (${Date.now() - start}ms)${truncated ? ` [상위 ${GLOB_MAX_RESULTS}개만 표시]` : ''}`, ...result].join('\n');
    } catch (error) { return `파일 검색 실패: ${error.message}`; }
  },
});
