/**
 * lib/ux-manager.js
 * UX 관리자 — 명령어 오타 추천, 별칭 관리, 페이지네이션
 */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import inquirer from 'inquirer';

// ─────────────────────────────────────────────────────────
// 1. 명령어 오타 추천 (Levenshtein 거리)
// ─────────────────────────────────────────────────────────

/**
 * 두 문자열 사이의 편집 거리(Levenshtein) 계산
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  // dp[i][j] = a[0..i) → b[0..j) 변환 최소 비용
  const dp = Array.from({ length: m + 1 }, (_, i) => Array(n + 1).fill(0).map((_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * 사용자가 입력한 명령어에서 가장 유사한 후보를 반환
 * 거리 ≤ maxDist(기본 3) 인 경우에만 반환
 * @param {string}   input        사용자 입력 (예: '/mdoel')
 * @param {string[]} allCommands  등록된 명령어 목록 (예: ['/model', '/help', ...])
 * @param {number}   maxDist      허용 최대 편집 거리
 * @returns {string|null}
 */
export function suggestCommand(input, allCommands, maxDist = 3) {
  const lower = input.toLowerCase();
  let best = null, bestDist = Infinity;
  for (const cmd of allCommands) {
    const dist = levenshtein(lower, cmd.toLowerCase());
    if (dist < bestDist) { bestDist = dist; best = cmd; }
  }
  return bestDist > 0 && bestDist <= maxDist ? best : null;
}

// ─────────────────────────────────────────────────────────
// 2. 별칭(Alias) 관리
// ─────────────────────────────────────────────────────────

const ALIAS_FILE = path.join(os.homedir(), '.mycli', 'aliases.json');

/** 메모리 캐시 */
let _aliases = {};

/**
 * 별칭 파일 로드 (startCLI 에서 1회 호출)
 * @returns {Record<string,string>}
 */
export async function loadAliases() {
  try {
    const raw = await fs.readFile(ALIAS_FILE, 'utf-8');
    _aliases = JSON.parse(raw);
  } catch {
    _aliases = {};
  }
  return { ..._aliases };
}

/** 현재 별칭 목록 반환 */
export function getAliases() {
  return { ..._aliases };
}

/**
 * 별칭 저장
 * @param {string} name    별칭 이름 (앞의 / 제외)
 * @param {string} command 매핑될 실제 명령어 (예: '/session-save')
 */
export async function saveAlias(name, command) {
  _aliases[name] = command;
  await _flush();
}

/**
 * 별칭 삭제
 * @param {string} name
 * @returns {boolean} 삭제 성공 여부
 */
export async function deleteAlias(name) {
  if (!(name in _aliases)) return false;
  delete _aliases[name];
  await _flush();
  return true;
}

async function _flush() {
  await fs.mkdir(path.dirname(ALIAS_FILE), { recursive: true });
  await fs.writeFile(ALIAS_FILE, JSON.stringify(_aliases, null, 2), 'utf-8');
}

/**
 * 별칭 해석 — 입력이 별칭이면 실제 명령어로 확장
 * @param {string} rawInput  사용자 입력 전체 (예: '/ss my-session')
 * @returns {string|null}    확장된 명령어 or null (별칭 없음)
 */
export function resolveAlias(rawInput) {
  const parts = rawInput.trim().split(/\s+/);
  const name = parts[0].replace(/^\//, ''); // '/' 제거
  if (!_aliases[name]) return null;
  const base = _aliases[name];
  const rest = parts.slice(1).join(' ');
  return rest ? `${base} ${rest}` : base;
}

// ─────────────────────────────────────────────────────────
// 3. 페이지네이션
// ─────────────────────────────────────────────────────────

/**
 * 긴 텍스트를 페이지 단위로 출력
 * 줄 수가 pageSize 이하면 바로 출력
 * @param {string} text
 * @param {number} pageSize  한 페이지에 표시할 줄 수 (기본 20)
 */
export async function paginate(text, pageSize = 20) {
  const lines = text.split('\n');
  if (lines.length <= pageSize) {
    console.log(text);
    return;
  }

  let offset = 0;
  while (offset < lines.length) {
    const page = lines.slice(offset, offset + pageSize).join('\n');
    console.log(page);
    offset += pageSize;

    if (offset < lines.length) {
      const remaining = lines.length - offset;
      const { action } = await inquirer.prompt([{
        type: 'expand',
        name: 'action',
        message: `  ── ${offset}/${lines.length}줄 (남은 ${remaining}줄) ──`,
        default: 'n',
        choices: [
          { key: 'n', name: '다음 페이지', value: 'next' },
          { key: 'a', name: '전체 출력',   value: 'all'  },
          { key: 'q', name: '중단',        value: 'quit' },
        ],
      }]);
      if (action === 'quit') break;
      if (action === 'all') {
        console.log(lines.slice(offset).join('\n'));
        break;
      }
    }
  }
}
