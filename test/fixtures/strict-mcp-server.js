#!/usr/bin/env node
/**
 * 테스트용 MCP stdio 서버 (스펙 엄격 모드)
 *
 * 실제 MCP SDK 서버처럼 initialize → notifications/initialized 순서를 요구한다.
 * initialized 알림을 받기 전에 tools/list 가 오면 에러로 응답한다.
 * → 클라이언트가 알림을 보내지 않으면 도구 로드가 실패한다.
 */
let initialized = false;
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf-8');
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { continue; }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  // 알림 (id 없음)
  if (msg.id === undefined) {
    if (msg.method === 'notifications/initialized') initialized = true;
    return;
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'strict-test-server', version: '1.0.0' },
      },
    });
    return;
  }

  if (!initialized) {
    send({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32002, message: 'Received request before initialization was complete' },
    });
    return;
  }

  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [{
          name: 'echo',
          description: '입력을 그대로 돌려준다',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: '돌려줄 문자열' } },
            required: ['text'],
          },
        }],
      },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: `echo: ${msg.params?.arguments?.text ?? ''}` }] },
    });
    return;
  }

  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
}
