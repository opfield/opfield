import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getEnv } from '@/config/env.js';
import { accessSummaryPrincipal } from '@/lib/access-summary-resolver.js';
import type { User } from '@/types.js';
import { registerMcpAccessResource } from './mcp-access.js';
import { registerMcpPrompts } from './mcp-prompts.js';
import { registerMcpResources } from './mcp-resources.js';
import { registerMcpSkills } from './mcp-skills.js';
import { registerMcpToolHandlers } from './mcp-tools.js';

export interface CreateMcpServerOptions {
  user: User;
  scopes: string[];
  tokenId: string;
  tokenPrefix: string;
  mcpSessionId?: string;
  issuedMcpSessionId?: string;
  authType?: 'oauth' | 'api-token';
  clientId?: string;
  eagerToolListing?: boolean;
  /** Summary of folder-, node- or resource-limited access, added to the instructions at initialize. */
  accessInstructions?: string;
}

export const MCP_SERVER_INSTRUCTIONS =
  'Opfield MCP exposes scoped control-plane tools, curated read-only resources, operational prompts, and agent skills (gateway://skills; start with gateway://skills/using-gateway/SKILL.md). OAuth token scopes determine every listed and callable capability. Access limited to folders, nodes or resources is normal: when a list is empty or an action is refused at the root, call get_my_access (or read gateway://access) and work inside the granted folders, passing folderId (and nodeId) when creating.';

export function createMcpServer(options: CreateMcpServerOptions) {
  const server = new McpServer(
    // Clients see the Gateway release they talk to (`dev` in a source checkout).
    { name: 'gateway', version: getEnv().APP_VERSION },
    {
      instructions: options.accessInstructions
        ? `${MCP_SERVER_INSTRUCTIONS}\n\n${options.accessInstructions}`
        : MCP_SERVER_INSTRUCTIONS,
    }
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: false,
  });

  registerMcpToolHandlers(
    server,
    {
      server,
      scopes: options.scopes,
      tokenId: options.tokenId,
      tokenPrefix: options.tokenPrefix,
      mcpSessionId: options.mcpSessionId,
      issuedMcpSessionId: options.issuedMcpSessionId,
      authType: options.authType,
      clientId: options.clientId,
      eagerToolListing: options.eagerToolListing,
    },
    options.user
  );
  registerMcpResources(server, options.scopes);
  registerMcpAccessResource(server, options.scopes, accessSummaryPrincipal(options.user, 'mcp'));
  registerMcpPrompts(server, options.scopes);
  registerMcpSkills(server);

  return { server, transport };
}
