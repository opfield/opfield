import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getEnv } from '@/config/env.js';
import { accessSummaryPrincipal } from '@/lib/access-summary-resolver.js';
import { OPFIELD_ABOUT_INSTRUCTIONS } from '@/modules/ai/opfield-about.js';
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
  `${OPFIELD_ABOUT_INSTRUCTIONS}\n\n` +
  "Opfield MCP exposes scoped control-plane tools, curated read-only resources, operational prompts, and agent skills (opfield://skills; start with opfield://skills/using-opfield/SKILL.md). OAuth token scopes determine every listed and callable capability. Access limited to folders, nodes or resources is normal: when a list is empty or an action is refused at the root, call get_my_access (or read opfield://access) and work inside the granted folders, passing folderId (and nodeId) when creating. A node's type decides which tools accept it (usedFor in list_nodes): Docker tools take only type docker nodes, and the list_docker_* tools list across every Docker node you can see when nodeId is omitted.";

export function createMcpServer(options: CreateMcpServerOptions) {
  const server = new McpServer(
    // Clients see the Opfield release they talk to (`dev` in a source checkout).
    { name: 'opfield', version: getEnv().APP_VERSION },
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
