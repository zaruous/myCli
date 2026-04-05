/**
 * lib/tools.js
 * AI 에이전트 도구 정의 (11개 DynamicStructuredTool)
 * + 실행 헬퍼: runRipgrep, grepWithJS, runGit
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import fssync from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { glob } from "glob";
import chalk from "chalk";

import { getBaseDir, planModeState, readFileState } from './state.js';
import { getSafePath } from './utils.js';
import { confirmPrompt, selectKeyPrompt, inputPrompt } from './ui.js';
import { computeLineDiff, renderDiffWithContext } from './diff.js';
import { recordOp } from './code-manager.js';

// ─────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────
const MAX_READ_SIZE_BYTES   = 512 * 1024; // 512KB
const GLOB_MAX_RESULTS      = 100;
const GREP_DEFAULT_HEAD_LIMIT = 250;

// ─────────────────────────────────────────────────────────
// 실행 헬퍼
// ─────────────────────────────────────────────────────────

/** ripgrep(rg) 실행 — 없으면 ENOENT 에러 */
function runRipgrep(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd, shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
    child.on('close', code => {
      if (code === 0 || code === 1) resolve(stdout);
      else reject(new Error(stderr.trim() || `rg exit ${code}`));
    });
    child.on('error', reject);
  });
}

/** JS 폴백 grep (ripgrep 미설치 시) */
async function grepWithJS(pattern, searchDir, { globPattern, outputMode, caseSensitive, headLimit, offset, contextLines }) {
  const regex = new RegExp(pattern, caseSensitive ? '' : 'i');
  const ignore = ['node_modules/**', '.git/**', '**/node_modules/**', '**/.git/**'];
  const files = await glob(globPattern || '**/*', { cwd: searchDir, ignore, nodir: true });

  const matchedFiles = [], contentLines = [];
  let totalMatches = 0;

  for (const relFile of files) {
    const absFile = path.join(searchDir, relFile);
    let text;
    try { text = await fs.readFile(absFile, 'utf-8'); } catch { continue; }
    const lines = text.split('\n');
    const matchingLineNums = [];
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) matchingLineNums.push(i);
    }
    if (matchingLineNums.length === 0) continue;

    matchedFiles.push(relFile);
    totalMatches += matchingLineNums.length;

    if (outputMode === 'content') {
      const shown = new Set();
      for (const ln of matchingLineNums) {
        for (let k = Math.max(0, ln - contextLines); k <= Math.min(lines.length - 1, ln + contextLines); k++) shown.add(k);
      }
      for (const k of [...shown].sort((a, b) => a - b)) {
        contentLines.push(`${relFile}:${k + 1}:${lines[k]}`);
      }
    }
  }
  return { matchedFiles, contentLines, totalMatches };
}

/** git 명령 실행 헬퍼 */
export function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
    child.on('close', code => {
      if (code === 0 || code === 1) resolve(stdout || stderr);
      else reject(new Error(stderr.trim() || `git exit ${code}`));
    });
    child.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────
// AI 도구 배열 (baseTools)
// ─────────────────────────────────────────────────────────
export const baseTools = [

  // ── read_file ────────────────────────────────────────────
  new DynamicStructuredTool({
    name: "read_file",
    description: "파일 내용을 읽습니다. offset/limit으로 줄 범위를 지정할 수 있습니다. 큰 파일은 나눠서 읽으세요.",
    schema: z.object({
      filePath: z.string().describe("읽을 파일 경로"),
      offset: z.number().int().nonnegative().optional().describe("읽기 시작 줄 번호 (1-based, 생략 시 처음부터)"),
      limit:  z.number().int().positive().optional().describe("읽을 줄 수 (생략 시 전체)"),
    }),
    func: async ({ filePath, offset, limit }) => {
      try {
        const safePath = getSafePath(filePath);
        const stat = await fs.stat(safePath);
        if (stat.size > MAX_READ_SIZE_BYTES && !offset && !limit) {
          return `파일 크기(${(stat.size / 1024).toFixed(0)}KB)가 ${MAX_READ_SIZE_BYTES / 1024}KB를 초과합니다. offset과 limit을 사용해 일부만 읽으세요.`;
        }

        const content  = await fs.readFile(safePath, 'utf-8');
        const lines    = content.split('\n');
        const totalLines = lines.length;
        const startIdx = offset ? Math.max(0, offset - 1) : 0;
        const endIdx   = limit  ? Math.min(startIdx + limit, totalLines) : totalLines;
        const selected = lines.slice(startIdx, endIdx);
        const numbered = selected.map((line, i) => `${String(startIdx + i + 1).padStart(4)}\t${line}`).join('\n');
        const isPartial = startIdx > 0 || endIdx < totalLines;
        const rangeNote = isPartial
          ? ` [${startIdx + 1}-${endIdx}줄 / 전체 ${totalLines}줄]`
          : ` [전체 ${totalLines}줄]`;

        readFileState.set(safePath, { timestamp: Math.floor(stat.mtimeMs), isPartial });
        recordOp({ type: 'read', filePath: safePath });
        return `[파일: ${filePath}${rangeNote}]\n${numbered}`;
      } catch (error) {
        return `파일 읽기 실패: ${error.message}`;
      }
    },
  }),

  // ── write_file ───────────────────────────────────────────
  new DynamicStructuredTool({
    name: "write_file",
    description: "파일을 생성하거나 덮어씁니다. 반드시 read_file로 읽은 후에 사용하세요.",
    schema: z.object({
      filePath: z.string().describe("저장할 파일 경로"),
      content:  z.string().describe("저장할 파일의 전체 내용"),
    }),
    func: async ({ filePath, content }) => {
      if (planModeState.active) {
        return `차단됨: 현재 계획 모드(Plan Mode) 중입니다. 파일을 수정하려면 exit_plan_mode로 계획을 제출하고 승인받은 후 진행하세요.`;
      }
      try {
        const safePath = getSafePath(filePath);
        let isNew = false;
        let beforeContent = null;

        try {
          const stat = await fs.stat(safePath);
          const readRecord = readFileState.get(safePath);
          if (!readRecord) return `오류: 파일을 먼저 read_file로 읽어야 합니다. (${filePath})`;
          if (Math.floor(stat.mtimeMs) > readRecord.timestamp) {
            return `오류: 마지막 읽기 이후 파일이 외부에서 수정되었습니다. read_file로 다시 읽은 후 시도하세요. (${filePath})`;
          }
        } catch (e) {
          if (e.code === 'ENOENT') isNew = true;
          else throw e;
        }

        let diffDisplay = '';
        if (!isNew) {
          const existing = await fs.readFile(safePath, 'utf-8');
          beforeContent = existing;
          const diffResult = computeLineDiff(existing, content);
          if (!diffResult.some(d => d.type !== 'same')) return `변경 없음: 파일 내용이 동일합니다. (${filePath})`;
          diffDisplay = renderDiffWithContext(diffResult);
        } else {
          const lines = content.split('\n');
          const preview = lines.slice(0, 50).map(l => chalk.green(`+ ${l}`)).join('\n');
          diffDisplay = lines.length > 50
            ? preview + chalk.gray(`\n  ... (총 ${lines.length}줄, 처음 50줄만 표시)`)
            : preview;
        }

        console.log(chalk.bold(`\n[${isNew ? '신규 파일' : '파일 변경'}: ${filePath}]`));
        console.log(diffDisplay);

        const confirmed = await confirmPrompt(isNew ? '이 파일을 생성하시겠습니까?' : '이 변경사항을 적용하시겠습니까?');
        if (!confirmed) return `취소됨: 파일 저장이 취소되었습니다. (${filePath})`;

        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, content, 'utf-8');
        const newStat = await fs.stat(safePath);
        readFileState.set(safePath, { timestamp: Math.floor(newStat.mtimeMs), isPartial: false });
        recordOp({ type: 'write', filePath: safePath, before: beforeContent, after: content });

        return isNew ? `성공: 파일이 생성되었습니다. (${filePath})` : `성공: 파일이 수정되었습니다. (${filePath})`;
      } catch (error) {
        return `파일 쓰기 실패: ${error.message}`;
      }
    },
  }),

  // ── edit_file ────────────────────────────────────────────
  new DynamicStructuredTool({
    name: "edit_file",
    description: "파일의 특정 부분만 수정합니다. old_string을 new_string으로 교체합니다. 반드시 read_file로 읽은 후에 사용하세요. old_string은 파일 내에서 유일한 문자열이어야 합니다.",
    schema: z.object({
      filePath:    z.string().describe("수정할 파일 경로"),
      old_string:  z.string().describe("교체할 기존 문자열 (파일 내에서 정확히 한 번만 등장해야 함)"),
      new_string:  z.string().describe("교체될 새 문자열"),
      replace_all: z.boolean().optional().describe("true이면 old_string의 모든 등장을 교체 (기본값: false)"),
    }),
    func: async ({ filePath, old_string, new_string, replace_all = false }) => {
      if (planModeState.active) return `차단됨: 현재 계획 모드(Plan Mode) 중입니다.`;
      try {
        const safePath   = getSafePath(filePath);
        const readRecord = readFileState.get(safePath);
        if (!readRecord) return `오류: 파일을 먼저 read_file로 읽어야 합니다. (${filePath})`;

        const stat = await fs.stat(safePath);
        if (Math.floor(stat.mtimeMs) > readRecord.timestamp) {
          return `오류: 마지막 읽기 이후 파일이 외부에서 수정되었습니다. read_file로 다시 읽은 후 시도하세요. (${filePath})`;
        }

        const content = await fs.readFile(safePath, 'utf-8');
        const occurrences = content.split(old_string).length - 1;
        if (occurrences === 0) {
          return `오류: 지정한 old_string을 파일에서 찾을 수 없습니다. (${filePath})\n탐색 문자열:\n${old_string}`;
        }
        if (!replace_all && occurrences > 1) {
          return `오류: old_string이 파일에서 ${occurrences}번 등장합니다. 더 많은 컨텍스트를 포함하여 유일하게 만들거나, replace_all: true를 사용하세요.`;
        }

        const newContent  = replace_all ? content.split(old_string).join(new_string) : content.replace(old_string, new_string);
        const diffResult  = computeLineDiff(content, newContent);
        const diffDisplay = renderDiffWithContext(diffResult);
        console.log(chalk.bold(`\n[파일 편집: ${filePath}]`));
        console.log(diffDisplay);

        const confirmed = await confirmPrompt('이 변경사항을 적용하시겠습니까?');
        if (!confirmed) return `취소됨: 편집이 취소되었습니다. (${filePath})`;

        await fs.writeFile(safePath, newContent, 'utf-8');
        const newStat = await fs.stat(safePath);
        readFileState.set(safePath, { timestamp: Math.floor(newStat.mtimeMs), isPartial: false });
        recordOp({ type: 'edit', filePath: safePath, before: content, after: newContent });

        return `성공: ${replace_all ? occurrences : 1}곳이 수정되었습니다. (${filePath})`;
      } catch (error) {
        return `편집 실패: ${error.message}`;
      }
    },
  }),

  // ── glob_files ───────────────────────────────────────────
  new DynamicStructuredTool({
    name: "glob_files",
    description: "글로브 패턴으로 파일을 검색합니다. '**/*.js', 'src/**/*.ts' 같은 패턴을 사용하세요. 결과는 최근 수정 순으로 정렬됩니다.",
    schema: z.object({
      pattern: z.string().describe("글로브 패턴 (예: **/*.js, src/**/*.ts)"),
      path:    z.string().optional().describe("검색 디렉터리 (생략 시 현재 BASE_DIR)"),
    }),
    func: async ({ pattern, path: searchPath }) => {
      try {
        const baseDir = searchPath ? getSafePath(searchPath) : getBaseDir();
        const start   = Date.now();
        const files   = await glob(pattern, {
          cwd: baseDir,
          ignore: ['node_modules/**', '.git/**', '**/node_modules/**', '**/.git/**'],
          nodir: true,
        });

        const stats  = await Promise.allSettled(files.map(f => fs.stat(path.join(baseDir, f))));
        const sorted = files
          .map((f, i) => ({ file: f, mtime: stats[i].status === 'fulfilled' ? (stats[i].value.mtimeMs ?? 0) : 0 }))
          .sort((a, b) => b.mtime - a.mtime)
          .map(x => x.file);

        const truncated  = sorted.length > GLOB_MAX_RESULTS;
        const result     = sorted.slice(0, GLOB_MAX_RESULTS);
        const durationMs = Date.now() - start;

        if (result.length === 0) return '파일을 찾을 수 없습니다.';
        const header = `${result.length}개 파일 발견 (${durationMs}ms)${truncated ? ` [상위 ${GLOB_MAX_RESULTS}개만 표시]` : ''}`;
        return [header, ...result].join('\n');
      } catch (error) {
        return `파일 검색 실패: ${error.message}`;
      }
    },
  }),

  // ── grep_files ───────────────────────────────────────────
  new DynamicStructuredTool({
    name: "grep_files",
    description: "정규식으로 파일 내용을 검색합니다. output_mode로 결과 형식을 선택하세요: 'files_with_matches'(기본, 파일 목록), 'content'(일치 줄 내용), 'count'(파일별 개수).",
    schema: z.object({
      pattern:          z.string().describe("검색할 정규식 패턴"),
      path:             z.string().optional().describe("검색할 파일 또는 디렉터리 (생략 시 BASE_DIR)"),
      glob:             z.string().optional().describe("파일 필터 글로브 패턴 (예: *.js, *.{ts,tsx})"),
      output_mode:      z.enum(['content', 'files_with_matches', 'count']).optional()
        .describe("출력 형식: content=일치 줄, files_with_matches=파일 목록, count=파일별 개수"),
      case_insensitive: z.boolean().optional().describe("대소문자 구분 안 함"),
      context:          z.number().int().nonnegative().optional().describe("content 모드에서 앞뒤 몇 줄 표시"),
      head_limit:       z.number().int().nonnegative().optional().describe("최대 출력 개수 (기본 250, 0=무제한)"),
      offset:           z.number().int().nonnegative().optional().describe("건너뛸 항목 수 (페이지네이션)"),
    }),
    func: async ({ pattern, path: searchPath, glob: globPattern, output_mode = 'files_with_matches', case_insensitive = false, context: contextLines = 0, head_limit, offset = 0 }) => {
      try {
        const searchDir   = searchPath ? getSafePath(searchPath) : getBaseDir();
        const caseSensitive = !case_insensitive;
        let matchedFiles = [], contentLines = [], totalMatches = 0;
        let usedRipgrep = false;

        try {
          const args = ['--hidden', '--glob', '!.git', '--glob', '!node_modules', '--max-columns', '500'];
          if (case_insensitive) args.push('-i');
          if (output_mode === 'files_with_matches') args.push('-l');
          else if (output_mode === 'count') args.push('-c');
          else if (output_mode === 'content') {
            args.push('-n');
            if (contextLines > 0) args.push('-C', String(contextLines));
          }
          if (globPattern) {
            for (const gp of globPattern.split(/[\s,]+/).filter(Boolean)) args.push('--glob', gp);
          }
          if (pattern.startsWith('-')) args.push('-e', pattern); else args.push(pattern);
          args.push(searchDir);

          const raw   = await runRipgrep(args, searchDir);
          const lines = raw.split('\n').filter(Boolean);

          if (output_mode === 'files_with_matches') {
            matchedFiles = lines.map(f => path.relative(getBaseDir(), f));
          } else if (output_mode === 'count') {
            totalMatches = lines.reduce((sum, l) => { const n = parseInt(l.split(':').pop(), 10); return sum + (isNaN(n) ? 0 : n); }, 0);
            matchedFiles = lines.map(l => { const p = l.split(':'); p.pop(); return path.relative(getBaseDir(), p.join(':')); });
            contentLines = lines.map(l => { const p = l.split(':'); const cnt = p.pop(); return `${path.relative(getBaseDir(), p.join(':'))}:${cnt}`; });
          } else {
            contentLines = lines.map(l => {
              const colonIdx = l.indexOf(':');
              return colonIdx > 0 ? path.relative(getBaseDir(), l.slice(0, colonIdx)) + l.slice(colonIdx) : l;
            });
            const seen = new Set();
            for (const l of contentLines) { const f = l.split(':')[0]; if (f && !seen.has(f)) { seen.add(f); matchedFiles.push(f); } }
          }
          usedRipgrep = true;
        } catch (e) {
          if (e.code !== 'ENOENT' && !e.message.includes('ENOENT')) throw e;
          const result = await grepWithJS(pattern, searchDir, { globPattern, outputMode: output_mode, caseSensitive, headLimit: head_limit, offset, contextLines });
          matchedFiles = result.matchedFiles;
          contentLines = result.contentLines;
          totalMatches = result.totalMatches;
        }

        function applyLimit(arr, limit, off) {
          if (limit === 0) return { items: arr.slice(off), truncated: false };
          const effective = limit ?? GREP_DEFAULT_HEAD_LIMIT;
          const sliced = arr.slice(off, off + effective);
          return { items: sliced, truncated: arr.length - off > effective };
        }

        if (output_mode === 'files_with_matches') {
          const { items, truncated } = applyLimit(matchedFiles, head_limit, offset);
          if (items.length === 0) return '일치하는 파일이 없습니다.';
          const suffix = truncated ? `\n[결과 ${head_limit ?? GREP_DEFAULT_HEAD_LIMIT}개로 제한됨]` : '';
          return `${items.length}개 파일에서 발견${usedRipgrep ? '' : ' (JS 검색)'}:\n${items.join('\n')}${suffix}`;
        }
        if (output_mode === 'count') {
          const { items, truncated } = applyLimit(contentLines, head_limit, offset);
          if (items.length === 0) return '일치하는 파일이 없습니다.';
          return `총 ${totalMatches}건 (${matchedFiles.length}개 파일):\n${items.join('\n')}${truncated ? `\n[결과 ${head_limit ?? GREP_DEFAULT_HEAD_LIMIT}개로 제한됨]` : ''}`;
        }
        const { items, truncated } = applyLimit(contentLines, head_limit, offset);
        if (items.length === 0) return '일치하는 내용이 없습니다.';
        return items.join('\n') + (truncated ? `\n[결과 ${head_limit ?? GREP_DEFAULT_HEAD_LIMIT}줄로 제한됨. offset으로 이어서 조회하세요.]` : '');
      } catch (error) {
        return `검색 실패: ${error.message}`;
      }
    },
  }),

  // ── enter_plan_mode ──────────────────────────────────────
  new DynamicStructuredTool({
    name: "enter_plan_mode",
    description: "계획 모드(Plan Mode)에 진입합니다. 복잡한 구현 작업을 시작하기 전에 호출하세요. 계획 모드에서는 파일 수정이 차단되고, 코드베이스 탐색과 설계에 집중합니다.",
    schema: z.object({}),
    func: async () => {
      if (planModeState.active) return `이미 계획 모드 중입니다. exit_plan_mode로 계획을 제출하세요.`;
      planModeState.active    = true;
      planModeState.enteredAt = new Date();
      console.log(chalk.cyan('\n[계획 모드 진입] write_file, execute_shell_command가 차단됩니다.'));
      return `계획 모드에 진입했습니다.

지금부터 다음 단계를 따르세요:
1. glob_files, grep_files, read_file로 코드베이스를 철저히 탐색하세요
2. 기존 패턴과 아키텍처를 파악하세요
3. 여러 구현 방법과 그 트레이드오프를 검토하세요
4. 구체적인 구현 계획을 수립하세요
5. 준비가 되면 exit_plan_mode를 호출해 계획을 제출하고 승인을 받으세요

주의: 계획 모드에서는 write_file과 execute_shell_command가 차단됩니다. 탐색과 설계에만 집중하세요.`;
    },
  }),

  // ── exit_plan_mode ───────────────────────────────────────
  new DynamicStructuredTool({
    name: "exit_plan_mode",
    description: "계획 모드를 종료하고 작성한 계획을 사용자에게 제출합니다. 사용자가 승인하면 구현을 시작할 수 있습니다.",
    schema: z.object({
      plan: z.string().describe("작성한 구현 계획의 전체 내용. 구체적인 단계, 수정할 파일, 접근 방법을 포함하세요."),
    }),
    func: async ({ plan }) => {
      if (!planModeState.active) return `계획 모드 중이 아닙니다. enter_plan_mode를 먼저 호출하세요.`;

      const elapsed = planModeState.enteredAt
        ? Math.round((Date.now() - planModeState.enteredAt) / 1000)
        : 0;

      console.log(chalk.cyan('\n' + '─'.repeat(60)));
      console.log(chalk.cyan.bold('📋 구현 계획 검토'));
      console.log(chalk.gray(`   계획 모드 소요 시간: ${elapsed}초`));
      console.log(chalk.cyan('─'.repeat(60)));
      console.log(plan);
      console.log(chalk.cyan('─'.repeat(60)));

      const decision = await selectKeyPrompt('이 계획을 승인하시겠습니까?', [
        { key: 'y', label: '승인 - 이 계획으로 구현을 시작합니다',       value: 'approve'  },
        { key: 'n', label: '거절 - 계획을 수정합니다',                   value: 'reject'   },
        { key: 'e', label: '수정 제안 - 피드백을 남기고 재계획합니다',    value: 'feedback' },
      ], 'y');

      if (decision === 'approve') {
        planModeState.active    = false;
        planModeState.enteredAt = null;
        console.log(chalk.green('\n✅ 계획이 승인되었습니다. 구현을 시작하세요.\n'));
        return `사용자가 계획을 승인했습니다. 이제 구현을 시작하세요.\n\n승인된 계획:\n${plan}\n\n계획에 따라 순서대로 구현을 진행하세요. todo 목록이 있다면 업데이트하세요.`;
      }
      if (decision === 'feedback') {
        const feedback = await inputPrompt('수정 방향이나 피드백을 입력하세요:');
        console.log(chalk.yellow('\n계획을 수정해주세요. 계획 모드를 유지합니다.\n'));
        return `사용자가 계획 수정을 요청했습니다. 계획 모드를 유지합니다.\n\n피드백: ${feedback}\n\n피드백을 반영해 계획을 수정한 후 exit_plan_mode를 다시 호출하세요.`;
      }
      console.log(chalk.yellow('\n계획이 거절되었습니다. 계획 모드를 유지합니다.\n'));
      return `사용자가 계획을 거절했습니다. 계획 모드를 유지합니다. 코드베이스를 더 탐색하거나 다른 접근 방법을 고려한 후 exit_plan_mode를 다시 호출하세요.`;
    },
  }),

  // ── execute_shell_command ────────────────────────────────
  new DynamicStructuredTool({
    name: "execute_shell_command",
    description: "터미널(셸) 명령어를 실행하고 결과를 반환합니다. ipconfig, ls, pwd, date 같은 시스템 확인용 명령에 사용하세요.",
    schema: z.object({
      command: z.string().describe("실행할 셸 명령어 (예: ipconfig)"),
    }),
    func: async ({ command }) => {
      if (planModeState.active) return `차단됨: 현재 계획 모드(Plan Mode) 중입니다. 시스템 명령어는 계획 승인 후 실행하세요.`;
      const blocklist  = ["rm", "del", "sudo", "su", "shutdown", "reboot"];
      const commandBase = command.split(" ")[0];
      if (blocklist.includes(commandBase)) return `에러: 보안상의 이유로 '${commandBase}' 명령어는 실행할 수 없습니다.`;
      console.log(chalk.gray(`[툴 실행] 셸 명령어 실행: ${command}`));
      return new Promise((resolve) => {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-Command', `chcp 65001 > $null; ${command}`],
          { cwd: getBaseDir() }
        );
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += data.toString('utf-8'); });
        child.stderr.on('data', data => { stderr += data.toString('utf-8'); });
        child.on('close', code => {
          let output = `종료 코드: ${code}\n`;
          if (stdout.trim()) output += `STDOUT:\n${stdout.trim()}\n`;
          if (stderr.trim()) output += `STDERR:\n${stderr.trim()}\n`;
          resolve(code === 0 ? `명령어 실행 성공:\n${output}` : `명령어 실행 중 에러 발생:\n${output}`);
        });
        child.on('error', err => resolve(`명령어 실행 실패: ${err.message}`));
      });
    },
  }),

  // ── git_status ───────────────────────────────────────────
  new DynamicStructuredTool({
    name: "git_status",
    description: "현재 git 저장소의 상태를 확인합니다. 변경된 파일, 스테이징 상태, 브랜치 정보를 보여줍니다.",
    schema: z.object({}),
    func: async () => {
      try { return (await runGit(['status'], getBaseDir())).trim() || 'git status: 변경사항 없음'; }
      catch (e) { return `git status 실패: ${e.message}`; }
    },
  }),

  // ── git_diff ─────────────────────────────────────────────
  new DynamicStructuredTool({
    name: "git_diff",
    description: "git diff 결과를 반환합니다. 워킹 트리 또는 스테이징 영역의 변경사항, 특정 파일·커밋 간 차이를 확인합니다.",
    schema: z.object({
      target: z.string().optional().describe("비교 대상 (파일 경로, 커밋 해시, 브랜치명 등). 생략 시 전체 워킹 트리"),
      staged: z.boolean().optional().describe("true이면 스테이징된 변경사항(--cached) 표시"),
      stat:   z.boolean().optional().describe("true이면 변경 통계만 표시 (--stat)"),
    }),
    func: async ({ target, staged = false, stat = false }) => {
      try {
        const args = ['diff'];
        if (staged) args.push('--cached');
        if (stat)   args.push('--stat');
        if (target) args.push(target);
        return (await runGit(args, getBaseDir())).trim() || '변경사항 없음';
      } catch (e) { return `git diff 실패: ${e.message}`; }
    },
  }),

  // ── git_log ──────────────────────────────────────────────
  new DynamicStructuredTool({
    name: "git_log",
    description: "git 커밋 기록을 조회합니다.",
    schema: z.object({
      n:       z.number().int().positive().optional().describe("표시할 커밋 수 (기본값: 10)"),
      oneline: z.boolean().optional().describe("true이면 한 줄 요약 형식으로 표시"),
      file:    z.string().optional().describe("특정 파일의 커밋 기록만 조회"),
    }),
    func: async ({ n = 10, oneline = true, file }) => {
      try {
        const args = ['log', `-${n}`];
        if (oneline) args.push('--oneline');
        if (file)    args.push('--', file);
        return (await runGit(args, getBaseDir())).trim() || '커밋 기록 없음';
      } catch (e) { return `git log 실패: ${e.message}`; }
    },
  }),

  // ── get_datetime ─────────────────────────────────────────
  new DynamicStructuredTool({
    name: "get_datetime",
    description: "OS의 현재 날짜·시간·타임존 정보를 반환합니다. '지금 몇 시야', '오늘 날짜', '현재 시간' 같은 질문에 사용하세요.",
    schema: z.object({}),
    func: async () => {
      const now = new Date();
      const tz  = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const offset = -now.getTimezoneOffset();
      const sign   = offset >= 0 ? '+' : '-';
      const hh     = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
      const mm     = String(Math.abs(offset) % 60).padStart(2, '0');

      return [
        `현재 날짜/시간 (OS 기준)`,
        `  날짜      : ${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일`,
        `  시간      : ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
        `  타임존    : ${tz} (UTC${sign}${hh}:${mm})`,
        `  ISO 8601  : ${now.toISOString()}`,
        `  Unix 타임 : ${Math.floor(now.getTime() / 1000)}`,
      ].join('\n');
    },
  }),

  // ── install_package ──────────────────────────────────────
  new DynamicStructuredTool({
    name: "install_package",
    description: "execute_code에서 사용할 npm 패키지를 격리된 샌드박스에 설치합니다. execute_code 호출 전에 필요한 패키지가 있으면 먼저 호출하세요.",
    schema: z.object({
      packages: z.array(z.string()).describe("설치할 패키지 이름 목록 (예: [\"docx\", \"marked\"])"),
    }),
    func: async ({ packages }) => {
      if (planModeState.active) return `차단됨: 계획 모드 중입니다.`;
      const sandboxDir = path.join(os.tmpdir(), 'mycli-sandbox');
      try {
        await fs.mkdir(sandboxDir, { recursive: true });
        // package.json 없으면 생성
        const pkgPath = path.join(sandboxDir, 'package.json');
        if (!fssync.existsSync(pkgPath)) {
          await fs.writeFile(pkgPath, JSON.stringify({ name: 'mycli-sandbox', version: '1.0.0', type: 'module' }), 'utf-8');
        }

        console.log(chalk.gray(`[install_package] 설치 중: ${packages.join(', ')} → ${sandboxDir}`));
        const result = await new Promise((resolve) => {
          const child = spawn(
            'npm', ['install', '--prefix', sandboxDir, ...packages],
            { shell: true, cwd: sandboxDir }
          );
          let stdout = '', stderr = '';
          child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
          child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
          child.on('close', code => resolve({ code, stdout, stderr }));
          child.on('error', err => resolve({ code: -1, stdout: '', stderr: err.message }));
        });

        if (result.code !== 0) return `패키지 설치 실패 (exit ${result.code}):\n${result.stderr.trim()}`;
        console.log(chalk.green(`✅ 설치 완료: ${packages.join(', ')}`));
        return `설치 성공: ${packages.join(', ')}\n샌드박스: ${sandboxDir}`;
      } catch (e) {
        return `install_package 오류: ${e.message}`;
      }
    },
  }),

  // ── execute_code ─────────────────────────────────────────
  new DynamicStructuredTool({
    name: "execute_code",
    description: "Node.js 코드를 격리된 샌드박스에서 실행합니다. 파일 변환·데이터 처리 등 기존 도구로 불가능한 작업에 사용하세요. 실행 전 사용자 승인을 받습니다. 코드 내에서 process.env.MYCLI_WORKDIR로 작업 디렉터리에 접근하세요.",
    schema: z.object({
      code:        z.string().describe("실행할 Node.js 코드 (ESM import 문법 사용 가능)"),
      description: z.string().describe("이 코드가 무엇을 하는지 한 줄 설명"),
      packages:    z.array(z.string()).optional().describe("코드에서 사용하는 npm 패키지 목록 (install_package 없이 표시 목적)"),
      inputFiles:  z.array(z.string()).optional().describe("읽을 파일 경로 목록 (MYCLI_WORKDIR 기준 상대경로)"),
      outputFiles: z.array(z.string()).optional().describe("생성될 파일 경로 목록 (MYCLI_WORKDIR 기준 상대경로)"),
      timeout:     z.number().int().positive().optional().describe("타임아웃(ms), 기본값 30000"),
    }),
    func: async ({ code, description, packages, inputFiles, outputFiles, timeout = 30000 }) => {
      if (planModeState.active) return `차단됨: 계획 모드 중입니다.`;

      const sandboxDir = path.join(os.tmpdir(), 'mycli-sandbox');
      const workdir    = getBaseDir();
      const W = 62;

      // ── 실행 정보 헤더 ───────────────────────────────────
      console.log('\n' + chalk.bold.cyan('┌' + '─'.repeat(W) + '┐'));
      console.log(chalk.bold.cyan('│') + chalk.bold(` 코드 실행 요청`.padEnd(W)) + chalk.bold.cyan('│'));
      console.log(chalk.bold.cyan('├' + '─'.repeat(W) + '┤'));

      // 목적
      console.log(chalk.cyan('│') + chalk.bold(' 목적: ') + description.slice(0, W - 7).padEnd(W - 7) + chalk.cyan('│'));

      // 실행 환경
      console.log(chalk.cyan('│') + chalk.dim(` 환경:  Node.js • 샌드박스: ${sandboxDir}`.slice(0, W).padEnd(W)) + chalk.cyan('│'));
      console.log(chalk.cyan('│') + chalk.dim(` 작업공간: ${workdir}`.slice(0, W).padEnd(W)) + chalk.cyan('│'));

      // 패키지
      if (packages?.length) {
        console.log(chalk.cyan('│') + chalk.yellow(` 패키지: ${packages.join(', ')}`.slice(0, W).padEnd(W)) + chalk.cyan('│'));
      }

      // 입력 파일
      if (inputFiles?.length) {
        console.log(chalk.cyan('│') + chalk.dim(` 입력:  ${inputFiles.join(', ')}`.slice(0, W).padEnd(W)) + chalk.cyan('│'));
      }

      // 출력 파일
      if (outputFiles?.length) {
        console.log(chalk.cyan('│') + chalk.green(` 출력:  ${outputFiles.join(', ')}`.slice(0, W).padEnd(W)) + chalk.cyan('│'));
      }

      // 코드 줄 수
      const lines = code.split('\n');
      console.log(chalk.cyan('│') + chalk.dim(` 코드:  ${lines.length}줄`.padEnd(W)) + chalk.cyan('│'));

      // 코드 본문
      console.log(chalk.bold.cyan('├' + '─'.repeat(W) + '┤'));
      lines.forEach((line, i) => {
        const lineNo  = chalk.dim(`${String(i + 1).padStart(3)} │ `);
        const content = line.length > W - 6 ? line.slice(0, W - 9) + chalk.dim('...') : line;
        console.log(chalk.cyan('│') + ' ' + lineNo + content);
      });
      console.log(chalk.bold.cyan('└' + '─'.repeat(W) + '┘'));

      const confirmed = await confirmPrompt('이 코드를 실행하시겠습니까?');
      if (!confirmed) return `취소됨: 코드 실행이 취소되었습니다.`;

      const scriptPath = path.join(sandboxDir, `script-${Date.now()}.mjs`);

      try {
        await fs.mkdir(sandboxDir, { recursive: true });
        // package.json 없으면 생성
        const pkgPath = path.join(sandboxDir, 'package.json');
        if (!fssync.existsSync(pkgPath)) {
          await fs.writeFile(pkgPath, JSON.stringify({ name: 'mycli-sandbox', version: '1.0.0', type: 'module' }), 'utf-8');
        }
        await fs.writeFile(scriptPath, code, 'utf-8');

        console.log(chalk.gray(`[execute_code] 실행 중... (타임아웃: ${timeout / 1000}초)`));

        const result = await new Promise((resolve) => {
          const child = spawn('node', [scriptPath], {
            cwd: sandboxDir,
            env: { ...process.env, MYCLI_WORKDIR: getBaseDir() },
            shell: false,
          });
          let stdout = '', stderr = '';
          const timer = setTimeout(() => {
            child.kill();
            resolve({ code: -1, stdout, stderr: 'TIMEOUT: 실행 시간 초과' });
          }, timeout);
          child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
          child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
          child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
          child.on('error', err => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: err.message }); });
        });

        const output = [];
        if (result.stdout.trim()) output.push(`STDOUT:\n${result.stdout.trim()}`);
        if (result.stderr.trim()) output.push(`STDERR:\n${result.stderr.trim()}`);

        if (result.code === 0) {
          console.log(chalk.green(`✅ 실행 완료 (exit 0)`));
          return `실행 성공 (exit 0):\n${output.join('\n') || '(출력 없음)'}`;
        } else {
          return `실행 실패 (exit ${result.code}):\n${output.join('\n')}`;
        }
      } catch (e) {
        return `execute_code 오류: ${e.message}`;
      } finally {
        await fs.unlink(scriptPath).catch(() => {});
      }
    },
  }),
];
