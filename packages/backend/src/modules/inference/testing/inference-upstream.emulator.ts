import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type InferenceEmulatorScenario =
  | 'success'
  | 'reasoning'
  | 'tool'
  | 'missing_usage'
  | 'delay'
  | 'disconnect'
  | 'partial'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable';

export interface InferenceEmulatorRequest {
  method: string;
  path: string;
  body: unknown;
  scenario: InferenceEmulatorScenario;
}

/** Deterministic, secret-free upstream used by integration and manual browser acceptance. */
export class InferenceUpstreamEmulator {
  private server: Server | null = null;
  private requests: InferenceEmulatorRequest[] = [];
  private quotaRemaining = 0.8;

  get receivedRequests(): readonly InferenceEmulatorRequest[] {
    return this.requests;
  }

  setQuotaRemaining(value: number): void {
    this.quotaRemaining = Math.max(0, Math.min(1, value));
  }

  reset(): void {
    this.requests = [];
    this.quotaRemaining = 0.8;
  }

  async start(port = 0): Promise<string> {
    if (this.server) throw new Error('Inference emulator is already running');
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Inference emulator did not bind a TCP port');
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', 'http://emulator.test');
      const body = await readJson(request);
      const scenario = scenarioFrom(request, url, body);
      this.requests.push({ method: request.method ?? 'GET', path: url.pathname, body, scenario });
      if (scenario === 'delay') await new Promise((resolve) => setTimeout(resolve, 150));
      if (writeScenarioError(response, scenario)) return;

      if (request.method === 'GET' && url.pathname.endsWith('/models')) return writeModels(response);
      if (url.pathname === '/quota') return this.writeQuota(response);
      if (url.pathname === '/oauth/token') return writeOAuthToken(response);
      if (url.pathname.endsWith('/messages/count_tokens')) return writeJson(response, { input_tokens: 17 });
      if (url.pathname.endsWith('/images/generations') || url.pathname.endsWith('/images/edits')) {
        return writeJson(response, {
          created: 1_700_000_000,
          data: [{ url: 'https://emulator.invalid/image.png', revised_prompt: 'emulated image' }],
        });
      }
      if (url.pathname.endsWith('/alpha/search')) {
        return writeJson(response, { results: [{ title: 'Opfield emulator', url: 'https://emulator.invalid' }] });
      }
      if (url.pathname.endsWith('/realtime/calls') || url.pathname.endsWith('/live')) {
        return writeJson(response, { id: 'call_emulator', status: 'ready' });
      }
      if (url.pathname.endsWith('/responses')) return writeResponses(response, scenario, body);
      if (url.pathname.endsWith('/chat/completions')) return writeChat(response, scenario, body);
      if (url.pathname.endsWith('/messages')) return writeMessages(response, scenario, body);
      writeJson(response, { error: { message: 'Emulator route not found' } }, 404);
    } catch (error) {
      writeJson(response, { error: { message: error instanceof Error ? error.message : 'Emulator failure' } }, 500);
    }
  }

  private writeQuota(response: ServerResponse): void {
    writeJson(response, {
      windows: [
        { dimension: '5h', remaining_fraction: this.quotaRemaining, reset_at: '2030-01-01T00:00:00.000Z' },
        { dimension: '7d', remaining_fraction: this.quotaRemaining, reset_at: '2030-01-07T00:00:00.000Z' },
        { dimension: '30d', remaining_fraction: this.quotaRemaining, reset_at: '2030-01-30T00:00:00.000Z' },
      ],
      balance_microdollars: 25_000_000,
    });
  }
}

function scenarioFrom(request: IncomingMessage, url: URL, body: unknown): InferenceEmulatorScenario {
  const raw = request.headers['x-emulator-scenario'] ?? url.searchParams.get('scenario');
  const scenario = Array.isArray(raw) ? raw[0] : raw;
  if (isScenario(scenario)) return scenario;
  const payload = asObject(body);
  if (hasToolResult(payload)) return 'success';
  if (Array.isArray(payload?.tools) && payload.tools.length > 0) return 'tool';
  if (payload?.reasoning || payload?.reasoning_effort || payload?.thinking) return 'reasoning';
  return 'success';
}

function isScenario(value: unknown): value is InferenceEmulatorScenario {
  return [
    'success',
    'reasoning',
    'tool',
    'missing_usage',
    'delay',
    'disconnect',
    'partial',
    'unauthorized',
    'rate_limited',
    'unavailable',
  ].includes(String(value));
}

function writeScenarioError(response: ServerResponse, scenario: InferenceEmulatorScenario): boolean {
  const status =
    scenario === 'unauthorized' ? 401 : scenario === 'rate_limited' ? 429 : scenario === 'unavailable' ? 503 : 0;
  if (!status) return false;
  writeJson(response, { error: { type: scenario, message: `Emulated ${status}` } }, status);
  return true;
}

function writeModels(response: ServerResponse): void {
  writeJson(response, {
    object: 'list',
    data: [
      {
        id: 'emulator-reasoning',
        display_name: 'Emulator Reasoning',
        context_window: 200_000,
        max_input_tokens: 180_000,
        max_output_tokens: 20_000,
        input_modalities: ['text', 'image'],
        reasoning_efforts: ['low', 'high', 'max'],
        tools: true,
      },
      { id: 'emulator-fast', display_name: 'Emulator Fast', context_window: 32_000, max_output_tokens: 4_096 },
    ],
  });
}

function writeResponses(response: ServerResponse, scenario: InferenceEmulatorScenario, body: unknown): void {
  const id = `resp_${randomUUID()}`;
  const toolCall = toolCallFrom(body);
  beginSse(response);
  if (scenario === 'reasoning' || (scenario === 'tool' && hasReasoningRequest(body)))
    sse(response, { type: 'response.reasoning_text.delta', item_id: 'rsn_1', delta: 'Think. ' });
  if (scenario === 'tool') {
    sse(response, {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        id: 'call_1',
        call_id: 'call_1',
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    });
  } else {
    sse(response, { type: 'response.output_text.delta', item_id: 'msg_1', delta: responseText(body) });
  }
  if (scenario === 'disconnect') {
    response.destroy();
    return;
  }
  if (scenario === 'partial') {
    response.end();
    return;
  }
  sse(response, {
    type: 'response.completed',
    response: {
      id,
      model: 'emulator-reasoning',
      ...(scenario === 'missing_usage' ? {} : { usage: { input_tokens: 17, output_tokens: 5, total_tokens: 22 } }),
    },
  });
  response.end();
}

function writeChat(response: ServerResponse, scenario: InferenceEmulatorScenario, body: unknown): void {
  const id = `chatcmpl_${randomUUID()}`;
  const toolCall = toolCallFrom(body);
  beginSse(response);
  if (scenario === 'reasoning' || (scenario === 'tool' && hasReasoningRequest(body)))
    sse(response, { id, model: 'emulator-reasoning', choices: [{ delta: { reasoning_content: 'Think. ' } }] });
  if (scenario === 'tool') {
    sse(response, {
      id,
      model: 'emulator-reasoning',
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: toolCall.name, arguments: toolCall.arguments } }],
          },
        },
      ],
    });
  } else {
    sse(response, { id, model: 'emulator-reasoning', choices: [{ delta: { content: responseText(body) } }] });
  }
  if (scenario === 'disconnect') {
    response.destroy();
    return;
  }
  if (scenario === 'partial') {
    response.end();
    return;
  }
  sse(response, {
    id,
    model: 'emulator-reasoning',
    choices: [{ delta: {}, finish_reason: 'stop' }],
    ...(scenario === 'missing_usage' ? {} : { usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } }),
  });
  response.write('data: [DONE]\n\n');
  response.end();
}

function writeMessages(response: ServerResponse, scenario: InferenceEmulatorScenario, body: unknown): void {
  const id = `msg_${randomUUID()}`;
  const toolCall = toolCallFrom(body);
  beginSse(response);
  sse(response, { type: 'message_start', message: { id, model: 'emulator-claude', usage: { input_tokens: 17 } } });
  const block =
    scenario === 'tool'
      ? { type: 'tool_use', id: 'call_1', name: toolCall.name }
      : { type: scenario === 'reasoning' ? 'thinking' : 'text' };
  sse(response, { type: 'content_block_start', index: 0, content_block: block });
  sse(response, {
    type: 'content_block_delta',
    index: 0,
    delta:
      scenario === 'tool'
        ? { type: 'input_json_delta', partial_json: toolCall.arguments }
        : scenario === 'reasoning'
          ? { type: 'thinking_delta', thinking: 'Think. ' }
          : { type: 'text_delta', text: responseText(body) },
  });
  if (scenario === 'disconnect') {
    response.destroy();
    return;
  }
  if (scenario === 'partial') {
    response.end();
    return;
  }
  sse(response, {
    type: 'message_delta',
    delta: { stop_reason: scenario === 'tool' ? 'tool_use' : 'end_turn' },
    ...(scenario === 'missing_usage' ? {} : { usage: { output_tokens: 5 } }),
  });
  response.end();
}

function beginSse(response: ServerResponse): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function sse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeOAuthToken(response: ServerResponse): void {
  writeJson(response, {
    access_token: 'emulator-access-token',
    refresh_token: 'emulator-refresh-token',
    expires_in: 3600,
    token_type: 'Bearer',
  });
}

function writeJson(response: ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function hasToolResult(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  const input = Array.isArray(payload.input) ? payload.input : [];
  if (input.some((item) => asObject(item)?.type === 'function_call_output')) return true;

  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return messages.some((message) => {
    const item = asObject(message);
    if (item?.role === 'tool') return true;
    const content = Array.isArray(item?.content) ? item.content : [];
    return content.some((block) => asObject(block)?.type === 'tool_result');
  });
}

function hasReasoningRequest(body: unknown): boolean {
  const payload = asObject(body);
  return Boolean(payload?.reasoning || payload?.reasoning_effort || payload?.thinking);
}

function toolCallFrom(body: unknown): { name: string; arguments: string } {
  const payload = asObject(body);
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  const names = tools
    .map(asObject)
    .map((tool) => {
      const fn = asObject(tool?.function);
      return typeof tool?.name === 'string' ? tool.name : typeof fn?.name === 'string' ? fn.name : null;
    })
    .filter((name): name is string => name !== null);
  const name = names.find((candidate) => candidate === 'exec_command') ?? names[0] ?? 'lookup';
  return name === 'exec_command'
    ? { name, arguments: JSON.stringify({ cmd: "printf 'opfield-tool-ok\\n'" }) }
    : { name, arguments: JSON.stringify({ q: 'opfield' }) };
}

function responseText(body: unknown): string {
  return hasToolResult(asObject(body)) ? 'The command output was `opfield-tool-ok`.' : 'Opfield emulator response.';
}
