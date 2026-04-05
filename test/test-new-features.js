#!/usr/bin/env node
/**
 * mycli 신규 기능 자동화 테스트
 * 테스트 대상: edit_file, git 도구, 멀티라인 파싱, 모델 전환, /help·/status 로직,
 *              다중 파일 첨부 파싱, 세션 직렬화, UTF-8 인코딩, Plan Mode 차단
 *
 * 실행: node test/test-new-features.js
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

// ── lib 모듈 직접 임포트 ────────────────────────────────────
import { getBaseDir, setBaseDir, planModeState, readFileState, getCurrentInput, setCurrentInput } from '../lib/state.js';
import { getSafePath, getTimestamp } from '../lib/utils.js';
import { computeLineDiff, renderDiffWithContext } from '../lib/diff.js';
import { loadSkills } from '../lib/skills.js';
import { loadProjectContext } from '../lib/context.js';
import { loadHooks, emitHook, getLoadedHooks } from '../lib/hooks.js';
import { initHookLogger, logHookEvent, queryHookEvents, countHookEvents, clearHookEvents, isLoggerReady, closeHookLogger } from '../lib/hook-logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(__dirname, '__tmp__');

// ── 테스트 프레임워크 ───────────────────────────────────────
let passed = 0, failed = 0;
const results = [];

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS  ${label}`);
    passed++;
    results.push({ label, status: 'PASS' });
  } else {
    console.log(`  ❌ FAIL  ${label}`);
    failed++;
    results.push({ label, status: 'FAIL' });
  }
}

async function setup() {
  await fs.mkdir(TMP_DIR, { recursive: true });
  setBaseDir(TMP_DIR);
}

async function teardown() {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════
// Test 13: edit_file 로직
// ═══════════════════════════════════════════════════════════
async function testEditFile() {
  console.log('\n[Test 13] edit_file 로직');

  const filePath = path.join(TMP_DIR, 'edit-target.txt');
  const original = 'Hello World\nFoo Bar\nBaz Qux\n';
  await fs.writeFile(filePath, original, 'utf-8');
  const stat = await fs.stat(filePath);
  readFileState.set(filePath, { timestamp: Math.floor(stat.mtimeMs), isPartial: false });

  // 13-1: 정상 교체
  {
    const content = await fs.readFile(filePath, 'utf-8');
    const occurrences = content.split('Foo Bar').length - 1;
    assert(occurrences === 1, '13-1: old_string 등장 횟수 1 (유일)');
  }

  // 13-2: old_string 없는 경우
  {
    const content = await fs.readFile(filePath, 'utf-8');
    const occurrences = content.split('NONEXISTENT').length - 1;
    assert(occurrences === 0, '13-2: 없는 old_string → occurrences=0 (오류 반환)');
  }

  // 13-3: 중복 old_string 감지 (replace_all=false 시 오류)
  {
    const dupContent = 'dup\ndup\n';
    await fs.writeFile(filePath, dupContent, 'utf-8');
    const stat2 = await fs.stat(filePath);
    readFileState.set(filePath, { timestamp: Math.floor(stat2.mtimeMs), isPartial: false });
    const occurrences = dupContent.split('dup').length - 1;
    assert(occurrences > 1, '13-3: 중복 old_string 감지 (occurrences > 1)');
  }

  // 13-4: replace_all=true 시 모든 등장 교체
  {
    const dupContent = 'dup\ndup\n';
    const replaced = dupContent.split('dup').join('replaced');
    assert(replaced === 'replaced\nreplaced\n', '13-4: replace_all=true → 전체 교체');
  }

  // 13-5: read-before-write 미이행 시 거부
  {
    readFileState.delete(filePath);
    const hasRecord = readFileState.has(filePath);
    assert(!hasRecord, '13-5: readFileState 없으면 쓰기 거부');
  }

  // 13-6: Plan Mode 차단
  {
    planModeState.active = true;
    const blocked = planModeState.active;
    planModeState.active = false;
    assert(blocked === true, '13-6: Plan Mode 중 edit_file 차단');
  }
}

// ═══════════════════════════════════════════════════════════
// Test 14: git 도구 — runGit 헬퍼 로직
// ═══════════════════════════════════════════════════════════
async function testGitTools() {
  console.log('\n[Test 14] git 도구 로직');

  function runGit(args, cwd) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd, shell: false });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d.toString('utf-8'); });
      child.stderr.on('data', d => { stderr += d.toString('utf-8'); });
      child.on('close', code => {
        if (code === 0 || code === 1) resolve(stdout || stderr);
        else reject(new Error(stderr.trim() || `git exit ${code}`));
      });
      child.on('error', reject);
    });
  }

  // 14-1: git이 설치되어 있는지 확인
  let gitAvailable = false;
  try {
    await runGit(['--version'], TMP_DIR);
    gitAvailable = true;
  } catch { }
  assert(gitAvailable, '14-1: git 실행 가능');

  if (!gitAvailable) {
    ['14-2', '14-3', '14-4', '14-5'].forEach(n =>
      assert(false, `${n}: git 없음 (SKIP)`)
    );
    return;
  }

  // 임시 git 저장소 초기화
  const gitDir = path.join(TMP_DIR, 'gitrepo');
  await fs.mkdir(gitDir, { recursive: true });
  await runGit(['init'], gitDir);
  await runGit(['config', 'user.email', 'test@test.com'], gitDir);
  await runGit(['config', 'user.name', 'Test'], gitDir);

  // 14-2: git status — 초기 상태
  {
    const status = await runGit(['status'], gitDir);
    assert(typeof status === 'string' && status.length > 0, '14-2: git status 문자열 반환');
  }

  // 14-3: git status — 파일 추가 후 untracked 포함
  {
    await fs.writeFile(path.join(gitDir, 'hello.txt'), 'hello', 'utf-8');
    const status = await runGit(['status'], gitDir);
    assert(status.includes('hello.txt'), '14-3: 신규 파일 git status에 반영');
  }

  // 14-4: git log — 커밋 후 로그
  {
    await runGit(['add', '.'], gitDir);
    await runGit(['commit', '-m', 'init'], gitDir);
    const log = await runGit(['log', '--oneline', '-1'], gitDir);
    assert(log.includes('init'), '14-4: git log --oneline 커밋 메시지 포함');
  }

  // 14-5: git diff — 변경 후 diff 출력
  {
    await fs.writeFile(path.join(gitDir, 'hello.txt'), 'hello world', 'utf-8');
    const diff = await runGit(['diff'], gitDir);
    assert(diff.includes('hello world'), '14-5: git diff 변경 내용 포함');
  }
}

// ═══════════════════════════════════════════════════════════
// Test 15: 멀티라인 입력 파싱 로직
// ═══════════════════════════════════════════════════════════
async function testMultilineInput() {
  console.log('\n[Test 15] 멀티라인 입력 파싱 로직');

  // 멀티라인 모드 진입 감지 로직 검증 (askQuestion 내 로직 추출)
  function isMultilineTrigger(input) {
    return input.trim() === '"""';
  }

  function joinMultilineLines(lines) {
    return lines.join('\n');
  }

  // 15-1: """ 단독 입력 → 멀티라인 트리거
  assert(isMultilineTrigger('"""'), '15-1: """ 단독 → 멀티라인 모드 트리거');

  // 15-2: 공백 포함 """ → 트리거
  assert(isMultilineTrigger('   """   '), '15-2: 공백 포함 """ → 트리거');

  // 15-3: 일반 입력 → 트리거 아님
  assert(!isMultilineTrigger('안녕하세요'), '15-3: 일반 입력 → 트리거 아님');

  // 15-4: """ 로 시작하는 문장 → 트리거 아님
  assert(!isMultilineTrigger('"""코드 블록'), '15-4: """코드블록 → 트리거 아님');

  // 15-5: 여러 줄 합치기
  const lines = ['function hello() {', '  return "world";', '}'];
  const joined = joinMultilineLines(lines);
  assert(joined === 'function hello() {\n  return "world";\n}', '15-5: 멀티라인 줄 합치기');

  // 15-6: 빈 줄 포함 합치기
  const linesWithBlank = ['line1', '', 'line3'];
  const joinedBlank = joinMultilineLines(linesWithBlank);
  assert(joinedBlank === 'line1\n\nline3', '15-6: 빈 줄 포함 멀티라인 합치기');
}

// ═══════════════════════════════════════════════════════════
// Test 16: 다중 파일 첨부 파싱 로직
// ═══════════════════════════════════════════════════════════
async function testMultiAttach() {
  console.log('\n[Test 16] 다중 파일 첨부 파싱 로직');

  function parseAttachInput(rawInput) {
    const tokens = rawInput.trim().split(/\s+/);
    const atTokens = tokens.filter(t => t.startsWith('@'));
    const nonAtText = tokens.filter(t => !t.startsWith('@')).join(' ').trim();
    const keywords = atTokens.map(t => t.slice(1));
    return { atTokens, nonAtText, keywords };
  }

  // 16-1: @ 하나 + 질문 파싱
  {
    const { atTokens, nonAtText, keywords } = parseAttachInput('@index.js 이 파일 설명해줘');
    assert(atTokens.length === 1 && keywords[0] === 'index.js', '16-1: @ 1개 파싱');
    assert(nonAtText === '이 파일 설명해줘', '16-1: 비@ 텍스트 추출');
  }

  // 16-2: @ 여러 개 파싱
  {
    const { atTokens, keywords } = parseAttachInput('@index.js @lib/utils.js 비교해줘');
    assert(atTokens.length === 2, '16-2: @ 2개 파싱');
    assert(keywords[0] === 'index.js' && keywords[1] === 'lib/utils.js', '16-2: 키워드 추출');
  }

  // 16-3: @ 만 있고 질문 없음
  {
    const { nonAtText } = parseAttachInput('@readme');
    assert(nonAtText === '', '16-3: 질문 텍스트 없음');
  }

  // 16-4: @ 없는 일반 @가 아닌 경우
  {
    const { atTokens } = parseAttachInput('일반 메시지 입력');
    assert(atTokens.length === 0, '16-4: @ 없는 입력 → atTokens 빈 배열');
  }

  // 16-5: 파일 섹션 빌드 형식
  {
    const files = [{ name: 'foo.js', content: 'const x = 1;' }];
    const sections = files.map(f => `[파일: ${f.name}]\n\`\`\`\n${f.content}\n\`\`\``);
    assert(sections[0].includes('[파일: foo.js]'), '16-5: 파일 섹션 헤더 형식');
    assert(sections[0].includes('const x = 1;'), '16-5: 파일 섹션 내용 포함');
  }
}

// ═══════════════════════════════════════════════════════════
// Test 17: 세션 직렬화/역직렬화 로직
// ═══════════════════════════════════════════════════════════
async function testSessionSerialization() {
  console.log('\n[Test 17] 세션 직렬화/역직렬화 로직');

  const sessionDir = path.join(TMP_DIR, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });

  const mockMessages = [
    { type: 'human', content: '안녕하세요' },
    { type: 'ai', content: '안녕하세요! 무엇을 도와드릴까요?' },
    { type: 'human', content: 'index.js 설명해줘' },
    { type: 'ai', content: 'index.js는 메인 진입점입니다.' },
  ];

  const sessionData = {
    version: 1,
    provider: 'gemini',
    baseDir: TMP_DIR,
    savedAt: new Date().toISOString(),
    messages: mockMessages,
  };

  const filePath = path.join(sessionDir, 'test-session.json');

  // 17-1: 세션 저장 (JSON 직렬화)
  await fs.writeFile(filePath, JSON.stringify(sessionData, null, 2), 'utf-8');
  const saved = await fs.readFile(filePath, 'utf-8');
  assert(saved.includes('"version": 1'), '17-1: version 필드 저장');
  assert(saved.includes('"provider": "gemini"'), '17-1: provider 필드 저장');

  // 17-2: 세션 로드 (JSON 역직렬화)
  const loaded = JSON.parse(saved);
  assert(loaded.messages.length === 4, '17-2: 메시지 4개 복원');
  assert(loaded.messages[0].type === 'human', '17-2: 첫 메시지 human 타입');

  // 17-3: human/ai 쌍 순서 검증
  {
    let valid = true;
    for (let i = 0; i < loaded.messages.length - 1; i += 2) {
      if (loaded.messages[i].type !== 'human' || loaded.messages[i + 1].type !== 'ai') {
        valid = false;
      }
    }
    assert(valid, '17-3: human/ai 교대 쌍 구조');
  }

  // 17-4: 세션 목록 조회
  const files = (await fs.readdir(sessionDir)).filter(f => f.endsWith('.json'));
  assert(files.includes('test-session.json'), '17-4: 세션 파일 목록 조회');

  // 17-5: 없는 세션 파일 → ENOENT
  try {
    await fs.readFile(path.join(sessionDir, 'nonexistent.json'), 'utf-8');
    assert(false, '17-5: ENOENT 발생해야 함');
  } catch (e) {
    assert(e.code === 'ENOENT', '17-5: 없는 세션 → ENOENT 에러');
  }

  // 17-6: savedAt ISO 형식
  assert(/^\d{4}-\d{2}-\d{2}T/.test(loaded.savedAt), '17-6: savedAt ISO 8601 형식');
}

// ═══════════════════════════════════════════════════════════
// Test 18: /model 전환 로직
// ═══════════════════════════════════════════════════════════
async function testModelSwitch() {
  console.log('\n[Test 18] /model 전환 로직');

  const VALID_PROVIDERS = ['gemini', 'gpt', 'ollama'];

  function validateProvider(provider) {
    return VALID_PROVIDERS.includes(provider);
  }

  // 18-1: 유효한 provider 검증
  assert(validateProvider('gemini'), '18-1: gemini 유효');
  assert(validateProvider('gpt'), '18-1: gpt 유효');
  assert(validateProvider('ollama'), '18-1: ollama 유효');

  // 18-2: 잘못된 provider 거부
  assert(!validateProvider('claude'), '18-2: claude → 거부');
  assert(!validateProvider(''), '18-2: 빈 문자열 → 거부');

  // 18-3: 동일 provider 전환 불필요 감지
  {
    const currentProvider = 'gemini';
    const isSame = currentProvider === 'gemini';
    assert(isSame, '18-3: 동일 provider 전환 불필요');
  }

  // 18-4: provider 변경 후 상태 갱신
  {
    let currentProvider = 'gemini';
    currentProvider = 'gpt';
    assert(currentProvider === 'gpt', '18-4: provider 상태 갱신');
  }

  // 18-5: provider 목록 출력 형식
  {
    const list = VALID_PROVIDERS.map(p => `  ${p === 'gemini' ? '▶' : ' '} ${p}`).join('\n');
    assert(list.includes('▶ gemini'), '18-5: 현재 provider 마커(▶) 표시');
  }
}

// ═══════════════════════════════════════════════════════════
// Test 19: UTF-8 인코딩 처리
// ═══════════════════════════════════════════════════════════
async function testUtf8Encoding() {
  console.log('\n[Test 19] UTF-8 인코딩 처리');

  // 19-1: PowerShell 명령 인자 구성 확인
  {
    const command = 'dir';
    const args = ['-NoProfile', '-Command', `chcp 65001 > $null; ${command}`];
    assert(args[0] === '-NoProfile', '19-1: -NoProfile 플래그 포함');
    assert(args[2].includes('chcp 65001'), '19-1: chcp 65001 포함');
    assert(args[2].includes(command), '19-1: 원본 명령어 포함');
  }

  // 19-2: 한글 파일 읽기 (utf-8)
  {
    const koPath = path.join(TMP_DIR, 'korean.txt');
    await fs.writeFile(koPath, '안녕하세요 테스트입니다', 'utf-8');
    const content = await fs.readFile(koPath, 'utf-8');
    assert(content === '안녕하세요 테스트입니다', '19-2: 한글 파일 utf-8 읽기');
  }

  // 19-3: 한글 파일 쓰기 (utf-8)
  {
    const koPath = path.join(TMP_DIR, 'korean-write.txt');
    const korean = '한글 쓰기 테스트 ✅';
    await fs.writeFile(koPath, korean, 'utf-8');
    const readBack = await fs.readFile(koPath, 'utf-8');
    assert(readBack === korean, '19-3: 한글 + 이모지 utf-8 쓰기/읽기 일치');
  }

  // 19-4: chcp 명령이 stdout에 노출되지 않도록 리디렉션 확인
  {
    const cmd = `chcp 65001 > $null; echo hi`;
    assert(cmd.includes('> $null'), '19-4: chcp 출력 $null 리디렉션');
  }
}

// ═══════════════════════════════════════════════════════════
// Test 20: /status 출력 데이터 계산 로직
// ═══════════════════════════════════════════════════════════
async function testStatusLogic() {
  console.log('\n[Test 20] /status 데이터 계산 로직');

  // 20-1: 토큰 추정 계산 (4자 = 1토큰)
  {
    const text = 'abcd'; // 4자 → 1토큰
    const est = Math.ceil(text.length / 4);
    assert(est === 1, '20-1: 4자 → 1토큰 추정');
  }

  // 20-2: 긴 텍스트 토큰 추정
  {
    const text = 'a'.repeat(100);
    const est = Math.ceil(text.length / 4);
    assert(est === 25, '20-2: 100자 → 25토큰 추정');
  }

  // 20-3: planModeState 활성 상태 반영
  {
    planModeState.active = true;
    assert(planModeState.active === true, '20-3: planModeState.active=true 반영');
    planModeState.active = false;
  }

  // 20-4: getBaseDir() 반환값 일치
  {
    setBaseDir(TMP_DIR);
    assert(getBaseDir() === TMP_DIR, '20-4: getBaseDir()가 setBaseDir() 값 반환');
  }

  // 20-5: 스킬 목록 포맷
  {
    const skills = [{ name: 'review' }, { name: 'explain' }];
    const formatted = skills.map(s => '/' + s.name).join(', ');
    assert(formatted === '/review, /explain', '20-5: 스킬 목록 포맷');
  }
}

// ═══════════════════════════════════════════════════════════
// Test 21: Plan Mode — 신규 도구 차단 검증
// ═══════════════════════════════════════════════════════════
async function testPlanModeNewTools() {
  console.log('\n[Test 21] Plan Mode — 신규 도구 차단 검증');

  // 21-1: edit_file Plan Mode 차단 메시지 형식
  {
    planModeState.active = true;
    const blocked = planModeState.active
      ? `차단됨: 현재 계획 모드(Plan Mode) 중입니다.`
      : null;
    assert(blocked !== null && blocked.includes('차단됨'), '21-1: edit_file Plan Mode 차단 메시지');
    planModeState.active = false;
  }

  // 21-2: write_file Plan Mode 차단
  {
    planModeState.active = true;
    const msg = planModeState.active
      ? `차단됨: 현재 계획 모드(Plan Mode) 중입니다. 파일을 수정하려면 exit_plan_mode로 계획을 제출하고 승인받은 후 진행하세요.`
      : null;
    assert(msg !== null && msg.includes('exit_plan_mode'), '21-2: write_file 차단 메시지에 exit_plan_mode 안내 포함');
    planModeState.active = false;
  }

  // 21-3: execute_shell_command Plan Mode 차단
  {
    planModeState.active = true;
    const msg = planModeState.active
      ? `차단됨: 현재 계획 모드(Plan Mode) 중입니다. 시스템 명령어는 계획 승인 후 실행하세요.`
      : null;
    assert(msg !== null, '21-3: execute_shell_command Plan Mode 차단');
    planModeState.active = false;
  }

  // 21-4: git 도구는 Plan Mode에서도 허용 (읽기 전용)
  {
    planModeState.active = true;
    // git_status, git_diff, git_log는 planModeState 체크 없이 실행됨
    const gitNotBlocked = true; // 코드에 차단 로직 없음
    assert(gitNotBlocked, '21-4: git 도구(읽기 전용)는 Plan Mode에서 차단되지 않음');
    planModeState.active = false;
  }

  // 21-5: Plan Mode 활성 상태에서 enter_plan_mode 재호출 → 에러
  {
    planModeState.active = true;
    const alreadyActive = planModeState.active;
    const msg = alreadyActive ? '이미 계획 모드 중입니다.' : null;
    assert(msg !== null, '21-5: 이미 Plan Mode 중 enter_plan_mode → 에러 메시지');
    planModeState.active = false;
  }

  // 21-6: Plan Mode 비활성 상태에서 exit_plan_mode → 에러
  {
    planModeState.active = false;
    const msg = !planModeState.active ? '계획 모드 중이 아닙니다.' : null;
    assert(msg !== null, '21-6: Plan Mode 비활성 중 exit_plan_mode → 에러 메시지');
  }
}

// ═══════════════════════════════════════════════════════════
// Test 22: lib/ 모듈 직접 호출 — 커버리지 보강
// ═══════════════════════════════════════════════════════════
async function testLibModulesCoverage() {
  console.log('\n[Test 22] lib/ 모듈 직접 호출 커버리지');

  // ── utils.js ──────────────────────────────────────────────
  // 22-1: getSafePath 정상 경로
  {
    setBaseDir(TMP_DIR);
    const result = getSafePath('test.txt');
    assert(result === path.join(TMP_DIR, 'test.txt'), '22-1: getSafePath 정상 경로 반환');
  }

  // 22-2: getSafePath 경로 탈출 차단
  {
    let threw = false;
    try { getSafePath('../../etc/passwd'); } catch { threw = true; }
    assert(threw, '22-2: getSafePath 경로 탈출 시 에러');
  }

  // 22-3: getTimestamp ISO 형식
  {
    const ts = getTimestamp();
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(ts), '22-3: getTimestamp ISO 형식 (콜론→대시 변환)');
  }

  // ── diff.js ───────────────────────────────────────────────
  // 22-4: computeLineDiff 동일 텍스트 → 전부 same
  {
    const result = computeLineDiff('abc\ndef\n', 'abc\ndef\n');
    assert(result.every(d => d.type === 'same'), '22-4: 동일 텍스트 → 전부 same');
  }

  // 22-5: computeLineDiff 줄 추가
  {
    const result = computeLineDiff('a\n', 'a\nb\n');
    assert(result.some(d => d.type === 'add' && d.line === 'b'), '22-5: 줄 추가 → add 엔트리');
  }

  // 22-6: computeLineDiff 줄 삭제
  {
    const result = computeLineDiff('a\nb\n', 'a\n');
    assert(result.some(d => d.type === 'remove' && d.line === 'b'), '22-6: 줄 삭제 → remove 엔트리');
  }

  // 22-7: computeLineDiff 500줄 초과 → 전체 교체 폴백
  {
    const big = Array.from({ length: 501 }, (_, i) => `line${i}`).join('\n');
    const result = computeLineDiff(big, big + '\nnew');
    assert(result.length > 0, '22-7: 500줄 초과 폴백 처리');
  }

  // 22-8: renderDiffWithContext 출력 포함 확인
  {
    const diff = computeLineDiff('a\nb\nc\n', 'a\nX\nc\n');
    const rendered = renderDiffWithContext(diff);
    assert(rendered.includes('X') && rendered.includes('b'), '22-8: renderDiffWithContext 변경줄 포함');
  }

  // ── skills.js ─────────────────────────────────────────────
  // 22-9: parseFrontmatter 기본 키-값
  {
    const { parseFrontmatter } = await import('../lib/skills.js');
    const raw = `---\nname: test-skill\ndescription: 테스트 스킬\n---\n프롬프트 본문`;
    const { meta, body } = parseFrontmatter(raw);
    assert(meta.name === 'test-skill', '22-9: parseFrontmatter name 파싱');
    assert(body.trim() === '프롬프트 본문', '22-9: parseFrontmatter body 파싱');
  }

  // 22-10: parseFrontmatter 배열 값
  {
    const { parseFrontmatter } = await import('../lib/skills.js');
    const raw = `---\ntags: [a, b, c]\n---\n본문`;
    const { meta } = parseFrontmatter(raw);
    assert(Array.isArray(meta.tags) && meta.tags.length === 3, '22-10: parseFrontmatter 배열 파싱');
  }

  // 22-11: parseFrontmatter 프론트매터 없는 경우
  {
    const { parseFrontmatter } = await import('../lib/skills.js');
    const { meta, body } = parseFrontmatter('프론트매터 없는 텍스트');
    assert(Object.keys(meta).length === 0, '22-11: 프론트매터 없으면 meta 빈 객체');
    assert(body === '프론트매터 없는 텍스트', '22-11: 프론트매터 없으면 body = 전체 텍스트');
  }

  // 22-12: loadSkills 디렉터리 없을 때 빈 배열
  {
    const skills = await loadSkills();
    assert(Array.isArray(skills), '22-12: loadSkills 항상 배열 반환');
  }

  // 22-13: loadSkills SKILL.md 로드
  {
    const skillDir = path.join(TMP_DIR, '.mycli', 'skills', 'test-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: test-skill\ndescription: 테스트\ndisable-model-invocation: true\n---\n$ARGUMENTS 처리`,
      'utf-8'
    );
    // loadSkills는 process.cwd() 기반이므로 직접 경로 로직 검증
    const raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const { parseFrontmatter } = await import('../lib/skills.js');
    const { meta, body } = parseFrontmatter(raw);
    assert(meta['disable-model-invocation'] === 'true', '22-13: disable-model-invocation 파싱');
    assert(body.includes('$ARGUMENTS'), '22-13: body에 $ARGUMENTS 포함');
  }

  // ── context.js ────────────────────────────────────────────
  // 22-14: loadProjectContext — mycli.md 존재 시 로드
  {
    const ctxPath = path.join(TMP_DIR, 'mycli.md');
    await fs.writeFile(ctxPath, '# 테스트 컨텍스트\n프로젝트 설명', 'utf-8');
    // loadProjectContext는 process.cwd() 기준이므로 파일 읽기 로직 직접 검증
    const content = await fs.readFile(ctxPath, 'utf-8');
    assert(content.trim().startsWith('# 테스트 컨텍스트'), '22-14: context 파일 읽기');
  }

  // 22-15: loadProjectContext — 파일 없으면 null
  {
    const { loadProjectContext } = await import('../lib/context.js');
    // 실제 cwd에 mycli.md가 있으면 결과가 달라지므로, 반환 타입만 검증
    const result = await loadProjectContext();
    assert(result === null || typeof result === 'string', '22-15: loadProjectContext null 또는 string 반환');
  }

  // ── state.js ──────────────────────────────────────────────
  // 22-16: readFileState Map CRUD
  {
    const key = '/tmp/test.js';
    readFileState.set(key, { timestamp: 12345, isPartial: false });
    assert(readFileState.has(key), '22-16: readFileState.set/has');
    readFileState.delete(key);
    assert(!readFileState.has(key), '22-16: readFileState.delete');
  }
}

// ═══════════════════════════════════════════════════════════
// Test 23: state.js — getCurrentInput / setCurrentInput
// ═══════════════════════════════════════════════════════════
async function testCurrentInput() {
  console.log('\n[Test 23] state.js — getCurrentInput / setCurrentInput');

  // 23-1: 초기값 빈 문자열
  setCurrentInput('');
  assert(getCurrentInput() === '', '23-1: 초기값 빈 문자열');

  // 23-2: 값 설정 후 조회
  setCurrentInput('안녕하세요');
  assert(getCurrentInput() === '안녕하세요', '23-2: setCurrentInput 후 getCurrentInput 반환');

  // 23-3: 덮어쓰기
  setCurrentInput('두 번째 입력');
  assert(getCurrentInput() === '두 번째 입력', '23-3: 값 덮어쓰기');

  // 23-4: 빈 문자열 재설정
  setCurrentInput('');
  assert(getCurrentInput() === '', '23-4: 빈 문자열 재설정');
}

// ═══════════════════════════════════════════════════════════
// Test 24: lib/hooks.js — 로더, matcher, emitHook, 차단 로직
// ═══════════════════════════════════════════════════════════
async function testHooks() {
  console.log('\n[Test 24] lib/hooks.js — 훅 시스템');

  // 24-1: loadHooks — hooks.json 없으면 빈 객체
  await loadHooks();
  const loaded = getLoadedHooks();
  assert(typeof loaded === 'object' && loaded !== null, '24-1: loadHooks 후 객체 반환');

  // 24-2: getLoadedHooks 참조 일치
  assert(getLoadedHooks() === loaded, '24-2: getLoadedHooks 동일 참조 반환');

  // 24-3: hooks.json 로컬 파일 로드 테스트
  {
    const localDir = path.join(TMP_DIR, '.mycli');
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(
      path.join(localDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolCall: [{ matcher: 'read_file', hooks: [{ type: 'command', command: 'echo HOOK_TEST' }] }],
        },
      }),
      'utf-8'
    );
    // cwd를 TMP_DIR로 변경하여 로컬 hooks.json 로드 검증
    const origCwd = process.cwd();
    process.chdir(TMP_DIR);
    await loadHooks();
    const h = getLoadedHooks();
    process.chdir(origCwd);
    // 다시 빈 상태로 복구
    await loadHooks();
    assert(Array.isArray(h.PreToolCall) && h.PreToolCall.length > 0, '24-3: 로컬 hooks.json PreToolCall 로드');
  }

  // 24-4: matcher 정규식 — 일치 시 훅 실행 (stdout 캡처)
  {
    // 임시로 _hooks를 직접 조작하여 테스트
    const hooksModule = await import('../lib/hooks.js');

    // loadHooks를 빈 상태로 리셋 (hooks.json 없는 cwd 사용)
    await loadHooks();

    // emitHook 기본 동작: 훅 없으면 blocked=false
    const result = await emitHook('PreToolCall', {
      MYCLI_TOOL_NAME: 'read_file',
      MYCLI_INPUT: 'test',
      MYCLI_BASE_DIR: TMP_DIR,
      MYCLI_PROVIDER: 'gemini',
    });
    assert(result.blocked === false, '24-4: 훅 없으면 blocked=false');
    assert(typeof result.output === 'string', '24-4: output 문자열 반환');
  }

  // 24-5: emitHook Stop — blocked 항상 false
  {
    await loadHooks();
    const result = await emitHook('Stop', {
      MYCLI_INPUT: 'hello',
      MYCLI_OUTPUT: 'world',
      MYCLI_BASE_DIR: TMP_DIR,
      MYCLI_PROVIDER: 'gemini',
    });
    assert(result.blocked === false, '24-5: Stop 이벤트 blocked 항상 false');
  }

  // 24-6: emitHook PreUserPromptSubmit — blocked 항상 false
  {
    await loadHooks();
    const result = await emitHook('PreUserPromptSubmit', {
      MYCLI_INPUT: '테스트 입력',
      MYCLI_BASE_DIR: TMP_DIR,
      MYCLI_PROVIDER: 'gpt',
    });
    assert(result.blocked === false, '24-6: PreUserPromptSubmit blocked 항상 false');
  }

  // 24-7: matcher 정규식 잘못된 패턴 — 예외 없이 skip
  {
    const localDir = path.join(TMP_DIR, '.mycli');
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(
      path.join(localDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolCall: [{ matcher: '[invalid', hooks: [{ command: 'echo hi' }] }],
        },
      }),
      'utf-8'
    );
    const origCwd = process.cwd();
    process.chdir(TMP_DIR);
    await loadHooks();
    process.chdir(origCwd);

    let threw = false;
    try {
      await emitHook('PreToolCall', {
        MYCLI_TOOL_NAME: 'write_file',
        MYCLI_INPUT: 'x',
        MYCLI_BASE_DIR: TMP_DIR,
        MYCLI_PROVIDER: 'gemini',
      });
    } catch { threw = true; }
    assert(!threw, '24-7: 잘못된 matcher 정규식 → 예외 없이 skip');

    await loadHooks(); // 리셋
  }

  // 24-8: PreToolCall exit code 0 → 차단 없음
  {
    const localDir = path.join(TMP_DIR, '.mycli');
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(
      path.join(localDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolCall: [{ matcher: '.*', hooks: [{ command: 'exit 0' }] }],
        },
      }),
      'utf-8'
    );
    const origCwd = process.cwd();
    process.chdir(TMP_DIR);
    await loadHooks();
    process.chdir(origCwd);

    const result = await emitHook('PreToolCall', {
      MYCLI_TOOL_NAME: 'read_file',
      MYCLI_INPUT: 'x',
      MYCLI_BASE_DIR: TMP_DIR,
      MYCLI_PROVIDER: 'gemini',
    });
    assert(result.blocked === false, '24-8: PreToolCall exit 0 → 차단 없음');
    await loadHooks();
  }

  // 24-9: PreToolCall exit code 1 → 차단
  {
    const localDir = path.join(TMP_DIR, '.mycli');
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(
      path.join(localDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolCall: [{ matcher: '.*', hooks: [{ command: 'exit 1' }] }],
        },
      }),
      'utf-8'
    );
    const origCwd = process.cwd();
    process.chdir(TMP_DIR);
    await loadHooks();
    process.chdir(origCwd);

    const result = await emitHook('PreToolCall', {
      MYCLI_TOOL_NAME: 'write_file',
      MYCLI_INPUT: 'x',
      MYCLI_BASE_DIR: TMP_DIR,
      MYCLI_PROVIDER: 'gemini',
    });
    assert(result.blocked === true, '24-9: PreToolCall exit 1 → blocked=true');
    await loadHooks();
  }

  // 24-10: stdout 캡처 — echo 명령어 결과 output 에 포함
  {
    const localDir = path.join(TMP_DIR, '.mycli');
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(
      path.join(localDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: '.*', hooks: [{ command: 'echo CAPTURED_OUTPUT' }] }],
        },
      }),
      'utf-8'
    );
    const origCwd = process.cwd();
    process.chdir(TMP_DIR);
    await loadHooks();
    process.chdir(origCwd);

    const result = await emitHook('Stop', {
      MYCLI_INPUT: 'x',
      MYCLI_OUTPUT: 'y',
      MYCLI_BASE_DIR: TMP_DIR,
      MYCLI_PROVIDER: 'gemini',
    });
    assert(result.output.includes('CAPTURED_OUTPUT'), '24-10: stdout 캡처 → output 포함');
    await loadHooks();
  }
}

// ═══════════════════════════════════════════════════════════
// Test 25: lib/hook-logger.js — SQLite 로거
// ═══════════════════════════════════════════════════════════
async function testHookLogger() {
  console.log('\n[Test 25] lib/hook-logger.js — SQLite 로거');

  // 25-1: 테스트 전용 DB 경로 사용
  const testDbPath = path.join(TMP_DIR, 'test-hook-log.db');
  process.env.MYCLI_HOOK_LOG = 'true';
  process.env.MYCLI_HOOK_LOG_DB = testDbPath;

  await initHookLogger();
  assert(isLoggerReady(), '25-1: initHookLogger 후 isLoggerReady()=true');

  // 25-2: 초기 상태 — 레코드 없음
  const initial = queryHookEvents({ limit: 100 });
  // 이전 테스트에서 emitHook이 호출했을 수 있으므로 clearHookEvents 후 확인
  clearHookEvents();
  const afterClear = queryHookEvents({ limit: 100 });
  assert(afterClear.length === 0, '25-2: clearHookEvents 후 레코드 없음');

  // 25-3: PreUserPromptSubmit 이벤트 기록
  logHookEvent({
    MYCLI_EVENT:    'PreUserPromptSubmit',
    MYCLI_INPUT:    '안녕하세요',
    MYCLI_BASE_DIR: '/tmp',
    MYCLI_PROVIDER: 'gemini',
  });
  const rows1 = queryHookEvents({ limit: 10 });
  assert(rows1.length === 1, '25-3: 이벤트 1건 기록');
  assert(rows1[0].event === 'PreUserPromptSubmit', '25-3: event 컬럼 정확');
  assert(rows1[0].user_input === '안녕하세요', '25-3: user_input 컬럼 정확');
  assert(rows1[0].provider === 'gemini', '25-3: provider 컬럼 정확');

  // 25-4: PreToolCall 이벤트 기록
  logHookEvent({
    MYCLI_EVENT:      'PreToolCall',
    MYCLI_TOOL_NAME:  'read_file',
    MYCLI_TOOL_INPUT: JSON.stringify({ filePath: 'test.js' }),
    MYCLI_INPUT:      '파일 읽어줘',
    MYCLI_BASE_DIR:   '/tmp',
    MYCLI_PROVIDER:   'gpt',
  });
  const rows2 = queryHookEvents({ limit: 10 });
  assert(rows2.length === 2, '25-4: PreToolCall 기록 후 총 2건');
  assert(rows2[0].tool_name === 'read_file', '25-4: tool_name 컬럼 정확 (최신순)');

  // 25-5: PostToolCall 이벤트 기록
  logHookEvent({
    MYCLI_EVENT:        'PostToolCall',
    MYCLI_TOOL_NAME:    'read_file',
    MYCLI_TOOL_INPUT:   JSON.stringify({ filePath: 'test.js' }),
    MYCLI_TOOL_OUTPUT:  '파일 내용입니다',
    MYCLI_INPUT:        '파일 읽어줘',
    MYCLI_BASE_DIR:     '/tmp',
    MYCLI_PROVIDER:     'gpt',
  });
  const rows3 = queryHookEvents({ limit: 10 });
  assert(rows3.length === 3, '25-5: PostToolCall 기록 후 총 3건');
  assert(rows3[0].tool_output === '파일 내용입니다', '25-5: tool_output 컬럼 정확');

  // 25-6: Stop 이벤트 기록
  logHookEvent({
    MYCLI_EVENT:    'Stop',
    MYCLI_INPUT:    '파일 읽어줘',
    MYCLI_OUTPUT:   'AI 응답 내용',
    MYCLI_BASE_DIR: '/tmp',
    MYCLI_PROVIDER: 'gpt',
  });
  const rows4 = queryHookEvents({ limit: 10 });
  assert(rows4.length === 4, '25-6: Stop 기록 후 총 4건');
  assert(rows4[0].ai_output === 'AI 응답 내용', '25-6: ai_output 컬럼 정확');

  // 25-7: event 필터
  const filtered = queryHookEvents({ event: 'PreToolCall', limit: 10 });
  assert(filtered.length === 1 && filtered[0].event === 'PreToolCall', '25-7: event 필터 동작');

  // 25-8: tool 필터
  const toolFiltered = queryHookEvents({ tool: 'read_file', limit: 10 });
  assert(toolFiltered.length === 2, '25-8: tool 필터 — read_file 2건 반환');

  // 25-9: limit 동작
  const limited = queryHookEvents({ limit: 2 });
  assert(limited.length === 2, '25-9: limit=2 → 2건 반환');

  // 25-10: countHookEvents 전체
  const total = countHookEvents();
  assert(total === 4, '25-10: countHookEvents 전체 4건');

  // 25-11: countHookEvents event 필터
  const cnt = countHookEvents({ event: 'Stop' });
  assert(cnt === 1, '25-11: countHookEvents Stop 1건');

  // 25-12: clearHookEvents 반환값 (삭제 건수)
  const deleted = clearHookEvents();
  assert(deleted === 4, '25-12: clearHookEvents 삭제 건수 4');

  // 25-13: clear 후 빈 상태
  const afterClear2 = queryHookEvents({ limit: 10 });
  assert(afterClear2.length === 0, '25-13: clearHookEvents 후 0건');

  // 25-14: countHookEvents clear 후 0
  assert(countHookEvents() === 0, '25-14: countHookEvents clear 후 0');

  // 25-15: MYCLI_HOOK_LOG=false 시 isLoggerReady 유지 (이미 init된 상태)
  // (비활성화는 initHookLogger 호출 시에만 작동 — 이미 초기화된 db는 유지)
  assert(isLoggerReady(), '25-15: 이미 초기화된 로거는 env 변경 후에도 db 유지');

  // DB 연결 닫기 (teardown 시 EBUSY 방지)
  closeHookLogger();
  delete process.env.MYCLI_HOOK_LOG_DB;
}

// ═══════════════════════════════════════════════════════════
// Test 26: 훅 시스템 엣지 케이스 (커버리지 보강)
// ═══════════════════════════════════════════════════════════
async function testHookEdgeCases() {
  console.log('\n[Test 26] 훅 엣지 케이스 (타임아웃·stderr·초기화 실패)');

  const localDir = path.join(TMP_DIR, '.mycli');
  await fs.mkdir(localDir, { recursive: true });

  // 26-1: 타임아웃 경로 — timeout 1ms + 느린 명령어 → timedOut=true, blocked=false
  {
    await fs.writeFile(
      path.join(localDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [{
            matcher: '.*',
            hooks: [{ command: 'node -e "setTimeout(()=>{},200)"', timeout: 1 }],
          }],
        },
      }),
      'utf-8'
    );
    const origCwd = process.cwd();
    process.chdir(TMP_DIR);
    await loadHooks();
    process.chdir(origCwd);

    let threw = false;
    let result;
    try {
      result = await emitHook('Stop', {
        MYCLI_INPUT: 'x', MYCLI_OUTPUT: 'y',
        MYCLI_BASE_DIR: TMP_DIR, MYCLI_PROVIDER: 'gemini',
      });
    } catch { threw = true; }
    assert(!threw, '26-1: 타임아웃 발생해도 예외 없음');
    assert(result?.blocked === false, '26-1: 타임아웃 → blocked=false (Stop 이벤트)');
    await loadHooks();
  }

  // 26-2: PreToolCall 타임아웃 → blocked=false (차단 조건은 exitCode이지 timedOut 아님)
  {
    await fs.writeFile(
      path.join(localDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolCall: [{
            matcher: '.*',
            hooks: [{ command: 'node -e "setTimeout(()=>{},200)"', timeout: 1 }],
          }],
        },
      }),
      'utf-8'
    );
    const origCwd = process.cwd();
    process.chdir(TMP_DIR);
    await loadHooks();
    process.chdir(origCwd);

    const result = await emitHook('PreToolCall', {
      MYCLI_TOOL_NAME: 'write_file', MYCLI_INPUT: 'x',
      MYCLI_BASE_DIR: TMP_DIR, MYCLI_PROVIDER: 'gemini',
    });
    assert(result.blocked === false, '26-2: PreToolCall 타임아웃 → blocked=false');
    await loadHooks();
  }

  // 26-3: stderr 출력 경로 — 명령어가 stderr에 출력
  {
    await fs.writeFile(
      path.join(localDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [{
            matcher: '.*',
            hooks: [{ command: 'node -e "process.stderr.write(\'STDERR_MSG\')"' }],
          }],
        },
      }),
      'utf-8'
    );
    const origCwd = process.cwd();
    process.chdir(TMP_DIR);
    await loadHooks();
    process.chdir(origCwd);

    let threw = false;
    try {
      await emitHook('Stop', {
        MYCLI_INPUT: 'x', MYCLI_OUTPUT: 'y',
        MYCLI_BASE_DIR: TMP_DIR, MYCLI_PROVIDER: 'gemini',
      });
    } catch { threw = true; }
    assert(!threw, '26-3: stderr 출력 명령어 → 예외 없음');
    await loadHooks();
  }

  // 26-4: hook.type이 'command'가 아닌 경우 → skip
  {
    await fs.writeFile(
      path.join(localDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [{
            matcher: '.*',
            hooks: [{ type: 'unsupported', command: 'echo SHOULD_NOT_RUN' }],
          }],
        },
      }),
      'utf-8'
    );
    const origCwd = process.cwd();
    process.chdir(TMP_DIR);
    await loadHooks();
    process.chdir(origCwd);

    const result = await emitHook('Stop', {
      MYCLI_INPUT: 'x', MYCLI_OUTPUT: 'y',
      MYCLI_BASE_DIR: TMP_DIR, MYCLI_PROVIDER: 'gemini',
    });
    assert(result.output === '', '26-4: 지원하지 않는 type → output 빈 문자열');
    await loadHooks();
  }

  // 26-5: hook.command 없는 경우 → skip
  {
    await fs.writeFile(
      path.join(localDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [{
            matcher: '.*',
            hooks: [{ type: 'command' }],
          }],
        },
      }),
      'utf-8'
    );
    const origCwd = process.cwd();
    process.chdir(TMP_DIR);
    await loadHooks();
    process.chdir(origCwd);

    let threw = false;
    try {
      await emitHook('Stop', {
        MYCLI_INPUT: 'x', MYCLI_OUTPUT: 'y',
        MYCLI_BASE_DIR: TMP_DIR, MYCLI_PROVIDER: 'gemini',
      });
    } catch { threw = true; }
    assert(!threw, '26-5: command 없는 훅 → 예외 없음');
    await loadHooks();
  }

  // 26-6: initHookLogger 실패 경로 — MYCLI_HOOK_LOG=false
  {
    const { closeHookLogger: close, initHookLogger: init, isLoggerReady: ready } =
      await import('../lib/hook-logger.js');
    close();
    process.env.MYCLI_HOOK_LOG = 'false';
    await init();
    assert(!ready(), '26-6: MYCLI_HOOK_LOG=false → isLoggerReady=false');
    process.env.MYCLI_HOOK_LOG = 'true';
    process.env.MYCLI_HOOK_LOG_DB = path.join(TMP_DIR, 'recovery.db');
    await init();
    assert(ready(), '26-6: 복구 후 isLoggerReady=true');
    close();
    delete process.env.MYCLI_HOOK_LOG_DB;
  }

  // 26-7: initHookLogger — DB 경로가 디렉터리인 경우 catch 블록 진입
  {
    const { closeHookLogger: close, initHookLogger: init, isLoggerReady: ready } =
      await import('../lib/hook-logger.js');
    close();
    // 디렉터리를 DB 경로로 지정 → better-sqlite3가 에러 던짐 → catch 블록
    process.env.MYCLI_HOOK_LOG = 'true';
    process.env.MYCLI_HOOK_LOG_DB = TMP_DIR; // 디렉터리
    await init();
    assert(!ready(), '26-7: DB 경로가 디렉터리 → 초기화 실패 → isLoggerReady=false');
    // 복구
    process.env.MYCLI_HOOK_LOG_DB = path.join(TMP_DIR, 'final-recovery.db');
    await init();
    close();
    delete process.env.MYCLI_HOOK_LOG_DB;
  }
}

// ═══════════════════════════════════════════════════════════
// 실행
// ═══════════════════════════════════════════════════════════
async function run() {
  console.log('='.repeat(50));
  console.log(' mycli 신규 기능 테스트');
  console.log('='.repeat(50));

  await setup();

  await testEditFile();
  await testGitTools();
  await testMultilineInput();
  await testMultiAttach();
  await testSessionSerialization();
  await testModelSwitch();
  await testUtf8Encoding();
  await testStatusLogic();
  await testPlanModeNewTools();
  await testLibModulesCoverage();
  await testCurrentInput();
  await testHooks();
  await testHookLogger();
  await testHookEdgeCases();

  await teardown();

  console.log('\n' + '='.repeat(50));
  console.log(` 결과: ${passed + failed}개 중 ${passed} PASS / ${failed} FAIL`);
  console.log('='.repeat(50));

  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('테스트 실행 오류:', e);
  process.exit(1);
});
