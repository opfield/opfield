import 'reflect-metadata';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { ALL_SCOPES } from '@/lib/scopes.js';
import { AIService } from '@/modules/ai/ai.service.js';
import { AuditService } from '@/modules/audit/audit.service.js';
import { MonitoringService } from '@/modules/monitoring/monitoring.service.js';
import { OAuthService } from '@/modules/oauth/oauth.service.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import type { AppEnv, User } from '@/types.js';
import { mcpRoutes } from './mcp.routes.js';
import { McpSettingsService } from './mcp-settings.service.js';
import { resetMcpDiscoveryStateForTests } from './mcp-tools.js';

vi.mock('@/config/env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/env.js')>()),
  getEnv: () => ({ APP_VERSION: '2.11.0-rc.39' }),
}));

type JsonRecord = Record<string, any>;

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: ['mcp:use', 'nodes:details', 'nodes:create', 'proxy:view', 'ssl:cert:view', 'status-page:view'],
  isBlocked: false,
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json({ message: error.message }, error.status);
    }
    throw error;
  });
  app.route('/api/mcp', mcpRoutes);
  return app;
}

function registerToken(scopes: string[] | null, user: User = USER) {
  container.registerInstance(TokensService, {
    validateToken: vi.fn().mockResolvedValue(
      scopes
        ? {
            user,
            scopes,
            tokenId: 'token-1',
            tokenPrefix: 'opf_abc1234',
          }
        : null
    ),
  } as unknown as TokensService);
  registerOAuth(scopes, user);
}

function registerMcpSettings(enabled = true, extendedCompatibility = false) {
  container.registerInstance(McpSettingsService, {
    getConfig: vi.fn().mockResolvedValue({ serverEnabled: enabled, extendedCompatibility }),
  } as unknown as McpSettingsService);
}

function registerOAuth(scopes: string[] | null = null, user: User = USER, clientId = 'goc_client') {
  container.registerInstance(OAuthService, {
    getMcpResourceUrl: vi.fn().mockReturnValue('https://opfield.example.com/api/mcp'),
    getApiResourceUrl: vi.fn().mockReturnValue('https://opfield.example.com/api'),
    getProtectedResourceMetadataUrl: vi
      .fn()
      .mockReturnValue('https://opfield.example.com/.well-known/oauth-protected-resource/api/mcp'),
    validateAccessToken: vi.fn().mockResolvedValue(
      scopes
        ? {
            user,
            scopes,
            tokenId: 'oauth-token-1',
            tokenPrefix: 'opfo_abc123',
            clientId,
          }
        : null
    ),
  } as unknown as OAuthService);
}

function mcpHeaders(token = 'opfo_valid', mcpSessionId?: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': '2025-11-25',
    ...(mcpSessionId ? { 'Mcp-Session-Id': mcpSessionId } : {}),
  };
}

async function parseMcpMessages(response: Response): Promise<JsonRecord[]> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await response.json()) as JsonRecord | JsonRecord[];
    return Array.isArray(body) ? body : [body];
  }

  const text = await response.text();
  return text.split(/\n\n+/).flatMap((event) =>
    event
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as JsonRecord)
  );
}

async function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  token = 'opfo_valid',
  mcpSessionId?: string
) {
  const response = await createApp().request('/api/mcp', {
    method: 'POST',
    headers: mcpHeaders(token, mcpSessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const messages = await parseMcpMessages(response);
  const body = messages.find((message) => message.id === 1) ?? messages.at(-1);
  if (!body) throw new Error('MCP response did not contain a JSON-RPC result');
  return {
    response,
    body,
    messages,
  };
}

beforeEach(() => {
  registerMcpSettings(true);
  registerOAuth();
});

afterEach(() => {
  resetMcpDiscoveryStateForTests();
  container.reset();
});

describe('MCP route authentication', () => {
  it('rejects requests when the MCP server is disabled', async () => {
    registerMcpSettings(false);

    const response = await createApp().request('/api/mcp', {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: 'MCP server is disabled' });
  });

  it('rejects missing auth', async () => {
    const response = await createApp().request('/api/mcp', { method: 'POST' });
    const challenge = response.headers.get('WWW-Authenticate');

    expect(response.status).toBe(401);
    expect(challenge).toContain('resource_metadata=');
    expect(challenge).not.toContain('scope="mcp:use"');
  });

  it('rejects cookie-only auth', async () => {
    const response = await createApp().request('/api/mcp', {
      method: 'POST',
      headers: { Cookie: 'opfield_session=session-1' },
    });

    expect(response.status).toBe(401);
  });

  it('rejects invalid Opfield tokens', async () => {
    registerToken(null);

    const response = await createApp().request('/api/mcp', {
      method: 'POST',
      headers: mcpHeaders('opf_invalid'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
  });

  it('rejects logging ingest tokens', async () => {
    const response = await createApp().request('/api/mcp', {
      method: 'POST',
      headers: mcpHeaders('opfl_ingest'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
  });

  it('rejects legacy logging ingest tokens', async () => {
    const response = await createApp().request('/api/mcp', {
      method: 'POST',
      headers: mcpHeaders('gwl_ingest'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
  });

  it('accepts OAuth access tokens issued before the opfo_ prefix', async () => {
    registerOAuth(['nodes:details']);

    const { response } = await mcpRequest('tools/list', {}, 'gwo_valid');

    expect(response.status).toBe(200);
  });

  it('rejects valid tokens with no effective scopes', async () => {
    registerToken([]);

    const response = await createApp().request('/api/mcp', {
      method: 'POST',
      headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(403);
  });

  it('rejects Opfield API tokens for MCP', async () => {
    registerToken(['nodes:details']);

    const { response } = await mcpRequest('tools/list', {}, 'opf_valid');

    expect(response.status).toBe(401);
  });

  it('allows OAuth access tokens without mcp:use when the user can use MCP', async () => {
    registerOAuth(['nodes:details']);

    const { response, body } = await mcpRequest('tools/list', {}, 'opfo_valid');

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeTruthy();
    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('list_nodes');
  });

  it('reports the Opfield release as the server version and says what Opfield is', async () => {
    registerOAuth(['nodes:details']);

    const { body } = await mcpRequest('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    expect(body.result.serverInfo).toMatchObject({ name: 'opfield', version: '2.11.0-rc.39' });
    expect(body.result.instructions).toContain('self-hosted infrastructure control plane for a fleet of nodes');
    expect(body.result.instructions).toContain('It is not another Docker panel for one host.');
  });

  it('rejects API-resource OAuth access tokens for MCP', async () => {
    const validateAccessToken = vi.fn().mockResolvedValueOnce(null);
    container.registerInstance(OAuthService, {
      getMcpResourceUrl: vi.fn().mockReturnValue('https://opfield.example.com/api/mcp'),
      getApiResourceUrl: vi.fn().mockReturnValue('https://opfield.example.com/api'),
      getProtectedResourceMetadataUrl: vi
        .fn()
        .mockReturnValue('https://opfield.example.com/.well-known/oauth-protected-resource/api/mcp'),
      validateAccessToken,
    } as unknown as OAuthService);

    const { response } = await mcpRequest('tools/list', {}, 'opfo_valid');

    expect(response.status).toBe(401);
    expect(validateAccessToken).toHaveBeenCalledTimes(1);
    expect(validateAccessToken).toHaveBeenCalledWith('opfo_valid', {
      resource: 'https://opfield.example.com/api/mcp',
    });
  });

  it('rejects OAuth access tokens when the user cannot use MCP', async () => {
    registerOAuth(['nodes:details'], { ...USER, scopes: ['nodes:details'] });

    const response = await createApp().request('/api/mcp', {
      method: 'POST',
      headers: mcpHeaders('opfo_valid'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toContain('insufficient_scope');
  });

  it('rejects API tokens without checking user MCP capability', async () => {
    registerToken(['nodes:details'], { ...USER, scopes: ['nodes:details'] });

    const response = await createApp().request('/api/mcp', {
      method: 'POST',
      headers: mcpHeaders('opf_valid'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'MCP accepts only Opfield OAuth access tokens' });
  });

  it('returns JSON-RPC method-not-allowed for GET in stateless mode', async () => {
    registerToken(['nodes:details']);

    const response = await createApp().request('/api/mcp', {
      method: 'GET',
      headers: mcpHeaders(),
    });
    const body = (await response.json()) as JsonRecord;

    expect(response.status).toBe(405);
    expect(body.error.code).toBe(-32601);
  });
});

describe('MCP tools', () => {
  it('discovers and calls GitLab tools through delegated GitLab scopes but never the sandbox clone', async () => {
    registerToken([
      'integrations:gitlab:view',
      'integrations:gitlab:repo:read',
      'integrations:gitlab:repo:write',
      'integrations:gitlab:sandbox:clone',
    ]);
    const executeTool = vi.fn().mockResolvedValue({ result: { projects: [] }, invalidateStores: [] });
    container.registerInstance(AIService, { executeTool } as unknown as AIService);
    container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService);

    const initial = await mcpRequest('tools/list');
    expect(initial.body.result.tools.map((tool: { name: string }) => tool.name)).not.toContain('gitlab_list_projects');

    await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category: 'gitlab' } });
    const list = await mcpRequest('tools/list');
    const names = list.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['gitlab_list_projects', 'gitlab_commit_files']));
    expect(names).not.toContain('gitlab_clone_repository_to_sandbox');

    const call = await mcpRequest('tools/call', {
      name: 'gitlab_list_projects',
      arguments: { connectorId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(call.body.result.isError).not.toBe(true);
    expect(executeTool).toHaveBeenCalledWith(
      USER,
      'gitlab_list_projects',
      expect.objectContaining({ connectorId: '11111111-1111-4111-8111-111111111111' }),
      expect.objectContaining({ source: 'mcp' })
    );

    const clone = await mcpRequest('tools/call', {
      name: 'gitlab_clone_repository_to_sandbox',
      arguments: { connectorId: '11111111-1111-4111-8111-111111111111', project: 'group/app' },
    });
    expect(JSON.stringify(clone.body)).toContain('unavailable');
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('discovers newly delegable management toolsets', async () => {
    registerToken([
      'nodes:config:view',
      'nodes:files:read',
      'docker:containers:migrate',
      'settings:opfield:view',
      'inference:providers:view',
      'integrations:ssh:use',
      'integrations:github:repo:read',
      'integrations:git:repo:read',
      'integrations:cloudflare:manage',
      'integrations:hosting:view',
      'admin:details:certificates',
    ]);

    for (const category of [
      'nodes',
      'docker',
      'logging',
      'inference',
      'external_ssh',
      'github',
      'git',
      'hosting',
      'integrations',
      'certificates',
    ]) {
      const discovered = await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category } });
      expect(discovered.body.result.isError, category).not.toBe(true);
    }
    const refreshed = await mcpRequest('tools/list');
    const names = refreshed.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'manage_node_config',
        'manage_node_file',
        'manage_docker_migration',
        'manage_logging_backend',
        'manage_inference_provider',
        'ssh_execute_command',
        'github_list_repositories',
        'git_read_repository_file',
        'create_cloudflare_connector',
        'manage_hosting',
        'audit_system_pki_leaves',
      ])
    );
  });

  it('lists only scoped Opfield tools and excludes AI-only tools', async () => {
    registerToken(['nodes:details']);

    const { response, body } = await mcpRequest('tools/list');

    expect(response.status).toBe(200);
    const names = body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('list_nodes');
    expect(names).not.toContain('create_node');
    expect(names).not.toContain('ask_question');
    expect(names).not.toContain('get_current_context');
    expect(names).not.toContain('end_conversation');
    expect(names).not.toContain('search_chats');
    expect(names).not.toContain('find_in_chat');
    expect(names).not.toContain('read_chat_slice');
    expect(names).not.toContain('list_projects');
    expect(names).not.toContain('list_chat_projects');
    expect(names).not.toContain('internal_documentation');
    expect(names).toContain('read_opfield_documentation');
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('wait');
    expect(names).not.toContain('send_comment');
    expect(names).not.toContain('gitlab_clone_repository_to_sandbox');
    expect(names).not.toContain('list_artifact_files');
    expect(names).not.toContain('manage_ai_conversation');
    expect(names).not.toContain('manage_oauth_authorization');
  });

  it('does not execute assistant-only coordination tools through MCP', async () => {
    registerOAuth(['feat:ai:use']);
    const executeTool = vi.fn();
    container.registerInstance(AIService, { executeTool } as unknown as AIService);
    container.registerInstance(AuditService, { log: vi.fn() } as unknown as AuditService);

    const wait = await mcpRequest('tools/call', {
      name: 'wait',
      arguments: { seconds: 1, reason: 'poll' },
    });
    const comment = await mcpRequest('tools/call', {
      name: 'send_comment',
      arguments: { message: 'Still checking.' },
    });

    expect(wait.body.result.isError).toBe(true);
    expect(JSON.stringify(wait.body)).toContain('unavailable');
    expect(comment.body.result.isError).toBe(true);
    expect(JSON.stringify(comment.body)).toContain('unavailable');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not call tools hidden by effective token scopes', async () => {
    registerToken(['nodes:details']);
    const executeTool = vi.fn();
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AIService, { executeTool } as unknown as AIService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const { body } = await mcpRequest('tools/call', {
      name: 'create_node',
      arguments: { hostname: 'node-1', enrollmentToken: 'secret-token' },
    });

    expect(body.result.isError).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER.id,
        action: 'mcp.create_node',
        resourceType: 'nodes',
        details: expect.objectContaining({
          source: 'mcp',
          success: false,
          denied: true,
          reason: 'missing_scope',
          tokenId: 'oauth-token-1',
          tokenPrefix: 'opfo_abc123',
          toolName: 'create_node',
          requiredScope: 'nodes:create',
          arguments: { hostname: 'node-1', enrollmentToken: '[REDACTED]' },
        }),
      })
    );
  });

  it('redacts Pages artifact bytes when a scoped MCP call is denied', async () => {
    registerToken(['pages:view:project-1']);
    const executeTool = vi.fn();
    const auditLog = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AIService, { executeTool } as unknown as AIService);
    container.registerInstance(AuditService, { log: auditLog } as unknown as AuditService);

    const { body } = await mcpRequest('tools/call', {
      name: 'upload_pages_artifact',
      arguments: {
        operation: 'chunk',
        uploadId: 'upload-1',
        offset: 0,
        contentBase64: 'c2Vuc2l0aXZlLWFydGlmYWN0LWJ5dGVz',
      },
    });

    expect(body.result.isError).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.upload_pages_artifact',
        details: expect.objectContaining({
          denied: true,
          reason: 'missing_scope',
          arguments: {
            operation: 'chunk',
            uploadId: 'upload-1',
            offset: 0,
            contentBase64: '[REDACTED]',
          },
        }),
      })
    );
  });

  it('redacts S3 upload bytes from denied MCP audit records', async () => {
    registerToken(['storage:objects:read']);
    const executeTool = vi.fn();
    const log = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AIService, { executeTool } as unknown as AIService);
    container.registerInstance(AuditService, { log } as unknown as AuditService);
    const { body } = await mcpRequest('tools/call', {
      name: 'upload_storage_object',
      arguments: {
        operation: 'chunk',
        storageId: 'storage-1',
        uploadId: 'upload-1',
        offset: 0,
        contentBase64: 'c2VjcmV0',
      },
    });
    expect(body.result.isError).toBe(true);
    expect(executeTool).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          arguments: expect.objectContaining({ contentBase64: '[REDACTED]' }),
        }),
      })
    );
  });

  it('applies per-tool secret redaction to denied MCP audit records', async () => {
    registerToken(['nodes:details']);
    const executeTool = vi.fn();
    const log = vi.fn().mockResolvedValue(undefined);
    container.registerInstance(AIService, { executeTool } as unknown as AIService);
    container.registerInstance(AuditService, { log } as unknown as AuditService);

    await mcpRequest('tools/call', {
      name: 'github_upsert_actions_secret',
      arguments: {
        connectorId: 'connector-1',
        repositoryUrl: 'https://github.com/acme/app',
        name: 'DEPLOY_KEY',
        value: 'raw-actions-secret',
      },
    });
    await mcpRequest('tools/call', {
      name: 'create_webhook',
      arguments: {
        name: 'Slack',
        url: 'https://hooks.slack.com/services/T000/B000/raw-slack-token',
        headers: { 'X-Custom': 'raw-header-secret' },
      },
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.github_upsert_actions_secret',
        details: expect.objectContaining({
          denied: true,
          arguments: expect.objectContaining({ name: 'DEPLOY_KEY', value: '[REDACTED]' }),
        }),
      })
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp.create_webhook',
        details: expect.objectContaining({
          denied: true,
          arguments: expect.objectContaining({
            url: 'https://hooks.slack.com/********',
            headers: { 'X-Custom': '********' },
          }),
        }),
      })
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/raw-(?:actions-secret|slack-token|header-secret)/);
  });

  it('passes effective token scopes and token metadata to AI tool execution', async () => {
    registerToken(['nodes:details']);
    const executeTool = vi.fn().mockResolvedValue({ result: { data: [] }, invalidateStores: [] });
    container.registerInstance(AIService, { executeTool } as unknown as AIService);

    const { body } = await mcpRequest('tools/call', {
      name: 'list_nodes',
      arguments: { limit: 5 },
    });

    expect(body.result.content[0].text).toBe(JSON.stringify({ data: [] }));
    expect(executeTool).toHaveBeenCalledWith(
      USER,
      'list_nodes',
      { limit: 5 },
      {
        source: 'mcp',
        scopes: ['nodes:details'],
        tokenId: 'oauth-token-1',
        tokenPrefix: 'opfo_abc123',
        authType: 'oauth',
        clientId: 'goc_client',
      }
    );
  });

  it('uses corrected granular scopes when listing template and access-list tools', async () => {
    registerToken(['pki:templates:create', 'pki:templates:delete', 'acl:create']);

    await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category: 'certificates' } });
    await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category: 'proxy' } });
    const { body } = await mcpRequest('tools/list');
    const names = body.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).toContain('create_template');
    expect(names).toContain('delete_template');
    expect(names).toContain('create_access_list');
  });

  it('lists and calls resource-scoped proxy mutation tools for matching resources only', async () => {
    registerToken(['proxy:edit:host-1']);
    const executeTool = vi.fn().mockResolvedValue({ result: { id: 'host-1' }, invalidateStores: [] });
    container.registerInstance(AIService, { executeTool } as unknown as AIService);

    await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category: 'proxy' } });
    const list = await mcpRequest('tools/list');
    const names = list.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('update_route');

    const allowed = await mcpRequest('tools/call', {
      name: 'update_route',
      arguments: { routeId: 'host-1', enabled: false },
    });
    expect(allowed.body.result.isError).not.toBe(true);
    expect(executeTool).toHaveBeenCalledWith(
      USER,
      'update_route',
      { routeId: 'host-1', enabled: false },
      expect.objectContaining({ scopes: ['proxy:edit:host-1'] })
    );

    executeTool.mockClear();
    container.registerInstance(AuditService, { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService);
    const denied = await mcpRequest('tools/call', {
      name: 'update_route',
      arguments: { routeId: 'host-2', enabled: false },
    });
    expect(JSON.stringify(denied.body)).toContain('unavailable');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not expose rendered nginx config with ordinary proxy view scope', async () => {
    registerToken(['proxy:view']);

    const { body } = await mcpRequest('tools/list');
    const names = body.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).not.toContain('get_route_rendered_config');
  });

  it('lists blue/green deployment tools under Docker container scopes', async () => {
    registerToken(['docker:containers:view', 'docker:containers:view', 'docker:containers:manage']);

    await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category: 'docker' } });
    const { body } = await mcpRequest('tools/list');
    const names = body.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).toContain('list_docker_deployments');
    expect(names).toContain('get_docker_deployment');
    expect(names).toContain('start_docker_deployment');
    expect(names).toContain('stop_docker_deployment');
    expect(names).toContain('restart_docker_deployment');
    expect(names).toContain('kill_docker_deployment');
    expect(names).toContain('deploy_docker_deployment');
    expect(names).toContain('switch_docker_deployment_slot');
    expect(names).toContain('rollback_docker_deployment');
    expect(names).toContain('stop_docker_deployment_slot');
  });

  it('keeps specialized MCP tools hidden until their toolset is discovered', async () => {
    registerToken(['docker:containers:view', 'docker:containers:manage']);

    const initial = await mcpRequest('tools/list');
    let names = initial.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('discover_tools');
    expect(names).toContain('find_resource');
    expect(names).not.toContain('list_docker_deployments');

    const discovered = await mcpRequest('tools/call', {
      name: 'discover_tools',
      arguments: { category: 'docker' },
    });
    expect(discovered.body.result.isError).not.toBe(true);
    expect(JSON.parse(discovered.body.result.content[0].text).activeToolsets).toContain('docker');

    const refreshed = await mcpRequest('tools/list');
    names = refreshed.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('list_docker_deployments');
  });

  it('discovers Pages, storage, and managed database lifecycle tools by domain', async () => {
    registerToken(['pages:view', 'pages:deploy', 'databases:view', 'storage:view']);

    await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category: 'pages' } });
    await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category: 'databases' } });
    await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category: 'storage' } });

    const refreshed = await mcpRequest('tools/list');
    const names = refreshed.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('manage_pages');
    expect(names).toContain('upload_pages_artifact');
    expect(names).toContain('manage_managed_database');
    expect(names).toContain('manage_managed_storage');
  });

  it('emits tools/list_changed after activating a toolset', async () => {
    registerToken(['docker:containers:view', 'docker:containers:manage']);

    const discovered = await mcpRequest('tools/call', {
      name: 'discover_tools',
      arguments: { category: 'docker' },
    });

    expect(discovered.response.headers.get('content-type')).toContain('text/event-stream');
    expect(discovered.messages).toContainEqual({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    });
    expect(discovered.body.result.isError).not.toBe(true);
  });

  it('eagerly lists all scoped tools when extended compatibility is enabled', async () => {
    registerMcpSettings(true, true);
    registerToken([...ALL_SCOPES]);

    const { body } = await mcpRequest('tools/list');
    const names = body.result.tools.map((tool: { name: string }) => tool.name);

    expect(body.result.tools.length).toBeGreaterThan(80);
    expect(body.result.nextCursor).toBeUndefined();
    expect(names).not.toContain('discover_tools');
    expect(names).toContain('list_docker_deployments');
    expect(names).toContain('restart_docker_container');
    expect(names).toContain('manage_docker_container_config');
  });

  it('keeps tools/list pagination in discovery mode', async () => {
    registerToken([...ALL_SCOPES]);

    const initialList = await mcpRequest('tools/list');
    const sessionId = initialList.response.headers.get('mcp-session-id') ?? undefined;
    for (const category of [
      'folders',
      'nodes',
      'proxy',
      'certificates',
      'docker',
      'databases',
      'storage',
      'logging',
      'status_page',
      'notifications',
      'administration',
      'maintenance',
      'ai_assistant',
    ]) {
      await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category } }, 'opfo_valid', sessionId);
    }

    const firstPage = await mcpRequest('tools/list', {}, 'opfo_valid', sessionId);
    const firstPageNames = firstPage.body.result.tools.map((tool: { name: string }) => tool.name);
    const secondPage = await mcpRequest(
      'tools/list',
      { cursor: firstPage.body.result.nextCursor },
      'opfo_valid',
      sessionId
    );
    const secondPageNames = secondPage.body.result.tools.map((tool: { name: string }) => tool.name);

    expect(firstPage.body.result.tools).toHaveLength(80);
    expect(firstPage.body.result.nextCursor).toBe('80');
    expect(firstPageNames).toContain('discover_tools');
    expect(secondPageNames).toContain('manage_docker_container_config');
  });

  it('keeps newly discovered notification tools visible on the first tools/list page', async () => {
    registerToken([
      'acl:view',
      'admin:users',
      'admin:groups',
      'databases:view',
      'docker:containers:view',
      'docker:containers:manage',
      'domains:view',
      'logs:environments:view',
      'nodes:details',
      'notifications:alerts:view',
      'notifications:webhooks:view',
      'pki:ca:view',
      'pki:cert:view',
      'pki:templates:view',
      'proxy:view',
      'ssl:cert:view',
      'status-page:view',
    ]);

    for (const category of [
      'folders',
      'nodes',
      'proxy',
      'certificates',
      'docker',
      'databases',
      'logging',
      'status_page',
      'administration',
    ]) {
      await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category } });
    }
    const discovered = await mcpRequest('tools/call', {
      name: 'discover_tools',
      arguments: { category: 'notifications' },
    });
    const payload = JSON.parse(discovered.body.result.content[0].text);
    expect(payload.activeToolsets).toEqual(expect.arrayContaining(['administration', 'notifications']));
    expect(
      payload.toolsets.find((toolset: { id: string; tools: string[] }) => toolset.id === 'notifications')?.tools
    ).toContain('list_alert_rules');

    const refreshed = await mcpRequest('tools/list');
    const names = refreshed.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('list_alert_rules');
    expect(names).toContain('list_webhook_deliveries');
    // What is alerting now and the alert history (X-O-19).
    expect(names).toContain('list_alerts');
  });

  it('isolates discovered toolsets by MCP session id when the client echoes the session header', async () => {
    registerToken(['docker:containers:view', 'docker:containers:manage']);

    const firstSessionList = await mcpRequest('tools/list');
    const secondSessionList = await mcpRequest('tools/list');
    const firstSessionId = firstSessionList.response.headers.get('mcp-session-id');
    const secondSessionId = secondSessionList.response.headers.get('mcp-session-id');
    expect(firstSessionId).toBeTruthy();
    expect(secondSessionId).toBeTruthy();
    expect(firstSessionId).not.toBe(secondSessionId);

    await mcpRequest(
      'tools/call',
      {
        name: 'discover_tools',
        arguments: { category: 'docker' },
      },
      'opfo_valid',
      firstSessionId ?? undefined
    );

    const firstRefreshed = await mcpRequest('tools/list', {}, 'opfo_valid', firstSessionId ?? undefined);
    const secondRefreshed = await mcpRequest('tools/list', {}, 'opfo_valid', secondSessionId ?? undefined);
    const firstNames = firstRefreshed.body.result.tools.map((tool: { name: string }) => tool.name);
    const secondNames = secondRefreshed.body.result.tools.map((tool: { name: string }) => tool.name);

    expect(firstNames).toContain('list_docker_deployments');
    expect(secondNames).not.toContain('list_docker_deployments');
  });

  it('does not share discovered toolsets across OAuth clients', async () => {
    registerOAuth(['docker:containers:view', 'docker:containers:manage'], USER, 'first_client');
    await mcpRequest('tools/call', { name: 'discover_tools', arguments: { category: 'docker' } });

    registerOAuth(['docker:containers:view', 'docker:containers:manage'], USER, 'second_client');
    const secondClientList = await mcpRequest('tools/list');
    const secondClientNames = secondClientList.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(secondClientNames).not.toContain('list_docker_deployments');

    registerOAuth(['docker:containers:view', 'docker:containers:manage'], USER, 'first_client');
    const firstClientList = await mcpRequest('tools/list');
    const firstClientNames = firstClientList.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(firstClientNames).toContain('list_docker_deployments');
  });

  it('carries no-header discovery state into the session id issued on that response', async () => {
    registerToken(['docker:containers:view', 'docker:containers:manage']);

    const discovered = await mcpRequest('tools/call', {
      name: 'discover_tools',
      arguments: { category: 'docker' },
    });
    const issuedSessionId = discovered.response.headers.get('mcp-session-id');
    expect(issuedSessionId).toBeTruthy();

    const refreshed = await mcpRequest('tools/list', {}, 'opfo_valid', issuedSessionId ?? undefined);
    const names = refreshed.body.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).toContain('list_docker_deployments');
  });

  it('does not share no-header discovery mutations with an already issued MCP session', async () => {
    registerToken(['docker:containers:view', 'docker:containers:manage', 'proxy:edit:host-1']);

    const discovered = await mcpRequest('tools/call', {
      name: 'discover_tools',
      arguments: { category: 'docker' },
    });
    const issuedSessionId = discovered.response.headers.get('mcp-session-id');
    expect(issuedSessionId).toBeTruthy();

    await mcpRequest('tools/call', {
      name: 'discover_tools',
      arguments: { category: 'proxy' },
    });

    const sessionList = await mcpRequest('tools/list', {}, 'opfo_valid', issuedSessionId ?? undefined);
    const names = sessionList.body.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).toContain('list_docker_deployments');
    expect(names).not.toContain('update_route');
  });

  it('ignores arbitrary MCP session ids that were not issued for the token/client', async () => {
    registerToken(['docker:containers:view', 'docker:containers:manage']);

    const discovered = await mcpRequest(
      'tools/call',
      {
        name: 'discover_tools',
        arguments: { category: 'docker' },
      },
      'opfo_valid',
      'client-picked-session'
    );
    const issuedSessionId = discovered.response.headers.get('mcp-session-id');
    expect(issuedSessionId).toBeTruthy();
    expect(issuedSessionId).not.toBe('client-picked-session');

    const arbitraryList = await mcpRequest('tools/list', {}, 'opfo_valid', 'client-picked-session');
    const names = arbitraryList.body.result.tools.map((tool: { name: string }) => tool.name);

    expect(names).not.toContain('list_docker_deployments');
  });
});

describe('MCP resources and prompts', () => {
  it('lists resources filtered by token scopes', async () => {
    registerToken(['nodes:details']);

    const { body } = await mcpRequest('resources/list');
    const uris = body.result.resources.map((resource: { uri: string }) => resource.uri);

    expect(uris).toContain('opfield://overview');
    expect(uris).toContain('opfield://nodes');
    expect(uris).toContain('opfield://docker/nodes');
    expect(uris).toContain('opfield://docs');
    expect(uris).toContain('opfield://docs/nodes');
    expect(uris).not.toContain('opfield://proxy/hosts');
    expect(uris).not.toContain('opfield://docs/proxy');
  });

  it('returns compact JSON resource content', async () => {
    registerToken(['nodes:details']);
    container.registerInstance(MonitoringService, {
      getDashboardStats: vi.fn().mockResolvedValue({
        proxyHosts: { total: 3 },
        sslCertificates: { total: 4 },
        pkiCertificates: { total: 5 },
        cas: { total: 6 },
        nodes: { total: 2, online: 1, offline: 1, pending: 0 },
      }),
    } as unknown as MonitoringService);

    const { body } = await mcpRequest('resources/read', {
      uri: 'opfield://overview',
    });

    expect(body.result.contents[0].mimeType).toBe('application/json');
    const data = JSON.parse(body.result.contents[0].text);
    expect(data.nodes).toEqual({ total: 2, online: 1, offline: 1, pending: 0 });
    expect(data.proxyHosts).toBeUndefined();
  });

  it('shows MCP overview CA stats only for broad CA view', async () => {
    registerToken(['pki:ca:view']);
    const getDashboardStats = vi.fn().mockResolvedValue({
      proxyHosts: { total: 3 },
      sslCertificates: { total: 4 },
      pkiCertificates: { total: 5 },
      cas: { total: 1, root: 0, intermediate: 1 },
      nodes: { total: 2, online: 1, offline: 1, pending: 0 },
    });
    container.registerInstance(MonitoringService, { getDashboardStats } as unknown as MonitoringService);

    const list = await mcpRequest('resources/list');
    const uris = list.body.result.resources.map((resource: { uri: string }) => resource.uri);
    expect(uris).toContain('opfield://overview');

    const { body } = await mcpRequest('resources/read', {
      uri: 'opfield://overview',
    });

    expect(getDashboardStats).toHaveBeenCalledWith(
      expect.objectContaining({ allowedCaTypes: ['root', 'intermediate'] })
    );
    const data = JSON.parse(body.result.contents[0].text);
    expect(data.cas).toEqual({ total: 1, root: 0, intermediate: 1 });
    expect(data.nodes).toBeUndefined();
  });

  it('returns an internal docs index filtered by token scopes', async () => {
    registerToken(['nodes:details']);

    const { body } = await mcpRequest('resources/read', {
      uri: 'opfield://docs',
    });

    const data = JSON.parse(body.result.contents[0].text);
    const topics = data.topics.map((entry: { topic: string }) => entry.topic);
    expect(topics).toContain('nodes');
    expect(topics).toContain('api');
    expect(topics).toContain('permissions');
    expect(topics).not.toContain('proxy');
  });

  it('returns scoped internal documentation as MCP resource content', async () => {
    registerToken(['nodes:details']);

    const { body } = await mcpRequest('resources/read', {
      uri: 'opfield://docs/nodes',
    });

    const data = JSON.parse(body.result.contents[0].text);
    expect(data.topic).toBe('nodes');
    expect(data.content).toContain('# Nodes');
  });

  it('exposes logging documentation through any logging read scope', async () => {
    registerToken(['logs:schemas:view']);

    const list = await mcpRequest('resources/list');
    const uris = list.body.result.resources.map((resource: { uri: string }) => resource.uri);
    expect(uris).toContain('opfield://docs/logging');

    const { body } = await mcpRequest('resources/read', {
      uri: 'opfield://docs/logging',
    });

    const data = JSON.parse(body.result.contents[0].text);
    expect(data.topic).toBe('logging');
    expect(data.content).toContain('manage_logging');
  });

  it('allows MCP callers to read MCP-safe docs that were AI-gated internally', async () => {
    registerToken(['nodes:details']);

    const { body } = await mcpRequest('resources/read', {
      uri: 'opfield://docs/api',
    });

    const data = JSON.parse(body.result.contents[0].text);
    expect(data.topic).toBe('api');
    expect(data.content).toContain('# Opfield REST API');
  });

  it('lists prompts filtered by token scopes', async () => {
    registerToken(['docker:containers:manage', 'docker:images:pull']);

    const { body } = await mcpRequest('prompts/list');
    const names = body.result.prompts.map((prompt: { name: string }) => prompt.name);

    expect(names).toContain('rollout-container-image');
    expect(names).not.toContain('provision-proxy-host');
  });

  it('exposes the managed database access prompt with the supported managed lifecycle tool', async () => {
    registerToken(['databases:view']);

    const { body } = await mcpRequest('prompts/list');
    const prompt = body.result.prompts.find((entry: { name: string }) => entry.name === 'plan-managed-database-access');

    expect(prompt).toMatchObject({
      name: 'plan-managed-database-access',
      title: 'Plan managed database access',
    });

    const result = await mcpRequest('prompts/get', { name: 'plan-managed-database-access', arguments: {} });
    const text = result.body.result.messages[0].content.text;
    expect(text).toContain('Use manage_managed_database');
    expect(text).toContain('poll get until ready');
  });
});
