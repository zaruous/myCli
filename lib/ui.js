/**
 * lib/ui.js
 * 콘솔 UI 유틸리티 — 스피너 (모듈 싱글턴)
 */
import chalk from 'chalk';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let _spinIdx      = 0;
let _spinInterval = null;
let _spinLabel    = '';

/**
 * 스피너 시작
 * @param {string} label 표시할 메시지
 */
export function startSpinner(label = '생각 중...') {
  _spinLabel = label;
  _spinIdx   = 0;
  if (_spinInterval) clearInterval(_spinInterval);
  _spinInterval = setInterval(() => {
    process.stdout.write(
      `\r${chalk.blue(SPINNER_FRAMES[_spinIdx++ % SPINNER_FRAMES.length])} ${chalk.gray(_spinLabel)}   `
    );
  }, 80);
}

/**
 * 스피너 레이블 변경 (인터벌 유지)
 * @param {string} label 새 메시지
 */
export function updateSpinner(label) {
  _spinLabel = label;
}

/**
 * 스피너 중지 및 줄 지우기
 */
export function stopSpinner() {
  if (_spinInterval) {
    clearInterval(_spinInterval);
    _spinInterval = null;
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
}
