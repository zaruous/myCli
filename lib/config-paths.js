/**
 * lib/config-paths.js
 * 설정 파일 탐색 경로 — BASE_DIR 과 process.cwd() 를 모두 본다.
 *
 * 기존에는 mcps/ · mycli.md · hooks.json 을 process.cwd() 에서만 찾았다.
 * 그래서 MYCLI_WORKDIR 를 설정하거나 전역 설치 후 다른 디렉터리에서 실행하면
 * 파일 도구는 BASE_DIR 을 보는데 설정만 cwd 를 봐서 조용히 로드되지 않았다.
 *
 * 두 경로가 같으면 하나만, 다르면 BASE_DIR 을 먼저 반환한다. (가산 방식이므로
 * 기존에 동작하던 cwd 기준 설정은 그대로 계속 동작한다)
 */
import path from 'path';
import { getBaseDir } from './state.js';

/**
 * 프로젝트 설정을 찾을 루트 디렉터리 목록 (중복 제거, BASE_DIR 우선)
 * @returns {string[]}
 */
export function getProjectRoots() {
  const roots = [getBaseDir(), process.cwd()].map(d => path.resolve(d));
  return [...new Set(roots)];
}

/**
 * 각 프로젝트 루트 아래의 같은 상대경로들을 모아 반환한다.
 * @param {...string} segments  예: ('.mycli', 'hooks.json')
 * @returns {string[]}
 */
export function resolveProjectPaths(...segments) {
  return getProjectRoots().map(root => path.join(root, ...segments));
}
