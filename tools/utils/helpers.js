import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { glob } from 'glob';

export const MAX_READ_SIZE_BYTES = 512 * 1024;
export const GLOB_MAX_RESULTS = 100;
export const GREP_DEFAULT_HEAD_LIMIT = 250;

export function runRipgrep(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, { cwd, shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data.toString('utf-8'); });
    child.stderr.on('data', data => { stderr += data.toString('utf-8'); });
    child.on('close', code => {
      if (code === 0 || code === 1) resolve(stdout);
      else reject(new Error(stderr.trim() || `rg exit ${code}`));
    });
    child.on('error', reject);
  });
}

export async function grepWithJS(pattern, searchDir, { globPattern, outputMode, caseSensitive, contextLines }) {
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
      for (const lineNumber of matchingLineNums) {
        for (let line = Math.max(0, lineNumber - contextLines); line <= Math.min(lines.length - 1, lineNumber + contextLines); line++) shown.add(line);
      }
      for (const line of [...shown].sort((a, b) => a - b)) contentLines.push(`${relFile}:${line + 1}:${lines[line]}`);
    }
  }
  return { matchedFiles, contentLines, totalMatches };
}

export function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data.toString('utf-8'); });
    child.stderr.on('data', data => { stderr += data.toString('utf-8'); });
    child.on('close', code => {
      if (code === 0 || code === 1) resolve(stdout || stderr);
      else reject(new Error(stderr.trim() || `git exit ${code}`));
    });
    child.on('error', reject);
  });
}
