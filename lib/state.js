// =========================================================
// 공유 가변 상태 허브
// BASE_DIR, planModeState, readFileState를 단일 모듈에서 관리.
// ESM 모듈 싱글턴 보장으로 여러 모듈이 import해도 동일 인스턴스 참조.
// =========================================================
let _baseDir = process.cwd();

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
