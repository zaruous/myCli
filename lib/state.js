// =========================================================
// 공유 가변 상태 허브
// BASE_DIR, planModeState, readFileState를 단일 모듈에서 관리.
// ESM 모듈 싱글턴 보장으로 여러 모듈이 import해도 동일 인스턴스 참조.
// =========================================================
import fs from 'fs';
import path from 'path';

function resolveBaseDir() {
  const envDir = process.env.MYCLI_WORKDIR;
  if (!envDir) return process.cwd();

  const resolved = path.resolve(envDir);
  if (!fs.existsSync(resolved)) {
    console.error(`[경고] MYCLI_WORKDIR 경로가 존재하지 않습니다: ${resolved}`);
    console.error(`       process.cwd() 로 대체합니다.`);
    return process.cwd();
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    console.error(`[경고] MYCLI_WORKDIR 경로가 디렉터리가 아닙니다: ${resolved}`);
    console.error(`       process.cwd() 로 대체합니다.`);
    return process.cwd();
  }
  return resolved;
}

let _baseDir = resolveBaseDir();

export function getBaseDir() {
  return _baseDir;
}

export function setBaseDir(dir) {
  _baseDir = dir;
}

// write_file / execute_shell_command 차단 상태
export const planModeState = {
  active: false,
  enteredAt: null, // Date
};

// read-before-write 추적: absPath → { timestamp, isPartial }
export const readFileState = new Map();

// 현재 턴의 사용자 입력 (훅 환경변수 MYCLI_INPUT 용)
let _currentInput = '';
export function getCurrentInput() { return _currentInput; }
export function setCurrentInput(v) { _currentInput = v; }
