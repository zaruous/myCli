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
  // 접두사(startsWith) 비교는 '/base' 와 '/base-secret' 을 구분하지 못한다.
  // path.relative 로 실제 상위 관계를 확인해야 형제 디렉터리 탈출을 막을 수 있다.
  // (win32 의 path.relative 는 대소문자·드라이브 문자를 정규화해서 비교한다)
  const rel = path.relative(baseDir, resolvedPath);
  const escapes = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
  if (rel !== '' && escapes) {
    throw new Error('보안 경고: 현재 작업 디렉터리를 벗어난 파일에는 접근할 수 없습니다.');
  }
  return resolvedPath;
}

/**
 * 경로를 BASE_DIR 기준 상대경로(POSIX 구분자)로 정규화한다.
 * 절대경로·'..' 가 섞인 경로를 glob 결과(상대경로)와 대조할 때 사용.
 * @param {string} targetPath
 * @returns {string|null} BASE_DIR 밖이면 null, BASE_DIR 자기 자신이면 '.'
 */
export function toBaseRelative(targetPath) {
  let abs;
  try { abs = getSafePath(targetPath); } catch { return null; }
  const rel = path.relative(getBaseDir(), abs);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

export function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
