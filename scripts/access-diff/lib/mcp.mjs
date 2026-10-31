// The MCP side of a run: initialize per credential, the tool list, and tools/call.

const PROTOCOL_VERSION = '2025-06-18';
let nextId = 1;

function textOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Opens an MCP session for a credential. Returns { ok, response, sessionId } where `response` is the answer of the
 * initialize request in the shape classifyMcp reads.
 */
export async function initializeMcp(installation, credential) {
  const id = nextId++;
  const answer = await installation.mcp(credential, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'opfield-access-diff', version: '1.0.0' },
    },
  });
  const response = toCallResponse(answer, { initialize: true });
  const ok = answer.httpStatus === 200 && answer.message && !answer.message.error;
  if (ok) {
    await installation.mcp(credential, { jsonrpc: '2.0', method: 'notifications/initialized' }, answer.sessionId);
  }
  return { ok: !!ok, response, sessionId: answer.sessionId ?? null };
}

async function listOnce(installation, credential, sessionId) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const id = nextId++;
    const answer = await installation.mcp(
      credential,
      { jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} },
      sessionId
    );
    const result = answer.message?.result;
    if (!result || !Array.isArray(result.tools)) {
      return { tools, error: answer.error ?? answer.message?.error?.message ?? `tools/list HTTP ${answer.httpStatus}` };
    }
    tools.push(...result.tools);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return { tools, error: null };
}

/**
 * Every tool the credential can see. When the server lists tools lazily (discover_tools), each toolset is activated
 * in the session first so the list is complete.
 */
export async function listMcpTools(installation, credential, sessionId) {
  const first = await listOnce(installation, credential, sessionId);
  if (first.error || !first.tools.some((tool) => tool.name === 'discover_tools')) return first;
  const summary = await callMcpTool(installation, credential, sessionId, 'discover_tools', {});
  let toolsets = [];
  try {
    toolsets = JSON.parse(summary.text ?? '{}').toolsets ?? [];
  } catch {}
  for (const toolset of toolsets) {
    if (typeof toolset?.id === 'string') {
      await callMcpTool(installation, credential, sessionId, 'discover_tools', { category: toolset.id });
    }
  }
  return listOnce(installation, credential, sessionId);
}

function toCallResponse(answer, { initialize = false } = {}) {
  if (answer.error) return { error: answer.error, durationMs: answer.durationMs };
  if (answer.httpStatus !== 200) {
    return { httpStatus: answer.httpStatus, code: answer.code, message: answer.message, durationMs: answer.durationMs };
  }
  if (!answer.message) return { error: 'no JSON-RPC answer in the response', durationMs: answer.durationMs };
  if (answer.message.error) {
    return {
      httpStatus: 200,
      rpcError: { code: answer.message.error.code, message: String(answer.message.error.message ?? '') },
      durationMs: answer.durationMs,
    };
  }
  if (initialize) return { httpStatus: 200, isError: false, text: '', durationMs: answer.durationMs };
  const result = answer.message.result ?? {};
  return { httpStatus: 200, isError: result.isError === true, text: textOf(result), durationMs: answer.durationMs };
}

/** tools/call, answered in the shape classifyMcp reads. */
export async function callMcpTool(installation, credential, sessionId, name, args) {
  const id = nextId++;
  const answer = await installation.mcp(
    credential,
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    sessionId
  );
  return toCallResponse(answer);
}
