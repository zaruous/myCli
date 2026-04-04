// =========================================================
// 보안 및 유틸리티
// getSafePath: BASE_DIR 벗어난 경로 접근 차단.
// =========================================================
import path from 'path';
import os from 'os';
import { getBaseDir } from './state.js';

export const HISTORY_FILE = path.join(os.homedir(), '.kyj_cli_history');

export function getSafePath(targetPath) {
  const baseDir = getBaseDir();
  const resolvedPath = path.resolve(baseDir, targetPath);
  if (!resolvedPath.startsWith(baseDir)) {
    throw new Error('보안 경고: 현재 작업 디렉터리를 벗어난 파일에는 접근할 수 없습니다.');
  }
  return resolvedPath;
}

export function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
