// =========================================================
// MCP(Model Context Protocol) 클라이언트
// stdio/HTTP JSON-RPC 2.0. initialize → tools/list → tools/call.
// mcps/*.json 설정 파일(예시 파일 제외)에서 서버 자동 로드.
// - command 필드: stdio 방식 (McpClient)
// - url 필드: HTTP POST 방식 (HttpMcpClient)
// =========================================================
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import chalk from 'chalk';
import { resolveProjectPaths } from './config-paths.js';

const DEFAULT_STDIO_TIMEOUT = 5000;
const DEFAULT_HTTP_TIMEOUT  = 10000;

export class McpClient {
  constructor(serverConfig) {
    this.config = serverConfig;
    this.process = null;
    this.pendingRequests = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.timeout = Number(serverConfig.timeout) > 0 ? Number(serverConfig.timeout) : DEFAULT_STDIO_TIMEOUT;
  }

  async start() {
    const parts = this.config.command.split(' ');
    const cmd = parts[0];
    const cmdArgs = [...parts.slice(1), ...(this.config.args || [])];

    this.process = spawn(cmd, cmdArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      cwd: process.cwd(),
    });

    this.process.stdout.on('data', (data) => {
      this.buffer += data.toString('utf-8');
      this._parseMessages();
    });

    this.process.stderr.on('data', (d) =>
      console.error(chalk.gray(`[MCP:${this.config.name}] ${d.toString().trim()}`))
    );

    const result = await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mycli', version: '1.0.0' },
    });
    // MCP 스펙: initialize 응답을 받은 뒤 반드시 initialized 알림을 보내야 한다.
    // 이걸 빠뜨리면 엄격한 서버는 이후 tools/list 를 거부한다.
    this._sendNotification('notifications/initialized');
    return result;
  }

  /** 응답을 기대하지 않는 JSON-RPC 알림 (id 없음) */
  _sendNotification(method, params = {}) {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  _parseMessages() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop(); // 마지막 불완전 줄은 버퍼에 보존
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const { resolve, reject } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch {
        // JSON 파싱 실패 → 무시
      }
    }
  }

  _sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      // 타이머를 정리하지 않으면 응답을 받은 뒤에도 타임아웃만큼 이벤트 루프가 살아있는다
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error(`MCP 요청 타임아웃(${this.timeout}ms): ${method}`));
        }
      }, this.timeout);
      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n');
    });
  }

  async listTools() {
    const result = await this._sendRequest('tools/list');
    return result?.tools ?? [];
  }

  async callTool(toolName, toolArgs) {
    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: toolArgs,
    });
    return result?.content?.map(c => c.text).join('\n') ?? JSON.stringify(result);
  }

  stop() {
    if (!this.process) return;

    // 대기 중인 요청을 먼저 정리 (호출자가 영원히 await 하지 않도록)
    for (const { reject } of this.pendingRequests.values()) {
      reject(new Error('MCP 클라이언트가 종료되었습니다.'));
    }
    this.pendingRequests.clear();

    const child = this.process;
    this.process = null;
    try { child.stdin?.end(); } catch { /* 이미 닫힘 */ }
    try { child.kill(); } catch { /* 이미 종료됨 */ }
    // 자식이 종료돼도 stdout/stderr 파이프가 열려 있으면 프로세스가 끝나지 않는다
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref?.();
  }
}

export class HttpMcpClient {
  constructor(serverConfig) {
    this.config = serverConfig; // { name, url, token?, headers?, timeout? }
    this.nextId = 1;
    this.sessionId = null;
    this.timeout = Number(serverConfig.timeout) > 0 ? Number(serverConfig.timeout) : DEFAULT_HTTP_TIMEOUT;
  }

  async start() {
    const result = await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mycli', version: '1.0.0' },
    });
    // MCP 스펙: initialize 응답 후 initialized 알림 필요.
    // 알림은 응답 본문이 없으므로(보통 202) 실패해도 연결을 막지 않는다.
    await this._sendNotification('notifications/initialized');
    return result;
  }

  /** 응답을 기대하지 않는 JSON-RPC 알림 (id 없음, 보통 202 Accepted) */
  async _sendNotification(method, params = {}) {
    try {
      await fetch(this.config.url, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (e) {
      console.error(chalk.gray(`[MCP:${this.config.name}] ${method} 알림 전송 실패: ${e.message}`));
    }
  }

  _buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      // MCP Streamable HTTP: 서버가 JSON 또는 SSE 중 선택할 수 있도록 명시
      'Accept': 'application/json, text/event-stream',
    };
    // token 필드는 Authorization: Bearer <token> 으로 자동 변환
    if (this.config.token) headers['Authorization'] = `Bearer ${this.config.token}`;
    // headers 필드로 추가 헤더 병합 (token보다 우선순위 낮음)
    Object.assign(headers, this.config.headers ?? {});
    // initialize 이후 발급된 세션 ID를 모든 요청에 포함
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  async _sendRequest(method, params = {}) {
    const id = this.nextId++;
    const res = await fetch(this.config.url, {
      method: 'POST',
      headers: this._buildHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
      signal: AbortSignal.timeout(this.timeout),
    });

    // initialize 응답에 포함된 세션 ID 저장
    const newSessionId = res.headers.get('Mcp-Session-Id');
    if (newSessionId) this.sessionId = newSessionId;

    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      const detail = body ? ` — ${body.slice(0, 300)}` : '';
      throw new Error(`HTTP ${res.status}${detail}`);
    }

    const contentType = res.headers.get('Content-Type') ?? '';
    let json;
    if (contentType.includes('text/event-stream')) {
      // SSE 응답: data: {...} 라인에서 마지막 JSON-RPC 메시지 추출
      const text = await res.text();
      const dataLine = text
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim())
        .filter(Boolean)
        .at(-1);
      if (!dataLine) throw new Error('SSE 응답에 data 라인이 없습니다');
      json = JSON.parse(dataLine);
    } else {
      json = await res.json();
    }

    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  async listTools() {
    const result = await this._sendRequest('tools/list');
    return result?.tools ?? [];
  }

  async callTool(toolName, toolArgs) {
    const result = await this._sendRequest('tools/call', {
      name: toolName,
      arguments: toolArgs,
    });
    return result?.content?.map(c => c.text).join('\n') ?? JSON.stringify(result);
  }

  stop() {}
}

export function jsonSchemaToZod(schema) {
  if (!schema || schema.type !== 'object') return z.object({}).catchall(z.unknown());
  const shape = {};
  const required = schema.required ?? [];
  for (const [key, val] of Object.entries(schema.properties ?? {})) {
    let field;
    if (val.type === 'string')       field = z.string();
    else if (val.type === 'number')  field = z.number();
    else if (val.type === 'boolean') field = z.boolean();
    else if (val.type === 'array')   field = z.array(z.unknown());
    else                              field = z.unknown();
    if (val.description) field = field.describe(val.description);
    shape[key] = required.includes(key) ? field : field.optional();
  }
  return z.object(shape);
}

export async function loadMcpTools() {
  // mcps/ 는 BASE_DIR 과 cwd 양쪽에서 탐색한다.
  // (기존엔 cwd 만 봐서 MYCLI_WORKDIR 사용 시 조용히 로드되지 않았다)
  const EXAMPLES = ['example-mcp.json', 'mcp-server-example.json'];
  const configPaths = [];
  for (const mcpDir of resolveProjectPaths('mcps')) {
    try {
      const entries = await fs.readdir(mcpDir);
      for (const f of entries) {
        if (f.endsWith('.json') && !EXAMPLES.includes(f)) configPaths.push(path.join(mcpDir, f));
      }
    } catch { /* 디렉터리 없음 → 스킵 */ }
  }
  if (configPaths.length === 0) return [];

  const mcpTools = [];
  const seenNames = new Set();
  for (const filePath of configPaths) {
    const file = path.basename(filePath);
    let configs;
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      configs = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      console.error(chalk.red(`[MCP] 설정 파일 파싱 실패: ${file} - ${e.message}`));
      continue;
    }

    for (const config of configs) {
      const isHttp = Boolean(config.url);
      if (!config.name || (!config.command && !config.url)) continue;
      // 같은 서버명이 두 경로에 있으면 먼저 찾은 것만 사용 (도구 이름 충돌 방지)
      if (seenNames.has(config.name)) {
        console.error(chalk.gray(`[MCP:${config.name}] 이름이 중복되어 건너뜁니다 (${file})`));
        continue;
      }
      seenNames.add(config.name);
      const client = isHttp ? new HttpMcpClient(config) : new McpClient(config);
      try {
        await client.start();
        const serverTools = await client.listTools();
        const transport = isHttp ? 'HTTP' : 'stdio';
        console.log(chalk.gray(`[MCP:${config.name}] (${transport}) ${serverTools.length}개 도구 로드됨`));

        for (const tool of serverTools) {
          const zodSchema = jsonSchemaToZod(tool.inputSchema ?? { type: 'object', properties: {} });
          mcpTools.push(new DynamicStructuredTool({
            name: `mcp_${config.name}_${tool.name}`,
            description: tool.description ?? `MCP tool: ${tool.name}`,
            schema: zodSchema,
            func: async (args) => {
              try {
                return await client.callTool(tool.name, args);
              } catch (e) {
                return `MCP 도구 실행 실패: ${e.message}`;
              }
            },
          }));
        }
      } catch (e) {
        console.error(chalk.red(`[MCP:${config.name}] 연결 실패: ${e.message}`));
        client.stop();
      }
    }
  }
  return mcpTools;
}
