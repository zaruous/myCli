// =========================================================
// 명령어 이력 관리
// 최대 100개 유지, ~/.kyj_cli_history 파일에 append.
// =========================================================
import fs from 'fs/promises';
import chalk from 'chalk';
import { HISTORY_FILE } from './utils.js';

let commandHistory = [];

export async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    commandHistory = data.split('\n').filter(l => l.trim() !== '');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(chalk.red('명령어 히스토리 로딩 실패:'), error);
    }
    commandHistory = [];
  }
}

export async function saveHistory(command) {
  commandHistory.push(command);
  if (commandHistory.length > 100) commandHistory.shift();
  try {
    await fs.appendFile(HISTORY_FILE, command + '\n', 'utf-8');
  } catch (error) {
    console.error(chalk.red('명령어 히스토리 저장 실패:'), error);
  }
}
