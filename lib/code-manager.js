/**
 * lib/code-manager.js
 * 파일 작업 이력 관리 — 최근 접근 파일 추적 & 되돌리기 스택
 */
import fs from 'fs/promises';
import path from 'path';

const MAX_UNDO_STACK  = 20;  // 되돌리기 스택 최대 깊이
const MAX_RECENT_OPS  = 50;  // 최근 작업 이력 최대 개수

/** @type {Array<{type,filePath,timestamp,before,after}>} */
const _recentOps = [];

/** @type {Array<{filePath,before,timestamp}>} */
const _undoStack = [];

/**
 * 파일 작업 기록
 * @param {'read'|'write'|'edit'} type
 * @param {string}  filePath   절대 경로
 * @param {string|null} before 수정 전 내용 (read 는 null)
 * @param {string|null} after  수정 후 내용 (read 는 null)
 */
export function recordOp({ type, filePath, before = null, after = null }) {
  const entry = { type, filePath, timestamp: Date.now(), before, after };

  _recentOps.unshift(entry);
  if (_recentOps.length > MAX_RECENT_OPS) _recentOps.pop();

  // read 는 되돌리기 불필요
  if (type === 'write' || type === 'edit') {
    _undoStack.push({ filePath, before, timestamp: entry.timestamp });
    if (_undoStack.length > MAX_UNDO_STACK) _undoStack.shift();
  }
}

/**
 * 최근 작업 이력 반환
 * @param {number} n 반환할 개수 (기본 15)
 * @returns {Array}
 */
export function getRecentOps(n = 15) {
  return _recentOps.slice(0, n);
}

/**
 * 되돌리기 스택 크기 반환
 */
export function getUndoCount() {
  return _undoStack.length;
}

/**
 * 마지막 파일 작업 되돌리기
 * - before=null 이면 신규 파일이었으므로 삭제
 * - before=문자열이면 해당 내용으로 복원
 * @returns {{action:'deleted'|'restored', filePath:string}|null}
 */
export async function undoLastOp() {
  if (_undoStack.length === 0) return null;

  const op = _undoStack.pop();

  if (op.before === null) {
    // 새로 생성된 파일 → 삭제
    await fs.rm(op.filePath, { force: true });
    return { action: 'deleted', filePath: op.filePath };
  }

  // 기존 파일 수정 → 이전 내용 복원
  await fs.mkdir(path.dirname(op.filePath), { recursive: true });
  await fs.writeFile(op.filePath, op.before, 'utf-8');
  return { action: 'restored', filePath: op.filePath };
}

/**
 * 이력 및 스택 초기화 (테스트용)
 */
export function clearHistory() {
  _recentOps.length = 0;
  _undoStack.length = 0;
}
