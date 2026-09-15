import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import path from 'path';
import { getBaseDir } from '../../lib/state.js';
import { getSafePath } from '../../lib/utils.js';
import { GREP_DEFAULT_HEAD_LIMIT, runRipgrep, grepWithJS } from '../utils/helpers.js';

export const grepFilesTool = new DynamicStructuredTool({
  name: 'grep_files',
  description: "정규식으로 파일 내용을 검색합니다. output_mode로 결과 형식을 선택하세요: 'files_with_matches'(기본, 파일 목록), 'content'(일치 줄 내용), 'count'(파일별 개수).",
  schema: z.object({ pattern: z.string().describe('검색할 정규식 패턴'), path: z.string().optional().describe('검색할 파일 또는 디렉터리 (생략 시 BASE_DIR)'), glob: z.string().optional().describe('파일 필터 글로브 패턴 (예: *.js, *.{ts,tsx})'), output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('출력 형식'), case_insensitive: z.boolean().optional().describe('대소문자 구분 안 함'), context: z.number().int().nonnegative().optional().describe('content 모드에서 앞뒤 몇 줄 표시'), head_limit: z.number().int().nonnegative().optional().describe('최대 출력 개수 (기본 250, 0=무제한)'), offset: z.number().int().nonnegative().optional().describe('건너뛸 항목 수 (페이지네이션)') }),
  func: async ({ pattern, path: searchPath, glob: globPattern, output_mode = 'files_with_matches', case_insensitive = false, context: contextLines = 0, head_limit, offset = 0 }) => {
    try {
      const searchDir = searchPath ? getSafePath(searchPath) : getBaseDir(), caseSensitive = !case_insensitive;
      let matchedFiles = [], contentLines = [], totalMatches = 0, usedRipgrep = false;
      try {
        const args = ['--hidden', '--glob', '!.git', '--glob', '!node_modules', '--max-columns', '500'];
        if (case_insensitive) args.push('-i');
        if (output_mode === 'files_with_matches') args.push('-l'); else if (output_mode === 'count') args.push('-c'); else { args.push('-n'); if (contextLines > 0) args.push('-C', String(contextLines)); }
        if (globPattern) for (const globValue of globPattern.split(/[\s,]+/).filter(Boolean)) args.push('--glob', globValue);
        if (pattern.startsWith('-')) args.push('-e', pattern); else args.push(pattern);
        args.push(searchDir);
        const lines = (await runRipgrep(args, searchDir)).split('\n').filter(Boolean);
        if (output_mode === 'files_with_matches') matchedFiles = lines.map(file => path.relative(getBaseDir(), file));
        else if (output_mode === 'count') { totalMatches = lines.reduce((sum, line) => { const count = parseInt(line.split(':').pop(), 10); return sum + (Number.isNaN(count) ? 0 : count); }, 0); matchedFiles = lines.map(line => { const parts = line.split(':'); parts.pop(); return path.relative(getBaseDir(), parts.join(':')); }); contentLines = lines.map(line => { const parts = line.split(':'); const count = parts.pop(); return `${path.relative(getBaseDir(), parts.join(':'))}:${count}`; }); }
        else { contentLines = lines.map(line => { const colonIndex = line.indexOf(':'); return colonIndex > 0 ? path.relative(getBaseDir(), line.slice(0, colonIndex)) + line.slice(colonIndex) : line; }); const seen = new Set(); for (const line of contentLines) { const file = line.split(':')[0]; if (file && !seen.has(file)) { seen.add(file); matchedFiles.push(file); } } }
        usedRipgrep = true;
      } catch (error) {
        if (error.code !== 'ENOENT' && !error.message.includes('ENOENT')) throw error;
        ({ matchedFiles, contentLines, totalMatches } = await grepWithJS(pattern, searchDir, { globPattern, outputMode: output_mode, caseSensitive, contextLines }));
      }
      const applyLimit = (items, limit, off) => { if (limit === 0) return { items: items.slice(off), truncated: false }; const effective = limit ?? GREP_DEFAULT_HEAD_LIMIT; return { items: items.slice(off, off + effective), truncated: items.length - off > effective }; };
      if (output_mode === 'files_with_matches') { const { items, truncated } = applyLimit(matchedFiles, head_limit, offset); if (!items.length) return '일치하는 파일이 없습니다.'; return `${items.length}개 파일에서 발견${usedRipgrep ? '' : ' (JS 검색)'}:\n${items.join('\n')}${truncated ? `\n[결과 ${head_limit ?? GREP_DEFAULT_HEAD_LIMIT}개로 제한됨]` : ''}`; }
      if (output_mode === 'count') { const { items, truncated } = applyLimit(contentLines, head_limit, offset); if (!items.length) return '일치하는 파일이 없습니다.'; return `총 ${totalMatches}건 (${matchedFiles.length}개 파일):\n${items.join('\n')}${truncated ? `\n[결과 ${head_limit ?? GREP_DEFAULT_HEAD_LIMIT}개로 제한됨]` : ''}`; }
      const { items, truncated } = applyLimit(contentLines, head_limit, offset); if (!items.length) return '일치하는 내용이 없습니다.'; return items.join('\n') + (truncated ? `\n[결과 ${head_limit ?? GREP_DEFAULT_HEAD_LIMIT}줄로 제한됨. offset으로 이어서 조회하세요.]` : '');
    } catch (error) { return `검색 실패: ${error.message}`; }
  },
});
