#!/usr/bin/env node
/**
 * mycli 회귀 테스트 — 실제로 재현된 버그만 모아둔 파일
 *
 * 기존 테스트가 이 버그들을 못 잡은 이유는 로직을 테스트 안에서 다시 구현했기 때문이다.
 * 여기서는 반드시 lib/ 의 "실제 함수"를 그대로 호출한다.
 *
 * 실행: node test/test-regression.js
 */

import fs from 'fs/promises';
import fssync from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

process.env.MYCLI_TEST     = '1';
process.env.MYCLI_HOOK_LOG = 'false';

import { setBaseDir, getBaseDir, planModeState, readFileState } from '../lib/state.js';
import { getSafePath, toBaseRelative } from '../lib/utils.js';
import { setMockResponses, resetMock } from '../lib/ui.js';
import { baseTools } from '../lib/tools.js';
import { hasAttachToken } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR   = path.join(__dirname, '__tmp_regression__');
const SIBLING   = TMP_DIR + '-sibling';   // TMP_DIR 과 접두사가 겹치는 형제 디렉터리

const tool = (name) => baseTools.find(t => t.name === name);

// ── 테스트 프레임워크 ───────────────────────────────────────
let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅ PASS  ${label}`); passed++; }
  else           { console.log(`  ❌ FAIL  ${label}`); failed++; }
}

async function setup() {
  await fs.mkdir(TMP_DIR, { recursive: true });
  await fs.mkdir(SIBLING, { recursive: true });
  setBaseDir(TMP_DIR);
  planModeState.active = false;
  readFileState.clear();
  resetMock();
}

async function teardown() {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
  await fs.rm(SIBLING, { recursive: true, force: true });
  resetMock();
}

// ═══════════════════════════════════════════════════════════
// R-1 getSafePath: 접두사가 겹치는 형제 디렉터리로 탈출
//     (기존: startsWith(baseDir) 접두사 비교 → 통과해 버림)
// ═══════════════════════════════════════════════════════════
async function testPathEscape() {
  console.log('\n[R-1] getSafePath 경로 탈출');

  await fs.writeFile(path.join(SIBLING, 'secret.txt'), 'TOP SECRET', 'utf-8');
  const escapeRel = path.join('..', path.basename(SIBLING), 'secret.txt');

  // R-1-1: 형제 디렉터리 상대경로 탈출 차단
  {
    let threw = false;
    try { getSafePath(escapeRel); } catch { threw = true; }
    assert(threw, 'R-1-1: 접두사가 겹치는 형제 디렉터리 탈출 차단');
  }

  // R-1-2: 절대경로로도 탈출 차단
  {
    let threw = false;
    try { getSafePath(path.join(SIBLING, 'secret.txt')); } catch { threw = true; }
    assert(threw, 'R-1-2: 베이스 밖 절대경로 차단');
  }

  // R-1-3: read_file 도구를 통한 탈출 차단 (내용이 새어 나오면 안 됨)
  {
    const out = await tool('read_file').func({ filePath: escapeRel });
    assert(!out.includes('TOP SECRET'), 'R-1-3: read_file 로 형제 디렉터리 내용 유출 안 됨');
  }

  // R-1-4: 정상 경로는 계속 허용 (과잉 차단 회귀 방지)
  {
    assert(getSafePath('a/b.txt') === path.join(TMP_DIR, 'a', 'b.txt'), 'R-1-4: 베이스 내부 상대경로 정상 허용');
    assert(getSafePath(TMP_DIR) === TMP_DIR, 'R-1-4: BASE_DIR 자기 자신 허용');
  }

  // R-1-5: 베이스 내부 절대경로 정상 허용
  {
    const abs = path.join(TMP_DIR, 'lib', 'x.js');
    assert(getSafePath(abs) === abs, 'R-1-5: 베이스 내부 절대경로 정상 허용');
  }
}

// ═══════════════════════════════════════════════════════════
// R-2 절대경로 → BASE_DIR 상대경로 정규화 (@ 첨부에서 사용)
//     (기존: @ 파일 선택기가 상대경로 목록에 절대경로를 대조 → 0건)
// ═══════════════════════════════════════════════════════════
async function testToBaseRelative() {
  console.log('\n[R-2] 절대경로 정규화 (toBaseRelative)');

  assert(toBaseRelative(path.join(TMP_DIR, 'lib', 'tools.js')) === 'lib/tools.js',
    'R-2-1: 절대경로 → 베이스 상대경로');
  assert(toBaseRelative('lib/tools.js') === 'lib/tools.js',
    'R-2-2: 상대경로는 그대로 유지');
  assert(toBaseRelative(path.join(TMP_DIR, 'a', '..', 'lib', 'tools.js')) === 'lib/tools.js',
    'R-2-3: .. 가 섞인 경로 정규화');
  assert(toBaseRelative(path.join(SIBLING, 'secret.txt')) === null,
    'R-2-4: 베이스 밖 경로는 null');
  assert(toBaseRelative(TMP_DIR) === '.',
    'R-2-5: BASE_DIR 자기 자신은 "."');
}

// ═══════════════════════════════════════════════════════════
// R-3 '@' 첨부 토큰 판별
//     (기존: input.includes('@') → 이메일·pkg@1.0 이 첨부 모드로 오인)
// ═══════════════════════════════════════════════════════════
async function testAttachToken() {
  console.log('\n[R-3] @ 첨부 토큰 판별');

  assert(hasAttachToken('@lib/tools.js 설명해줘')            === true,  'R-3-1: @로 시작하는 토큰 → 첨부');
  assert(hasAttachToken('앞에 텍스트 @lib/tools.js')          === true,  'R-3-2: 중간 토큰이 @로 시작 → 첨부');
  assert(hasAttachToken('@')                                  === true,  'R-3-3: @ 단독 → 첨부');
  assert(hasAttachToken('kyj@example.com 으로 메일 써줘')     === false, 'R-3-4: 이메일 주소 → 첨부 아님');
  assert(hasAttachToken('express@4 버전 확인해줘')            === false, 'R-3-5: pkg@버전 → 첨부 아님');
  assert(hasAttachToken('그냥 질문입니다')                    === false, 'R-3-6: @ 없음 → 첨부 아님');
}

// ═══════════════════════════════════════════════════════════
// R-4 install_package: 패키지명을 통한 셸 인젝션
//     (기존: spawn('npm', [...packages], {shell:true}) → 인자가 sh -c 로 합쳐짐)
// ═══════════════════════════════════════════════════════════
async function testInstallPackageInjection() {
  console.log('\n[R-4] install_package 셸 인젝션');

  const marker = path.join(TMP_DIR, 'INJECTED.txt');
  const payload = `is-odd; echo pwned > ${marker}`;

  setMockResponses([true]);   // 확인 프롬프트가 있어도 승인했다고 가정
  const out = await tool('install_package').func({ packages: [payload] });
  resetMock();

  assert(!fssync.existsSync(marker), 'R-4-1: 주입된 셸 명령이 실행되지 않음');
  assert(/거부|허용되지|올바르지|유효하지/.test(out), `R-4-2: 잘못된 패키지명을 거부 (응답: ${out.slice(0, 60)})`);

  // R-4-3: 다른 메타문자도 거부
  for (const bad of ['pkg && whoami', 'pkg|tee /tmp/x', 'pkg`id`', '$(id)', '../../etc/passwd']) {
    setMockResponses([true]);
    const o = await tool('install_package').func({ packages: [bad] });
    resetMock();
    assert(/거부|허용되지|올바르지|유효하지/.test(o), `R-4-3: 거부 — ${JSON.stringify(bad)}`);
  }

  // R-4-4: 정상 패키지명은 통과해야 함 (과잉 차단 회귀 방지)
  for (const good of ['is-odd', '@scope/pkg', 'lodash@4.17.21', 'pkg.js']) {
    setMockResponses([false]);   // 확인 단계에서 취소 → 실제 설치는 안 함
    const o = await tool('install_package').func({ packages: [good] });
    resetMock();
    assert(/취소/.test(o), `R-4-4: 정상 패키지명 통과 후 확인 단계 도달 — ${good}`);
  }
}

// ═══════════════════════════════════════════════════════════
// R-5 execute_shell_command: 차단 목록 우회 + 크로스플랫폼
//     (기존: split(' ')[0] 만 검사, powershell.exe 하드코딩)
// ═══════════════════════════════════════════════════════════
async function testShellCommand() {
  console.log('\n[R-5] execute_shell_command');

  const bypasses = [
    'echo hi; rm -rf /tmp/x',
    'echo hi && rm -rf /tmp/x',
    'echo hi || sudo id',
    '/bin/rm -rf /tmp/x',
    'RM -rf /tmp/x',
    'echo hi | sudo tee /tmp/x',
  ];
  for (const cmd of bypasses) {
    setMockResponses([true]);
    const out = await tool('execute_shell_command').func({ command: cmd });
    resetMock();
    assert(/보안상의 이유로/.test(out), `R-5-1: 차단 — ${JSON.stringify(cmd)}`);
  }

  // R-5-2: 직접 호출도 여전히 차단
  {
    setMockResponses([true]);
    const out = await tool('execute_shell_command').func({ command: 'rm -rf /tmp/x' });
    resetMock();
    assert(/보안상의 이유로/.test(out), 'R-5-2: 단순 rm 차단 (기존 동작 유지)');
  }

  // R-5-3: 안전한 명령이 현재 OS 에서 실제로 실행됨 (powershell 하드코딩 회귀 방지)
  {
    setMockResponses([true]);
    const out = await tool('execute_shell_command').func({ command: 'echo mycli_shell_ok' });
    resetMock();
    assert(out.includes('mycli_shell_ok'), `R-5-3: ${process.platform} 에서 셸 명령 실행 성공`);
  }

  // R-5-4: 사용자가 거부하면 실행되지 않음
  {
    setMockResponses([false]);
    const out = await tool('execute_shell_command').func({ command: 'echo should_not_run' });
    resetMock();
    assert(/취소/.test(out) && !out.includes('should_not_run\n'), 'R-5-4: 확인 거부 시 미실행');
  }
}

// ═══════════════════════════════════════════════════════════
// R-6 execute_code: 자식 프로세스로 API 키가 새어 나감
//     (기존: env: { ...process.env } 전체 상속)
// ═══════════════════════════════════════════════════════════
async function testExecuteCodeEnv() {
  console.log('\n[R-6] execute_code 환경변수 유출');

  const SENTINEL = 'SENTINEL_KEY_VALUE_9f3a';
  const saved = {
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    VLLM_API_KEY:   process.env.VLLM_API_KEY,
  };
  process.env.GOOGLE_API_KEY = SENTINEL;
  process.env.OPENAI_API_KEY = SENTINEL;
  process.env.VLLM_API_KEY   = SENTINEL;

  setMockResponses([true]);
  const out = await tool('execute_code').func({
    description: '환경변수 유출 확인',
    code: `console.log('G=' + (process.env.GOOGLE_API_KEY ?? 'none'));
console.log('O=' + (process.env.OPENAI_API_KEY ?? 'none'));
console.log('V=' + (process.env.VLLM_API_KEY ?? 'none'));
console.log('PATH_OK=' + Boolean(process.env.PATH));
console.log('WORKDIR_OK=' + Boolean(process.env.MYCLI_WORKDIR));`,
    timeout: 15000,
  });
  resetMock();

  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  assert(!out.includes(SENTINEL), 'R-6-1: API 키가 샌드박스 코드에 노출되지 않음');
  assert(out.includes('PATH_OK=true'), 'R-6-2: PATH 등 필수 환경변수는 유지');
  assert(out.includes('WORKDIR_OK=true'), 'R-6-3: MYCLI_WORKDIR 는 계속 전달');
}

// ═══════════════════════════════════════════════════════════
// R-7 write_file: 부분 읽기 후 전체 덮어쓰기 → 데이터 손실
//     (기존: isPartial 을 기록만 하고 검사하지 않음)
// ═══════════════════════════════════════════════════════════
async function testPartialWriteGuard() {
  console.log('\n[R-7] 부분 읽기 후 전체 덮어쓰기');

  const rel  = 'partial.txt';
  const abs  = path.join(TMP_DIR, rel);
  const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  await fs.writeFile(abs, body, 'utf-8');

  // R-7-1: 일부만 읽은 뒤 전체 덮어쓰기 → 거부, 파일 내용 보존
  {
    readFileState.clear();
    await tool('read_file').func({ filePath: rel, offset: 1, limit: 5 });
    setMockResponses([true]);
    const out = await tool('write_file').func({ filePath: rel, content: 'REPLACED' });
    resetMock();
    const after = await fs.readFile(abs, 'utf-8');
    assert(/일부 범위만|부분/.test(out), `R-7-1: 부분 읽기 후 전체 덮어쓰기 거부 (응답: ${out.slice(0, 50)})`);
    assert(after === body, 'R-7-1: 원본 파일 내용 보존됨');
  }

  // R-7-2: 전체를 읽은 뒤에는 정상 허용 (과잉 차단 회귀 방지)
  {
    readFileState.clear();
    await tool('read_file').func({ filePath: rel });
    setMockResponses([true]);
    const out = await tool('write_file').func({ filePath: rel, content: 'REPLACED' });
    resetMock();
    assert(/성공/.test(out), `R-7-2: 전체 읽기 후에는 덮어쓰기 허용 (응답: ${out.slice(0, 50)})`);
    assert((await fs.readFile(abs, 'utf-8')) === 'REPLACED', 'R-7-2: 내용이 실제로 반영됨');
  }

  // R-7-3: edit_file 은 부분 읽기 후에도 허용 (범위를 넘어서지 않으므로)
  {
    await fs.writeFile(abs, body, 'utf-8');
    readFileState.clear();
    await tool('read_file').func({ filePath: rel, offset: 1, limit: 5 });
    setMockResponses([true]);
    const out = await tool('edit_file').func({ filePath: rel, old_string: 'line 3\n', new_string: 'LINE_THREE\n' });
    resetMock();
    assert(/성공/.test(out), `R-7-3: 부분 읽기 후 edit_file 은 허용 (응답: ${out.slice(0, 50)})`);
  }

  // R-7-4: 부분 읽기 → edit_file → write_file 로 우회되지 않아야 함
  //        (edit_file 이 isPartial 을 false 로 덮어쓰면 전체 덮어쓰기가 다시 뚫린다)
  {
    await fs.writeFile(abs, body, 'utf-8');
    readFileState.clear();
    await tool('read_file').func({ filePath: rel, offset: 1, limit: 5 });
    setMockResponses([true]);
    await tool('edit_file').func({ filePath: rel, old_string: 'line 3\n', new_string: 'LINE_THREE\n' });
    resetMock();

    setMockResponses([true]);
    const out = await tool('write_file').func({ filePath: rel, content: 'REPLACED' });
    resetMock();
    const after = await fs.readFile(abs, 'utf-8');
    assert(/일부 범위만|부분/.test(out), `R-7-4: edit_file 경유 우회 차단 (응답: ${out.slice(0, 50)})`);
    assert(after !== 'REPLACED', 'R-7-4: 파일이 잘리지 않음');
  }
}

// ═══════════════════════════════════════════════════════════
async function main() {
  console.log('\x1b[1m' + '='.repeat(55) + '\x1b[0m');
  console.log('  mycli 회귀 테스트 (실제 재현된 버그)');
  console.log('\x1b[1m' + '='.repeat(55) + '\x1b[0m');

  await setup();
  try {
    await testPathEscape();
    await testToBaseRelative();
    await testAttachToken();
    await testInstallPackageInjection();
    await testShellCommand();
    await testExecuteCodeEnv();
    await testPartialWriteGuard();
  } finally {
    await teardown();
  }

  console.log('\n\x1b[1m' + '='.repeat(55) + '\x1b[0m');
  console.log(`  결과: ${passed + failed}개 중 \x1b[32m${passed} PASS\x1b[0m / \x1b[31m${failed} FAIL\x1b[0m`);
  console.log('\x1b[1m' + '='.repeat(55) + '\x1b[0m\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('테스트 실행 중 예외:', err);
  process.exit(1);
});
