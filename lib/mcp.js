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

export class McpClient {
  constructor(serverConfig) {
    this.config = serverConfig;
    this.process = null;
    this.pendingRequests = new Map();
    this.nextId = 1;
    this.buffer = '';
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

    await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mycli', version: '1.0.0' },
    });
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
      this.pendingRequests.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n';
      this.process.stdin.write(msg);
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP 요청 타임아웃: ${method}`));
        }
      }, 5000);
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
    if (this.process) {
      this.process.stdin.end();
      this.process.kill();
    }
  }
}

export class HttpMcpClient {
  constructor(serverConfig) {
    this.config = serverConfig; // { name, url, headers? }
    this.nextId = 1;
  }

  async start() {
    await this._sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mycli', version: '1.0.0' },
    });
  }

  async _sendRequest(method, params = {}) {
    const id = this.nextId++;
    const headers = {
      'Content-Type': 'application/json',
      ...(this.config.headers ?? {}),
    };
    const res = await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const json = await res.json();
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
  const mcpDir = path.join(process.cwd(), 'mcps');
  let configFiles;
  try {
    const entries = await fs.readdir(mcpDir);
    configFiles = entries.filter(
      f => f.endsWith('.json') && !['example-mcp.json', 'mcp-server-example.json'].includes(f)
    );
  } catch {
    return [];
  }

  const mcpTools = [];
  for (const file of configFiles) {
    const filePath = path.join(mcpDir, file);
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
