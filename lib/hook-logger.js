/**
 * lib/hook-logger.js
 * 빌트인 SQLite 훅 이벤트 로거
 * MYCLI_HOOK_LOG=true (기본) 일 때 모든 훅 이벤트를 ~/.mycli/hook-log.db 에 기록
 */
import path from 'path';
import os from 'os';
import fssync from 'fs';

let db = null;

// ─────────────────────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────────────────────
export async function initHookLogger() {
  if (process.env.MYCLI_HOOK_LOG === 'false') return;

  try {
    const { default: Database } = await import('better-sqlite3');
    const dbPath = process.env.MYCLI_HOOK_LOG_DB
      || path.join(os.homedir(), '.mycli', 'hook-log.db');

    fssync.mkdirSync(path.dirname(dbPath), { recursive: true });

    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS hook_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        event       TEXT    NOT NULL,
        tool_name   TEXT,
        tool_input  TEXT,
        tool_output TEXT,
        user_input  TEXT,
        ai_output   TEXT,
        provider    TEXT,
        base_dir    TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.error('[훅 로거] 초기화 실패 (기능은 계속 동작합니다):', e.message);
    db = null;
  }
}

// ─────────────────────────────────────────────────────────
// 이벤트 1건 기록
// ─────────────────────────────────────────────────────────
export function logHookEvent(env) {
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO hook_events
        (event, tool_name, tool_input, tool_output, user_input, ai_output, provider, base_dir)
      VALUES
        (@event, @tool_name, @tool_input, @tool_output, @user_input, @ai_output, @provider, @base_dir)
    `).run({
      event:       env.MYCLI_EVENT       ?? null,
      tool_name:   env.MYCLI_TOOL_NAME   ?? null,
      tool_input:  env.MYCLI_TOOL_INPUT  ?? null,
      tool_output: env.MYCLI_TOOL_OUTPUT ?? null,
      user_input:  env.MYCLI_INPUT       ?? null,
      ai_output:   env.MYCLI_OUTPUT      ?? null,
      provider:    env.MYCLI_PROVIDER    ?? null,
      base_dir:    env.MYCLI_BASE_DIR    ?? null,
    });
  } catch { /* 로깅 실패는 무시 */ }
}

// ─────────────────────────────────────────────────────────
// 조회 / 삭제 (commands.js 에서 사용)
// ─────────────────────────────────────────────────────────
export function queryHookEvents({ event, tool, limit = 20, offset = 0 } = {}) {
  if (!db) return [];
  try {
    let sql = 'SELECT * FROM hook_events WHERE 1=1';
    const params = [];
    if (event) { sql += ' AND event = ?';     params.push(event); }
    if (tool)  { sql += ' AND tool_name = ?'; params.push(tool);  }
    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return db.prepare(sql).all(...params);
  } catch { return []; }
}

export function countHookEvents({ event, tool } = {}) {
  if (!db) return 0;
  try {
    let sql = 'SELECT COUNT(*) as cnt FROM hook_events WHERE 1=1';
    const params = [];
    if (event) { sql += ' AND event = ?';     params.push(event); }
    if (tool)  { sql += ' AND tool_name = ?'; params.push(tool);  }
    return db.prepare(sql).get(...params).cnt;
  } catch { return 0; }
}

export function clearHookEvents() {
  if (!db) return 0;
  try {
    const info = db.prepare('DELETE FROM hook_events').run();
    return info.changes;
  } catch { return 0; }
}

export function isLoggerReady() {
  return db !== null;
}

export function closeHookLogger() {
  if (db) { db.close(); db = null; }
}
