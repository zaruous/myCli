#!/usr/bin/env node
/**
 * mycli 통합 테스트 (LLM Mock 주입 방식)
 *
 * 전략:
 *  - MYCLI_TEST=1 환경변수로 index.js 의 startCLI() 자동 실행을 차단
 *  - index.js 에서 export 된 baseTools / memory 를 동적 임포트로 가져옴
 *  - MockExecutor 로 실제 LLM API 호출 없이 streamEvents 흐름을 재현
 *  - lib/ui.js 의 setMockResponses/resetMock 으로 대화형 확인 단계를 자동화
 *
 * 실행: node test/test-integration.js
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// lib 모듈 직접 임포트 (index.js 보다 먼저)
import { planModeState, readFileState, setBaseDir, getBaseDir } from '../lib/state.js';
import { getTimestamp } from '../lib/utils.js';
import { setMockResponses, resetMock } from '../lib/ui.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR   = path.join(__dirname, '__tmp_integration__');

// ── MYCLI_TEST=1 설정 후 index.js 동적 임포트 ──────────────
process.env.MYCLI_TEST = '1';
const { baseTools, memory } = await import('../index.js');

// ═══════════════════════════════════════════════════════════
// 테스트 프레임워크
// ═══════════════════════════════════════════════════════════
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

// ── 공통 셋업/티어다운 ─────────────────────────────────────
async function setup() {
  await fs.mkdir(TMP_DIR, { recursive: true });
  setBaseDir(TMP_DIR);
  // 각 테스트 전에 plan mode 초기화
  planModeState.active = false;
  planModeState.enteredAt = null;
  readFileState.clear();
  await memory.clear();
}

async function teardown() {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
}

// ── UI mock 유틸 ───────────────────────────────────────────
/**
 * lib/ui.js 의 confirmPrompt / selectKeyPrompt / inputPrompt 를 자동화합니다.
 * responses: 큐 배열 — 각 프롬프트 호출마다 앞에서부터 꺼냅니다.
 *   - confirmPrompt → boolean (true/false)
 *   - selectKeyPrompt → string (choice value, e.g. 'approve', 'reject')
 *   - inputPrompt → string
 */
function withMockUI(responses, fn) {
  return async () => {
    setMockResponses(responses);
    try {
      return await fn();
    } finally {
      resetMock();
    }
  };
}

// ── MockExecutor ───────────────────────────────────────────
class MockExecutor {
  constructor() {
    this._queue = [];
    this.callCount = 0;
    this.lastInput = null;
    this.lastHistory = null;
  }

  /** 응답 예약. { text, tool, toolResult } */
  enqueue(response) {
    this._queue.push(response);
    return this;
  }

  async *streamEvents(input, _opts) {
    this.lastInput = input.input;
    this.lastHistory = input.chat_history;
    this.callCount++;

    const response = this._queue.shift() ?? { text: '기본 mock 응답' };

    if (response.tool) {
      yield { event: 'on_tool_start', name: response.tool, data: {} };
      yield {
        event: 'on_tool_end',
        name: response.tool,
        data: { output: response.toolResult ?? '완료' },
      };
    }

    const text = response.text ?? '';
    for (const char of text) {
      yield {
        event: 'on_llm_stream',
        data: { chunk: { message: { content: char } } },
      };
    }

    yield {
      event: 'on_chain_end',
      name: 'AgentExecutor',
      data: { output: { output: text } },
    };
  }
}

// ── handleChat 미니 레플리카 (순수 로직, 콘솔 출력 없음) ──
async function runMockChat(userInput, mockExecutor, mem) {
  const history = await mem.loadMemoryVariables({});
  let finalOutput = '';
  const streamedChunks = [];
  const toolCalls = [];

  for await (const event of mockExecutor.streamEvents(
    { input: userInput, chat_history: history.chat_history ?? [] },
    { version: 'v2' }
  )) {
    if (event.event === 'on_tool_start') {
      toolCalls.push(event.name);
    } else if (event.event === 'on_llm_stream') {
      const chunk = event.data?.chunk?.message?.content ?? '';
      if (typeof chunk === 'string' && chunk) {
        streamedChunks.push(chunk);
        finalOutput += chunk;
      }
    } else if (event.event === 'on_chain_end' && event.name === 'AgentExecutor') {
      if (!finalOutput) finalOutput = event.data?.output?.output ?? '';
    }
  }

  await mem.saveContext({ input: userInput }, { output: String(finalOutput) });
  return { finalOutput, streamedChunks, toolCalls };
}

// ── 도구 헬퍼 ──────────────────────────────────────────────
function getTool(name) {
  return baseTools.find(t => t.name === name);
}

// ═══════════════════════════════════════════════════════════
// IT-1: MockExecutor 기본 동작
// ═══════════════════════════════════════════════════════════
async function testMockExecutorBasic() {
  console.log('\n[IT-1] MockExecutor 기본 동작');

  // 1-1: streamEvents 비동기 이터러블 반환
  {
    const exec = new MockExecutor().enqueue({ text: '안녕' });
    const iter = exec.streamEvents({ input: 'hi', chat_history: [] }, {});
    assert(typeof iter[Symbol.asyncIterator] === 'function', 'IT-1-1: streamEvents → asyncIterable');
  }

  // 1-2: on_llm_stream 이벤트 생성
  {
    const exec = new MockExecutor().enqueue({ text: 'AB' });
    const events = [];
    for await (const e of exec.streamEvents({ input: 'x', chat_history: [] }, {})) {
      events.push(e.event);
    }
    const streamCount = events.filter(e => e === 'on_llm_stream').length;
    assert(streamCount === 2, 'IT-1-2: 텍스트 "AB" → on_llm_stream 2회');
  }

  // 1-3: on_chain_end 이벤트 생성
  {
    const exec = new MockExecutor().enqueue({ text: 'hi' });
    const events = [];
    for await (const e of exec.streamEvents({ input: 'x', chat_history: [] }, {})) {
      events.push(e.event);
    }
    assert(events.includes('on_chain_end'), 'IT-1-3: on_chain_end 이벤트 포함');
  }

  // 1-4: 도구 호출 이벤트 시뮬레이션
  {
    const exec = new MockExecutor().enqueue({ tool: 'read_file', toolResult: '파일 내용', text: '확인됨' });
    const events = [];
    for await (const e of exec.streamEvents({ input: 'x', chat_history: [] }, {})) {
      events.push(e.event);
    }
    assert(events.includes('on_tool_start'), 'IT-1-4: 도구 호출 → on_tool_start 포함');
    assert(events.includes('on_tool_end'),   'IT-1-4: 도구 호출 → on_tool_end 포함');
  }

  // 1-5: callCount 증가
  {
    const exec = new MockExecutor().enqueue({ text: 'a' }).enqueue({ text: 'b' });
    await (async () => { for await (const _ of exec.streamEvents({ input: 'x', chat_history: [] }, {})) {} })();
    await (async () => { for await (const _ of exec.streamEvents({ input: 'y', chat_history: [] }, {})) {} })();
    assert(exec.callCount === 2, 'IT-1-5: callCount = 2');
  }

  // 1-6: 큐 소진 시 기본 응답
  {
    const exec = new MockExecutor(); // 빈 큐
    let text = '';
    for await (const e of exec.streamEvents({ input: 'x', chat_history: [] }, {})) {
      if (e.event === 'on_llm_stream') text += e.data?.chunk?.message?.content ?? '';
    }
    assert(text.length > 0, 'IT-1-6: 큐 소진 → 기본 mock 응답 반환');
  }
}

// ═══════════════════════════════════════════════════════════
// IT-2: handleChat + Memory 통합
// ═══════════════════════════════════════════════════════════
async function testHandleChatMemory() {
  console.log('\n[IT-2] handleChat + Memory 통합');

  await memory.clear();
  const exec = new MockExecutor();

  // 2-1: 기본 응답 수신
  {
    exec.enqueue({ text: '반갑습니다' });
    const { finalOutput } = await runMockChat('안녕', exec, memory);
    assert(finalOutput === '반갑습니다', 'IT-2-1: finalOutput = "반갑습니다"');
  }

  // 2-2: 메모리에 저장됨
  {
    const history = await memory.loadMemoryVariables({});
    const msgs = history.chat_history ?? [];
    assert(msgs.length >= 2, 'IT-2-2: 메모리에 human+AI 메시지 저장 (≥2)');
  }

  // 2-3: 두 번째 호출 시 이전 대화 포함
  {
    exec.enqueue({ text: '네, 기억합니다' });
    const { finalOutput } = await runMockChat('기억해?', exec, memory);
    assert(exec.lastHistory !== null && exec.lastHistory.length > 0,
      'IT-2-3: 두 번째 호출 시 chat_history 전달됨');
    assert(finalOutput === '네, 기억합니다', 'IT-2-3: 두 번째 응답 정확');
  }

  // 2-4: memory.clear() 후 history 비어있음
  {
    await memory.clear();
    const history = await memory.loadMemoryVariables({});
    const msgs = history.chat_history ?? [];
    assert(msgs.length === 0, 'IT-2-4: clear() 후 메시지 0개');
  }

  // 2-5: 스트리밍 청크 개수 = 텍스트 길이
  {
    exec.enqueue({ text: '12345' });
    const { streamedChunks } = await runMockChat('테스트', exec, memory);
    assert(streamedChunks.length === 5, 'IT-2-5: "12345" → 청크 5개 스트리밍');
  }

  // 2-6: 도구 호출 추적
  {
    exec.enqueue({ tool: 'git_status', toolResult: 'clean', text: '깨끗합니다' });
    const { toolCalls } = await runMockChat('git 상태 확인', exec, memory);
    assert(toolCalls.includes('git_status'), 'IT-2-6: toolCalls 에 git_status 포함');
  }
}

// ═══════════════════════════════════════════════════════════
// IT-3: read_file 도구 직접 호출
// ═══════════════════════════════════════════════════════════
async function testReadFileTool() {
  console.log('\n[IT-3] read_file 도구 직접 호출');

  const tool = getTool('read_file');
  const testFile = path.join(TMP_DIR, 'it3-sample.txt');
  const content = 'line1\nline2\nline3\nline4\nline5\n';
  await fs.writeFile(testFile, content, 'utf-8');

  // 3-1: 전체 파일 읽기
  {
    const result = await tool.func({ filePath: testFile });
    assert(result.includes('line1') && result.includes('line5'), 'IT-3-1: 전체 파일 내용 반환');
  }

  // 3-2: readFileState 에 경로 등록됨
  {
    assert(readFileState.has(testFile), 'IT-3-2: read 후 readFileState 등록됨');
  }

  // 3-3: offset 적용 (3번째 줄부터)
  {
    const result = await tool.func({ filePath: testFile, offset: 3, limit: 2 });
    assert(result.includes('line3') && result.includes('line4'), 'IT-3-3: offset=3,limit=2 → line3~line4');
    assert(!result.includes('line1'), 'IT-3-3: line1은 포함되지 않음');
  }

  // 3-4: 없는 파일 에러 메시지
  {
    const result = await tool.func({ filePath: path.join(TMP_DIR, 'notexist.txt') });
    assert(result.toLowerCase().includes('오류') || result.toLowerCase().includes('error') ||
           result.toLowerCase().includes('실패') || result.toLowerCase().includes('없'),
      'IT-3-4: 없는 파일 → 에러 메시지 반환');
  }
}

// ═══════════════════════════════════════════════════════════
// IT-4: write_file 도구 직접 호출
// ═══════════════════════════════════════════════════════════
async function testWriteFileTool() {
  console.log('\n[IT-4] write_file 도구 직접 호출');

  const tool = getTool('write_file');
  const readTool = getTool('read_file');
  const testFile = path.join(TMP_DIR, 'it4-write.txt');

  // 4-1: Plan Mode 차단
  {
    planModeState.active = true;
    const result = await tool.func({ filePath: testFile, content: 'blocked' });
    planModeState.active = false;
    assert(result.includes('차단됨') || result.includes('Plan Mode'),
      'IT-4-1: Plan Mode 활성 시 차단 메시지');
  }

  // 4-2: read-before-write 미준수 오류
  {
    const original = 'original content\n';
    await fs.writeFile(testFile, original, 'utf-8');
    readFileState.delete(testFile); // read 기록 없음
    const result = await tool.func({ filePath: testFile, content: 'new content\n' });
    assert(result.includes('read_file') || result.includes('읽어야'),
      'IT-4-2: readFileState 없으면 read-before-write 오류');
  }

  // 4-3: 정상 수정 (mock inquirer confirm=true)
  {
    const original = 'hello world\n';
    await fs.writeFile(testFile, original, 'utf-8');
    // read_file 로 읽어서 readFileState 등록
    await readTool.func({ filePath: testFile });

    const testFn = withMockUI([true], async () => {
      return await tool.func({ filePath: testFile, content: 'hello universe\n' });
    });
    const result = await testFn();
    const saved = await fs.readFile(testFile, 'utf-8');
    assert(saved === 'hello universe\n', 'IT-4-3: confirmed=true → 파일 내용 변경됨');
  }

  // 4-4: 취소 시 파일 변경 없음 (mock inquirer confirm=false)
  {
    const original2 = 'keep this\n';
    await fs.writeFile(testFile, original2, 'utf-8');
    await readTool.func({ filePath: testFile });

    const testFn = withMockUI([false], async () => {
      return await tool.func({ filePath: testFile, content: 'changed\n' });
    });
    await testFn();
    const saved = await fs.readFile(testFile, 'utf-8');
    assert(saved === 'keep this\n', 'IT-4-4: confirmed=false → 파일 내용 유지');
  }
}

// ═══════════════════════════════════════════════════════════
// IT-5: edit_file 도구 직접 호출
// ═══════════════════════════════════════════════════════════
async function testEditFileTool() {
  console.log('\n[IT-5] edit_file 도구 직접 호출');

  const tool = getTool('edit_file');
  const readTool = getTool('read_file');
  const testFile = path.join(TMP_DIR, 'it5-edit.txt');

  // 5-1: Plan Mode 차단
  {
    planModeState.active = true;
    const result = await tool.func({
      filePath: testFile, old_string: 'a', new_string: 'b',
    });
    planModeState.active = false;
    assert(result.includes('차단됨') || result.includes('Plan Mode'),
      'IT-5-1: Plan Mode 차단 확인');
  }

  // 5-2: read-before-write 미준수
  {
    await fs.writeFile(testFile, 'foo bar\n', 'utf-8');
    readFileState.delete(testFile);
    const result = await tool.func({
      filePath: testFile, old_string: 'foo', new_string: 'baz',
    });
    assert(result.includes('read_file') || result.includes('읽어야'),
      'IT-5-2: readFileState 없으면 오류');
  }

  // 5-3: old_string 없는 경우
  {
    await fs.writeFile(testFile, 'foo bar\n', 'utf-8');
    await readTool.func({ filePath: testFile });
    const result = await tool.func({
      filePath: testFile, old_string: 'NONEXISTENT', new_string: 'x',
    });
    assert(result.includes('찾을 수 없') || result.includes('오류'),
      'IT-5-3: old_string 없으면 오류');
  }

  // 5-4: 정상 교체 (mock inquirer confirm=true)
  {
    await fs.writeFile(testFile, 'Hello World\n', 'utf-8');
    await readTool.func({ filePath: testFile });
    const testFn = withMockUI([true], async () => {
      return await tool.func({
        filePath: testFile, old_string: 'World', new_string: 'Universe',
      });
    });
    await testFn();
    const saved = await fs.readFile(testFile, 'utf-8');
    assert(saved === 'Hello Universe\n', 'IT-5-4: 정상 교체 → "Hello Universe"');
  }

  // 5-5: replace_all 옵션
  {
    await fs.writeFile(testFile, 'aa bb aa\n', 'utf-8');
    await readTool.func({ filePath: testFile });
    const testFn = withMockUI([true], async () => {
      return await tool.func({
        filePath: testFile, old_string: 'aa', new_string: 'cc', replace_all: true,
      });
    });
    await testFn();
    const saved = await fs.readFile(testFile, 'utf-8');
    assert(saved === 'cc bb cc\n', 'IT-5-5: replace_all=true → 모든 "aa" 교체');
  }
}

// ═══════════════════════════════════════════════════════════
// IT-6: Plan Mode 전체 흐름
// ═══════════════════════════════════════════════════════════
async function testPlanModeFlow() {
  console.log('\n[IT-6] Plan Mode 전체 흐름');

  const enterTool = getTool('enter_plan_mode');
  const exitTool  = getTool('exit_plan_mode');
  const writeTool = getTool('write_file');

  // 6-1: 초기 상태 비활성
  {
    assert(!planModeState.active, 'IT-6-1: 초기 planModeState.active = false');
  }

  // 6-2: enter_plan_mode → active=true
  {
    await enterTool.func({});
    assert(planModeState.active === true, 'IT-6-2: enter_plan_mode 후 active=true');
    assert(planModeState.enteredAt instanceof Date, 'IT-6-2: enteredAt Date 객체 설정됨');
  }

  // 6-3: Plan Mode 중 write_file 차단
  {
    const result = await writeTool.func({
      filePath: path.join(TMP_DIR, 'blocked.txt'), content: 'blocked',
    });
    assert(result.includes('차단됨'), 'IT-6-3: Plan Mode 중 write_file 차단');
  }

  // 6-4: 중복 enter_plan_mode 호출 → 이미 활성 메시지
  {
    const result = await enterTool.func({});
    assert(result.includes('이미') || result.includes('already') || result.includes('Plan Mode'),
      'IT-6-4: 이미 Plan Mode 중 enter → 중복 메시지');
  }

  // 6-5: exit_plan_mode 승인 → active=false
  {
    const testFn = withMockUI(['approve'], async () => {
      return await exitTool.func({ plan: '테스트 계획입니다.' });
    });
    const result = await testFn();
    assert(!planModeState.active, 'IT-6-5: exit_plan_mode 승인 후 active=false');
    assert(result.includes('승인'), 'IT-6-5: 반환값에 "승인" 포함');
  }

  // 6-6: 비활성 상태에서 exit_plan_mode → 오류 메시지
  {
    const result = await exitTool.func({ plan: '계획' });
    assert(result.includes('아닙니다') || result.includes('먼저') || result.includes('enter_plan_mode'),
      'IT-6-6: 비활성 상태 exit → 오류 메시지');
  }

  // 6-7: exit_plan_mode 거절 → active 유지
  {
    await enterTool.func({});
    const testFn = withMockUI(['reject'], async () => {
      return await exitTool.func({ plan: '거절될 계획' });
    });
    const result = await testFn();
    assert(planModeState.active === true, 'IT-6-7: 계획 거절 후 active 유지');
    assert(result.includes('거절') || result.includes('reject'),
      'IT-6-7: 반환값에 "거절" 또는 "reject" 포함');

    // 정리
    planModeState.active = false;
    planModeState.enteredAt = null;
  }
}

// ═══════════════════════════════════════════════════════════
// IT-7: 세션 저장/로드 라운드트립
// ═══════════════════════════════════════════════════════════
async function testSessionRoundtrip() {
  console.log('\n[IT-7] 세션 저장/로드 라운드트립');

  const sessionDir = path.join(TMP_DIR, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, 'test-session.json');

  // 대화 기록 생성
  await memory.clear();
  await memory.saveContext({ input: '안녕' }, { output: '반갑습니다' });
  await memory.saveContext({ input: '오늘 날씨는?' }, { output: '맑음' });

  const historyData = await memory.loadMemoryVariables({});
  const messages = historyData.chat_history || [];

  // 7-1: 메모리에 메시지 4개 (human+ai 2쌍)
  {
    assert(messages.length === 4, `IT-7-1: 저장 전 메시지 4개 (실제: ${messages.length})`);
  }

  // 7-2: 세션 JSON 직렬화
  {
    const sessionData = {
      version: 1,
      provider: 'gemini',
      baseDir: TMP_DIR,
      savedAt: new Date().toISOString(),
      messages: messages.map(m => ({
        type: m._getType(),
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    };
    await fs.writeFile(sessionFile, JSON.stringify(sessionData, null, 2), 'utf-8');
    assert(true, 'IT-7-2: JSON 직렬화 오류 없음');
  }

  // 7-3: JSON 파일 구조 검증
  {
    const raw = await fs.readFile(sessionFile, 'utf-8');
    const data = JSON.parse(raw);
    assert(data.version === 1, 'IT-7-3: version = 1');
    assert(data.provider === 'gemini', 'IT-7-3: provider = "gemini"');
    assert(Array.isArray(data.messages), 'IT-7-3: messages 배열');
    assert(data.messages.length === 4, `IT-7-3: messages 4개 (실제: ${data.messages.length})`);
  }

  // 7-4: 세션 로드 후 메모리 복원
  {
    await memory.clear();
    const raw = await fs.readFile(sessionFile, 'utf-8');
    const data = JSON.parse(raw);
    for (let i = 0; i < data.messages.length - 1; i += 2) {
      const human = data.messages[i];
      const ai    = data.messages[i + 1];
      if (human && ai) await memory.saveContext({ input: human.content }, { output: ai.content });
    }
    const restored = await memory.loadMemoryVariables({});
    const msgs = restored.chat_history || [];
    assert(msgs.length === 4, `IT-7-4: 복원 후 메시지 4개 (실제: ${msgs.length})`);
  }

  // 7-5: 복원된 메시지 내용 검증
  {
    const restored = await memory.loadMemoryVariables({});
    const msgs = restored.chat_history || [];
    const humanMsgs = msgs.filter(m => m._getType() === 'human').map(m => m.content);
    assert(humanMsgs.includes('안녕'), 'IT-7-5: "안녕" human 메시지 복원됨');
    assert(humanMsgs.includes('오늘 날씨는?'), 'IT-7-5: "오늘 날씨는?" human 메시지 복원됨');
  }

  // 7-6: 없는 세션 파일 → ENOENT 예외
  {
    let caught = null;
    try {
      await fs.readFile(path.join(sessionDir, 'nonexist.json'), 'utf-8');
    } catch (e) {
      caught = e;
    }
    assert(caught?.code === 'ENOENT', 'IT-7-6: 없는 세션 파일 → ENOENT');
  }

  // 7-7: savedAt 필드가 ISO 날짜 형식
  {
    const raw = await fs.readFile(sessionFile, 'utf-8');
    const data = JSON.parse(raw);
    const d = new Date(data.savedAt);
    assert(!isNaN(d.getTime()), 'IT-7-7: savedAt 파싱 가능한 ISO 날짜');
  }
}

// ═══════════════════════════════════════════════════════════
// IT-8: git 도구 직접 호출
// ═══════════════════════════════════════════════════════════
async function testGitTools() {
  console.log('\n[IT-8] git 도구 직접 호출');

  const statusTool = getTool('git_status');
  const diffTool   = getTool('git_diff');
  const logTool    = getTool('git_log');

  // 실제 mycli 저장소 경로를 baseDir 로 설정
  const repoDir = path.resolve(__dirname, '..');
  setBaseDir(repoDir);

  // 8-1: git_status 반환값 존재
  {
    const result = await statusTool.func({});
    assert(typeof result === 'string' && result.length > 0, 'IT-8-1: git_status 문자열 반환');
  }

  // 8-2: git_log 반환값 존재
  {
    const result = await logTool.func({ n: 3, oneline: true });
    assert(typeof result === 'string' && result.length > 0, 'IT-8-2: git_log n=3 문자열 반환');
  }

  // 8-3: git_log n=1 커밋 1개
  {
    const result = await logTool.func({ n: 1, oneline: true });
    const lines = result.trim().split('\n').filter(l => l.trim());
    assert(lines.length === 1, `IT-8-3: n=1 → 1줄 (실제: ${lines.length})`);
  }

  // 8-4: git_diff --stat 반환
  {
    const result = await diffTool.func({ stat: true });
    assert(typeof result === 'string', 'IT-8-4: git_diff stat → 문자열');
  }

  // 8-5: git_status Plan Mode 와 무관하게 실행됨
  {
    planModeState.active = true;
    const result = await statusTool.func({});
    planModeState.active = false;
    assert(!result.includes('차단됨'), 'IT-8-5: git_status는 Plan Mode 차단 대상 아님');
  }

  // baseDir 복구
  setBaseDir(TMP_DIR);
}

// ═══════════════════════════════════════════════════════════
// IT-9: 멀티라인 파싱 로직 (askQuestion 내 """ 구분자)
// ═══════════════════════════════════════════════════════════
async function testMultilineParsingLogic() {
  console.log('\n[IT-9] 멀티라인 파싱 로직');

  // 이 로직은 index.js 의 askQuestion 내부에 있으므로
  // 동일한 로직을 인라인으로 재현하여 테스트합니다.

  function simulateMultilineInput(rawLine, collectedLines) {
    if (rawLine.trim() === '"""') {
      return collectedLines.join('\n');
    }
    return rawLine;
  }

  // 9-1: """ 트리거 감지
  {
    const isMultiline = '"""'.trim() === '"""';
    assert(isMultiline, 'IT-9-1: """ 트리거 감지');
  }

  // 9-2: 멀티라인 조합
  {
    const lines = ['첫 번째 줄', '두 번째 줄', '세 번째 줄'];
    const result = simulateMultilineInput('"""', lines);
    assert(result === '첫 번째 줄\n두 번째 줄\n세 번째 줄', 'IT-9-2: 멀티라인 줄 조합');
  }

  // 9-3: 일반 입력은 그대로 반환
  {
    const result = simulateMultilineInput('일반 입력', []);
    assert(result === '일반 입력', 'IT-9-3: 일반 입력 → 그대로 반환');
  }

  // 9-4: 빈 멀티라인 (즉시 """ 종료)
  {
    const result = simulateMultilineInput('"""', []);
    assert(result === '', 'IT-9-4: 빈 멀티라인 → 빈 문자열');
  }

  // 9-5: """ 아닌 줄은 트리거 아님
  {
    assert('  """  '.trim() === '"""', 'IT-9-5: 앞뒤 공백 있어도 """ 트리거 인식');
    assert('"" 아님'.trim() !== '"""', 'IT-9-5: "" 두 개는 트리거 아님');
  }
}

// ═══════════════════════════════════════════════════════════
// IT-10: 다중 @ 파일 토큰 파싱
// ═══════════════════════════════════════════════════════════
async function testMultiAttachParsing() {
  console.log('\n[IT-10] 다중 @ 파일 토큰 파싱');

  // index.js 의 handleAttach 내 토큰 파싱 로직을 인라인 재현
  function parseAttachInput(rawInput) {
    const tokens = rawInput.trim().split(/\s+/);
    const atTokens  = tokens.filter(t => t.startsWith('@'));
    const nonAtText = tokens.filter(t => !t.startsWith('@')).join(' ').trim();
    return { atTokens, nonAtText };
  }

  // 10-1: 단일 @ 토큰 추출
  {
    const { atTokens, nonAtText } = parseAttachInput('@index.js');
    assert(atTokens.length === 1 && atTokens[0] === '@index.js', 'IT-10-1: 단일 @ 토큰');
    assert(nonAtText === '', 'IT-10-1: 텍스트 없음');
  }

  // 10-2: 다중 @ 토큰 추출
  {
    const { atTokens, nonAtText } = parseAttachInput('@a.js @b.js @c.js 이것이 질문');
    assert(atTokens.length === 3, `IT-10-2: @ 토큰 3개 (실제: ${atTokens.length})`);
    assert(nonAtText === '이것이 질문', `IT-10-2: 비-@텍스트 = "이것이 질문" (실제: "${nonAtText}")`);
  }

  // 10-3: @ 토큰 없을 때
  {
    const { atTokens, nonAtText } = parseAttachInput('그냥 질문입니다');
    assert(atTokens.length === 0, 'IT-10-3: @ 없으면 atTokens 빈 배열');
    assert(nonAtText === '그냥 질문입니다', 'IT-10-3: 전체가 nonAtText');
  }

  // 10-4: @ 키워드 슬라이싱
  {
    const { atTokens } = parseAttachInput('@index.js @lib/utils.js');
    const keywords = atTokens.map(t => t.length > 1 ? t.slice(1) : '');
    assert(keywords[0] === 'index.js',    'IT-10-4: @ 제거 후 "index.js"');
    assert(keywords[1] === 'lib/utils.js','IT-10-4: @ 제거 후 "lib/utils.js"');
  }

  // 10-5: @ 만 있는 토큰 (키워드 없음)
  {
    const { atTokens } = parseAttachInput('@ 질문');
    assert(atTokens.length === 1 && atTokens[0] === '@', 'IT-10-5: "@" 단독 토큰 추출');
    const kw = atTokens[0].length > 1 ? atTokens[0].slice(1) : '';
    assert(kw === '', 'IT-10-5: "@" 토큰 키워드 빈 문자열');
  }
}

// ═══════════════════════════════════════════════════════════
// IT-11: execute_code 도구
// ═══════════════════════════════════════════════════════════
async function testExecuteCode() {
  console.log('\n[IT-11] execute_code 도구');

  const tool = getTool('execute_code');
  if (!tool) {
    console.log('  ⚠️  execute_code 도구 없음 (SKIP)');
    return;
  }

  // 11-1: Plan Mode 차단
  {
    planModeState.active = true;
    const result = await tool.func({
      code: 'console.log("hi")',
      description: 'test',
      packages: [],
      inputFiles: [],
      outputFiles: [],
    });
    planModeState.active = false;
    assert(result.includes('차단됨') || result.includes('Plan Mode'),
      'IT-11-1: Plan Mode 중 execute_code 차단');
  }

  // 11-2: 사용자 취소 → 실행 안 됨
  {
    const testFn = withMockUI([false], async () => {
      return await tool.func({
        code: 'console.log("should not run")',
        description: '취소 테스트',
        packages: [],
        inputFiles: [],
        outputFiles: [],
      });
    });
    const result = await testFn();
    assert(result.includes('취소') || result.includes('cancel') || result.includes('않'),
      'IT-11-2: 확인 거부 → 실행 취소 메시지');
  }

  // 11-3: 간단한 코드 실행 성공
  {
    const testFn = withMockUI([true], async () => {
      return await tool.func({
        code: 'console.log("execute_code_test_ok")',
        description: '기본 실행 테스트',
        packages: [],
        inputFiles: [],
        outputFiles: [],
        timeout: 10000,
      });
    });
    const result = await testFn();
    assert(result.includes('execute_code_test_ok') || result.includes('완료') || result.includes('성공'),
      'IT-11-3: 간단한 console.log 코드 실행 성공');
  }

  // 11-4: 코드 오류 → 에러 메시지 반환
  {
    const testFn = withMockUI([true], async () => {
      return await tool.func({
        code: 'throw new Error("intentional_error_42")',
        description: '에러 테스트',
        packages: [],
        inputFiles: [],
        outputFiles: [],
        timeout: 10000,
      });
    });
    const result = await testFn();
    assert(result.includes('intentional_error_42') || result.includes('오류') || result.includes('STDERR'),
      'IT-11-4: 코드 오류 → STDERR 또는 오류 메시지 포함');
  }

  // 11-5: description 필드가 표시에 활용됨 (함수 시그니처 검증)
  {
    const schema = tool.schema || tool.inputSchema || {};
    const hasDescription = JSON.stringify(schema).includes('description');
    assert(hasDescription, 'IT-11-5: schema에 description 필드 포함');
  }
}

// ═══════════════════════════════════════════════════════════
// IT-12: install_package 도구
// ═══════════════════════════════════════════════════════════
async function testInstallPackage() {
  console.log('\n[IT-12] install_package 도구');

  const tool = getTool('install_package');
  if (!tool) {
    console.log('  ⚠️  install_package 도구 없음 (SKIP)');
    return;
  }

  // 12-1: 소형 패키지(is-odd) 설치 → 성공 메시지
  {
    const result = await tool.func({ packages: ['is-odd'] });
    assert(
      result.includes('설치') || result.includes('완료') || result.includes('added') || result.includes('up to date'),
      'IT-12-1: 패키지 설치 성공 메시지 반환'
    );
  }

  // 12-2: 결과가 문자열 타입
  {
    const result = await tool.func({ packages: ['is-odd'] });
    assert(typeof result === 'string' && result.length > 0,
      'IT-12-2: 설치 결과가 비어 있지 않은 문자열');
  }

  // 12-3: schema에 packages 필드 포함
  {
    const schema = tool.schema || tool.inputSchema || {};
    const hasPackages = JSON.stringify(schema).includes('packages');
    assert(hasPackages, 'IT-12-3: schema에 packages 필드 포함');
  }
}

// ═══════════════════════════════════════════════════════════
// 전체 실행
// ═══════════════════════════════════════════════════════════
async function main() {
  console.log(chalk_bold('='.repeat(55)));
  console.log(chalk_bold('  mycli 통합 테스트 (LLM Mock 주입)'));
  console.log(chalk_bold('='.repeat(55)));

  await setup();
  try {
    await testMockExecutorBasic();
    await testHandleChatMemory();
    await testReadFileTool();
    await testWriteFileTool();
    await testEditFileTool();
    await testPlanModeFlow();
    await testSessionRoundtrip();
    await testGitTools();
    await testMultilineParsingLogic();
    await testMultiAttachParsing();
    await testExecuteCode();
    await testInstallPackage();
  } finally {
    await teardown();
    await memory.clear();
    // 상태 정리
    planModeState.active = false;
    planModeState.enteredAt = null;
    resetMock();
  }

  console.log('\n' + chalk_bold('='.repeat(55)));
  console.log(`  결과: ${passed + failed}개 테스트`);
  console.log(`  ✅ PASS: ${passed}`);
  console.log(`  ❌ FAIL: ${failed}`);
  console.log(chalk_bold('='.repeat(55)) + '\n');

  if (failed > 0) process.exit(1);
}

// chalk 없이도 동작하는 bold 래퍼
function chalk_bold(s) { return `\x1b[1m${s}\x1b[0m`; }

main().catch(err => {
  console.error('테스트 실행 중 예외:', err);
  process.exit(1);
});
