// =========================================================
// 스킬 시스템
// ~/.mycli/skills/ 및 ./.mycli/skills/ 에서 SKILL.md 자동 스캔.
// disable-model-invocation: true → 수동 /명령어 전용, AI 자동 호출 불가.
// =========================================================
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      meta[key] = rawVal.slice(1, -1).split(',').map(v => v.trim()).filter(Boolean);
    } else {
      meta[key] = rawVal;
    }
  }
  return { meta, body: match[2] };
}

export async function loadSkills() {
  const skills = [];
  const searchDirs = [
    path.join(os.homedir(), '.mycli', 'skills'),
    path.join(process.cwd(), '.mycli', 'skills'),
  ];

  for (const dir of searchDirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = path.join(dir, entry.name, 'SKILL.md');
      try {
        const raw = await fs.readFile(skillMdPath, 'utf-8');
        const { meta, body } = parseFrontmatter(raw);
        if (!meta.name) continue;
        skills.push({
          name: meta.name,
          description: meta.description || '',
          prompt: body.trim(),
          disableModelInvocation: meta['disable-model-invocation'] === 'true',
        });
      } catch {
        // SKILL.md 없거나 읽기 실패 → 스킵
      }
    }
  }
  return skills;
}
