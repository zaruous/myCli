/**
 * lib/hooks.js
 * Hook 로더 · 이벤트 발행 · 실행 엔진
 *
 * 설정 파일 우선순위:
 *   1. <cwd>/.mycli/hooks.json  (프로젝트 로컬)
 *   2. ~/.mycli/hooks.json      (전역)
 *   로컬이 있으면 해당 이벤트 항목을 전역 뒤에 append
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import chalk from 'chalk';

import { logHookEvent } from './hook-logger.js';

const DEFAULT_TIMEOUT = 10_000;

/** 로드된 훅 설정: { [event]: Array<{ matcher, hooks }> } */
let _hooks = {};

// ─────────────────────────────────────────────────────────
// 로더
// ─────────────────────────────────────────────────────────
export async function loadHooks() {
  const globalPath = path.join(os.homedir(), '.mycli', 'hooks.json');
  const localPath  = path.join(process.cwd(), '.mycli', 'hooks.json');

  let globalHooks = {}, localHooks = {};

  try {
    const raw = await fs.readFile(globalPath, 'utf-8');
    globalHooks = JSON.parse(raw).hooks ?? {};
  } catch { /* 없으면 빈 객체 */ }

  try {
    const raw = await fs.readFile(localPath, 'utf-8');
    localHooks = JSON.parse(raw).hooks ?? {};
  } catch { /* 없으면 빈 객체 */ }

  // 이벤트별로 전역 + 로컬 merge (로컬을 뒤에 추가)
  _hooks = { ...globalHooks };
  for (const [event, entries] of Object.entries(localHooks)) {
    _hooks[event] = [...(_hooks[event] ?? []), ...entries];
  }
}

export function getLoadedHooks() {
  return _hooks;
}

// ─────────────────────────────────────────────────────────
// 단일 커맨드 실행
// ─────────────────────────────────────────────────────────
function runCommand(command, envVars, timeout) {
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: true,
      env: { ...process.env, ...envVars },
      windowsHide: true,
    });

    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exitCode: -1, stdout, stderr, timedOut: true });
    }, timeout);

    child.stdout?.on('data', d => { stdout += d.toString('utf-8'); });
    child.stderr?.on('data', d => { stderr += d.toString('utf-8'); });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr, timedOut: false });
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: e.message, timedOut: false });
    });
  });
}

// ─────────────────────────────────────────────────────────
// 이벤트 발행
// ─────────────────────────────────────────────────────────
/**
 * @param {string} event  - 이벤트 이름
 * @param {Record<string,string>} env - 이벤트별 환경변수 (MYCLI_* 키)
 * @returns {{ blocked: boolean, output: string }}
 */
export async function emitHook(event, env) {
  const fullEnv = { MYCLI_EVENT: event, ...env };

  // 빌트인 SQLite 로거 — 항상 먼저 실행
  try { logHookEvent(fullEnv); } catch { /* 로깅 실패 무시 */ }

  const entries = _hooks[event] ?? [];
  if (entries.length === 0) return { blocked: false, output: '' };

  // matcher 대상: 도구 이름 > 사용자 입력 > 빈 문자열
  const matchTarget = env.MYCLI_TOOL_NAME ?? env.MYCLI_INPUT ?? '';

  let blocked = false;
  let lastOutput = '';

  for (const entry of entries) {
    const matcher = entry.matcher ?? '.*';

    let matches = false;
    try { matches = new RegExp(matcher).test(matchTarget); } catch { continue; }
    if (!matches) continue;

    for (const hook of (entry.hooks ?? [])) {
      if (hook.type && hook.type !== 'command') continue;
      if (!hook.command) continue;

      const timeout = typeof hook.timeout === 'number' ? hook.timeout : DEFAULT_TIMEOUT;
      const hookEnv = { ...fullEnv, MYCLI_HOOK_OUTPUT: lastOutput };

      const result = await runCommand(hook.command, hookEnv, timeout);

      if (result.timedOut) {
        console.error(chalk.yellow(`\n[훅] 타임아웃 (${timeout}ms): ${hook.command}`));
        continue;
      }

      if (result.stderr) {
        console.error(chalk.gray(`[훅 stderr] ${result.stderr.trim()}`));
      }

      lastOutput = result.stdout.trim();

      // PreToolCall 에서 exit code ≠ 0 → 차단
      if (event === 'PreToolCall' && result.exitCode !== 0) {
        console.error(chalk.red(`[훅] 도구 실행 차단 (exit ${result.exitCode}): ${hook.command}`));
        blocked = true;
        break;
      }
    }

    if (blocked) break;
  }

  return { blocked, output: lastOutput };
}
