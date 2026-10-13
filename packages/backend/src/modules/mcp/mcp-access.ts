import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type AccessSummaryPrincipal,
  accessSummaryDatabase,
  buildAccessSummary,
} from '@/lib/access-summary-resolver.js';
import { logger } from '@/lib/logger.js';

export const MCP_ACCESS_RESOURCE_URI = 'opfield://access';

/** Longest access summary added to the server instructions; get_my_access has the rest. */
export const MCP_ACCESS_INSTRUCTIONS_MAX_LENGTH = 1500;

const MAX_INITIALIZE_BODY_BYTES = 64 * 1024;

/**
 * The access summary added to the MCP server instructions at initialize, or '' when the connection's
 * access is broad everywhere. Never fails the handshake: a lookup error only drops the summary.
 */
export async function buildMcpAccessInstructions(scopes: readonly string[]): Promise<string> {
  try {
    const summary = await buildAccessSummary(accessSummaryDatabase(), scopes);
    return summary.limited ? summary.summary.slice(0, MCP_ACCESS_INSTRUCTIONS_MAX_LENGTH) : '';
  } catch (error) {
    logger.warn('Failed to build the MCP access summary', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}

/** Whether a streamable HTTP request body carries the JSON-RPC initialize request. */
export async function isMcpInitializeRequest(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  // An initialize request is a few hundred bytes; never parse large tool payloads (artifact uploads) twice.
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_INITIALIZE_BODY_BYTES) return false;
  try {
    const body = (await request.clone().json()) as unknown;
    const messages = Array.isArray(body) ? body : [body];
    return messages.some(
      (message) => !!message && typeof message === 'object' && (message as { method?: unknown }).method === 'initialize'
    );
  } catch {
    return false;
  }
}

/** opfield://access: the connection's access summary, bounded by the token owner like every call. */
export function registerMcpAccessResource(
  server: McpServer,
  scopes: readonly string[],
  principal?: AccessSummaryPrincipal
): void {
  server.registerResource(
    'opfield-access',
    MCP_ACCESS_RESOURCE_URI,
    {
      title: 'My Opfield access',
      description:
        'What this connection can access, by area: broad or limited, the granted folders (with paths), nodes and resources with their actions, and where it may create. Folder-limited access is normal; work inside the listed folders and pass folderId when creating.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(await buildAccessSummary(accessSummaryDatabase(), scopes, principal)),
        },
      ],
    })
  );
}
