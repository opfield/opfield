import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { MatrixContext } from './context.js';

/**
 * Runs one shell snippet in a container through the Docker console WebSocket (the same channel as the UI terminal)
 * and returns what it printed between two nonce markers. The console session is persistent by design, so the
 * runner only detaches afterwards; replayed output from earlier commands is ignored thanks to the nonce.
 */
export function execInContainer(
  ctx: MatrixContext,
  nodeId: string,
  container: string,
  script: string,
  timeoutMs = 45_000
): Promise<{ output?: string; error?: string }> {
  const nonce = randomUUID().slice(0, 8);
  const begin = `MXB${nonce}`;
  const end = `MXE${nonce}`;
  const url = `${ctx.config.url.replace(/^http/, 'ws')}/api/docker/nodes/${nodeId}/containers/${encodeURIComponent(container)}/exec?shell=/bin/sh`;
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${ctx.config.token}` },
      rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    });
    const finish = (result: { output?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: `console exec timed out after ${timeoutMs / 1000}s` }), timeoutMs);
    const sendInput = (text: string) =>
      ws.send(JSON.stringify({ type: 'input', data: Buffer.from(text).toString('base64') }));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'resize', rows: 40, cols: 200 })));
    ws.on('message', (raw) => {
      let message: any;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.type === 'connected') {
        // printf with split markers so the echoed command line itself never matches.
        sendInput(
          `printf '%s\\n' '${begin.slice(0, 3)}''${begin.slice(3)}'; ${script}; printf '%s\\n' '${end.slice(0, 3)}''${end.slice(3)}'\n`
        );
      } else if (message.type === 'output') {
        buffer += Buffer.from(String(message.data ?? ''), 'base64').toString('utf8');
        const from =
          buffer.lastIndexOf(`${begin}\n`) >= 0 ? buffer.lastIndexOf(`${begin}\n`) : buffer.lastIndexOf(`${begin}\r\n`);
        const to = buffer.indexOf(end, from + begin.length);
        if (from >= 0 && to > from)
          finish({
            output: buffer
              .slice(from + begin.length, to)
              .replace(/\r/g, '')
              .trim(),
          });
      } else if (message.type === 'error' || message.type === 'auth_error' || message.type === 'unavailable') {
        finish({ error: `${message.type}: ${String(message.message ?? message.code ?? '').slice(0, 200)}` });
      } else if (message.type === 'exit') {
        finish({ error: `console exited (${message.exitCode}) before the command finished` });
      }
    });
    ws.on('unexpected-response', (_request, response) =>
      finish({ error: `console upgrade refused: HTTP ${response.statusCode}` })
    );
    ws.on('error', (error) => finish({ error: `console error: ${error.message}` }));
    ws.on('close', () => finish({ error: 'console closed before the command finished' }));
  });
}
