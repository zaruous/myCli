import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getBaseDir } from '../../lib/state.js';
import { runGit } from '../utils/helpers.js';

export const gitTools = [
  new DynamicStructuredTool({ name: 'git_status', description: '현재 git 저장소의 상태를 확인합니다. 변경된 파일, 스테이징 상태, 브랜치 정보를 보여줍니다.', schema: z.object({}), func: async () => { try { return (await runGit(['status'], getBaseDir())).trim() || 'git status: 변경사항 없음'; } catch (error) { return `git status 실패: ${error.message}`; } } }),
  new DynamicStructuredTool({ name: 'git_diff', description: 'git diff 결과를 반환합니다. 워킹 트리 또는 스테이징 영역의 변경사항, 특정 파일·커밋 간 차이를 확인합니다.', schema: z.object({ target: z.string().optional().describe('비교 대상 (파일 경로, 커밋 해시, 브랜치명 등). 생략 시 전체 워킹 트리'), staged: z.boolean().optional().describe('true이면 스테이징된 변경사항(--cached) 표시'), stat: z.boolean().optional().describe('true이면 변경 통계만 표시 (--stat)') }), func: async ({ target, staged = false, stat = false }) => { try { const args = ['diff']; if (staged) args.push('--cached'); if (stat) args.push('--stat'); if (target) args.push(target); return (await runGit(args, getBaseDir())).trim() || '변경사항 없음'; } catch (error) { return `git diff 실패: ${error.message}`; } } }),
  new DynamicStructuredTool({ name: 'git_log', description: 'git 커밋 기록을 조회합니다.', schema: z.object({ n: z.number().int().positive().optional().describe('표시할 커밋 수 (기본값: 10)'), oneline: z.boolean().optional().describe('true이면 한 줄 요약 형식으로 표시'), file: z.string().optional().describe('특정 파일의 커밋 기록만 조회') }), func: async ({ n = 10, oneline = true, file }) => { try { const args = ['log', `-${n}`]; if (oneline) args.push('--oneline'); if (file) args.push('--', file); return (await runGit(args, getBaseDir())).trim() || '커밋 기록 없음'; } catch (error) { return `git log 실패: ${error.message}`; } } }),
];

export { runGit };
