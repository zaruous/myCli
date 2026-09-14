// =========================================================
// 프로젝트 컨텍스트 파일
// mycli.md → .mycli/context.md 순으로 탐색.
// 발견 시 내용을 시스템 프롬프트에 주입.
// =========================================================
import fs from 'fs/promises';
import { resolveProjectPaths } from './config-paths.js';

export async function loadProjectContext() {
  // BASE_DIR 과 cwd 양쪽에서 탐색 (MYCLI_WORKDIR 사용 시에도 찾도록)
  const candidates = [
    ...resolveProjectPaths('mycli.md'),
    ...resolveProjectPaths('.mycli', 'context.md'),
  ];
  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim();
    } catch {
      // 없으면 스킵
    }
  }
  return null;
}
