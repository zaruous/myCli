/**
 * lib/ui.js
 * 콘솔 UI 유틸리티 — 스피너, 히스토리 프롬프트 (모듈 싱글턴)
 */
import chalk from 'chalk';
import readline from 'readline';
import path from 'path';
import { glob } from 'glob';
import { getBaseDir } from './state.js';

// ─────────────────────────────────────────────────────────────
// 스피너
// ─────────────────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let _spinIdx      = 0;
let _spinInterval = null;
let _spinLabel    = '';

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

export function updateSpinner(label) {
  _spinLabel = label;
}

export function stopSpinner() {
  if (_spinInterval) {
    clearInterval(_spinInterval);
    _spinInterval = null;
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
}

// ─────────────────────────────────────────────────────────────
// 프롬프트 힌트 (Claude Code의 NUM_TIMES_QUEUE_HINT_SHOWN 패턴)
// ─────────────────────────────────────────────────────────────
const HINT_MAX_SHOW = 3;
let _hintShownCount = 0;

function maybeShowHint(hasCompletions) {
  if (_hintShownCount >= HINT_MAX_SHOW) return;
  _hintShownCount++;
  const parts = [
    chalk.gray('↑↓') + chalk.dim(' 히스토리'),
    chalk.gray('Ctrl+R') + chalk.dim(' 역방향 검색'),
  ];
  if (hasCompletions) parts.push(chalk.gray('Tab') + chalk.dim(' 자동완성'));
  process.stdout.write(chalk.dim('  ' + parts.join('   ') + '\n'));
}

// ─────────────────────────────────────────────────────────────
// Tab 자동완성 (슬래시 명령어 + @파일)
// ─────────────────────────────────────────────────────────────
let _cachedFiles = [];
let _fileCacheTs = 0;
const FILE_CACHE_TTL = 5000; // 5초

async function getCachedFiles() {
  const now = Date.now();
  if (now - _fileCacheTs > FILE_CACHE_TTL) {
    try {
      _cachedFiles = await glob('**/*', {
        cwd: getBaseDir(),
        ignore: ['node_modules/**', '.git/**', '**/.git/**', '**/node_modules/**'],
        nodir: true,
      });
      _fileCacheTs = now;
    } catch {
      _cachedFiles = [];
    }
  }
  return _cachedFiles;
}

/**
 * readline completer: 슬래시 명령어와 @파일명을 자동완성
 * @param {string[]} slashCmds  등록된 슬래시 명령어 목록 (예: ['/help', '/status', ...])
 */
function makeCompleter(slashCmds) {
  return function completer(line, callback) {
    // @파일 자동완성
    if (line.includes('@')) {
      const atIdx   = line.lastIndexOf('@');
      const partial = line.slice(atIdx + 1);
      getCachedFiles().then(files => {
        const hits = files.filter(f =>
          path.basename(f).toLowerCase().startsWith(partial.toLowerCase())
        );
        const completions = hits.map(f => line.slice(0, atIdx + 1) + f);
        callback(null, [completions.length ? completions : [], line]);
      }).catch(() => callback(null, [[], line]));
      return;
    }

    // /슬래시 명령어 자동완성
    if (line.startsWith('/')) {
      const hits = slashCmds.filter(c => c.startsWith(line));
      callback(null, [hits.length ? hits : slashCmds, line]);
      return;
    }

    callback(null, [[], line]);
  };
}

// ─────────────────────────────────────────────────────────────
// 메인 프롬프트
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// readline 기반 확인/입력 헬퍼
// inquirer 대신 사용해 readline ↔ inquirer 전환 시 터미널 상태
// 충돌(한글 IME 커서 튀는 현상 등)을 방지한다.
// ─────────────────────────────────────────────────────────────

// ── 테스트용 Mock 상태 ────────────────────────────────────────
const _mock = { active: false, responses: [] };

/** 테스트에서 응답을 미리 큐에 넣어 대화형 프롬프트를 자동화합니다. */
export function setMockResponses(responses) {
  _mock.active    = true;
  _mock.responses = [...responses];
}

/** Mock 상태를 초기화합니다. */
export function resetMock() {
  _mock.active    = false;
  _mock.responses = [];
}

/**
 * Y/N 확인 프롬프트
 * @param {string}  message     질문 메시지
 * @param {boolean} defaultYes  기본값 true → Y, false → N
 * @returns {Promise<boolean>}
 */
export function confirmPrompt(message, defaultYes = true) {
  if (_mock.active) {
    const val = _mock.responses.shift();
    return Promise.resolve(val !== undefined ? Boolean(val) : defaultYes);
  }
  return new Promise((resolve) => {
    const hint = defaultYes ? chalk.gray('(Y/n)') : chalk.gray('(y/N)');
    const rl = readline.createInterface({
      input: process.stdin, output: process.stdout, terminal: true,
    });
    rl.on('SIGINT', () => { rl.close(); resolve(false); });
    rl.question(`${message} ${hint} `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === '' ? defaultYes : a === 'y' || a === 'yes');
    });
  });
}

/**
 * 단일 키 선택 프롬프트 (expand 대체)
 * @param {string} message  질문 메시지
 * @param {{ key: string, label: string, value: string }[]} choices
 * @param {string} defaultKey  기본 선택 키
 * @returns {Promise<string>}  선택된 value
 */
export function selectKeyPrompt(message, choices, defaultKey) {
  if (_mock.active) {
    const val = _mock.responses.shift();
    const def = choices.find(c => c.key === defaultKey)?.value ?? choices[0].value;
    return Promise.resolve(typeof val === 'string' ? val : def);
  }
  return new Promise((resolve) => {
    const hint = choices.map(c =>
      c.key === defaultKey ? chalk.bold(c.key.toUpperCase()) : c.key
    ).join('/');
    const choiceDesc = choices.map(c => `  ${chalk.bold(c.key)} - ${c.label}`).join('\n');
    console.log(choiceDesc);

    const rl = readline.createInterface({
      input: process.stdin, output: process.stdout, terminal: true,
    });
    rl.on('SIGINT', () => {
      rl.close();
      const def = choices.find(c => c.key === defaultKey);
      resolve(def ? def.value : choices[0].value);
    });
    rl.question(`${message} [${hint}] `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      const found = choices.find(c => c.key === a);
      if (found) return resolve(found.value);
      const def = choices.find(c => c.key === defaultKey);
      resolve(def ? def.value : choices[0].value);
    });
  });
}

/**
 * 단순 텍스트 입력 프롬프트 (inquirer input 대체)
 * @param {string} message
 * @returns {Promise<string>}
 */
export function inputPrompt(message) {
  if (_mock.active) {
    const val = _mock.responses.shift();
    return Promise.resolve(typeof val === 'string' ? val : '');
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin, output: process.stdout, terminal: true,
    });
    rl.on('SIGINT', () => { rl.close(); resolve(''); });
    rl.question(`${message} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * UP/DOWN 히스토리 탐색 + Tab 자동완성 + @ 인라인 파일 피커를 지원하는 입력 프롬프트
 *
 * @param {string}        message     프롬프트 메시지 (chalk 색상 포함 가능)
 * @param {string[]}      history     입력 이력 (오래된 순)
 * @param {string[]}      slashCmds   Tab 자동완성할 슬래시 명령어 목록
 * @param {Function|null} filePicker  (keyword?: string) => Promise<string|undefined>
 *                                    @ 입력 시 즉시 호출할 파일 선택 함수
 * @returns {Promise<string>}
 */
export function promptWithHistory(message, history = [], slashCmds = [], filePicker = null) {
  return new Promise((resolve, reject) => {
    maybeShowHint(slashCmds.length > 0);

    // readline 인스턴스를 재생성할 수 있도록 팩토리로 분리
    // (@ 선택 후 선택 결과를 pre-fill 해서 다시 열기 위함)
    const createRl = (initialValue = '') => {
      const rl = readline.createInterface({
        input:       process.stdin,
        output:      process.stdout,
        terminal:    true,
        history:     [...history].reverse(),
        historySize: 200,
        completer:   makeCompleter(slashCmds),
      });

      // ── @ 인라인 파일 피커 ──────────────────────────────
      let atHandler = null;
      if (filePicker) {
        atHandler = async (str) => {
          if (str !== '@') return;

          // rl.line 은 readline 이 처리한 후 갱신되므로 @ 포함 여부가 타이밍에 따라 다름
          // lastIndexOf('@') 로 안전하게 @ 이전 텍스트 추출
          const currentLine = rl.line || '';
          const atIdx       = currentLine.lastIndexOf('@');
          const beforeAt    = atIdx >= 0 ? currentLine.slice(0, atIdx) : currentLine;

          process.stdin.removeListener('keypress', atHandler);
          // 현재 줄을 지우고 readline 닫기
          process.stdout.write('\r\x1b[2K');
          rl.close();

          process.stdout.write('\n');
          try {
            const selectedFile = await filePicker('');
            const newValue = selectedFile
              ? beforeAt + '@' + selectedFile + ' '
              : beforeAt;
            createRl(newValue);
          } catch {
            createRl(beforeAt);
          }
        };
        process.stdin.on('keypress', atHandler);
      }

      // ── SIGINT ───────────────────────────────────────────
      rl.on('SIGINT', () => {
        if (atHandler) process.stdin.removeListener('keypress', atHandler);
        rl.close();
        const err = new Error('User interrupted');
        err.name = 'ExitPromptError';
        reject(err);
      });

      // ── 입력 완료 ────────────────────────────────────────
      rl.question(message + ' ', (answer) => {
        if (atHandler) process.stdin.removeListener('keypress', atHandler);
        rl.close();
        resolve(answer);
      });

      // @ 선택 후 복원된 텍스트를 readline 에 pre-fill
      if (initialValue) {
        setImmediate(() => rl.write(initialValue));
      }
    };

    createRl();
  });
}
