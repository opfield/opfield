import { NODE_FILE_AI_TOOLS } from './ai.tools.node-files.js';
import type { AIToolDefinition } from './ai.types.js';

export const PLATFORM_AI_TOOLS: AIToolDefinition[] = [
  // ── Nodes ──
  {
    name: 'list_nodes',
    description:
      'List daemon nodes with their type, status, and connection info. type decides which tools accept a node and each row says so in usedFor: Docker tools (list_docker_*, manage_docker_*, containers, deployments, Compose) take only type docker nodes; routes and Pages take nginx nodes; managed databases and storage take storage (or legacy databases) nodes; builder, relay and monitoring nodes take none of them. Storage, databases and builder daemons report capabilities.daemonType "docker", which does not make them Docker nodes. Without nodes:details, pass type to discover destination nodes: type nginx for route or Pages creators, docker for Docker grants, databases or storage for database and storage creators; those results carry only the node summary.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by hostname' },
        type: {
          type: 'string',
          enum: ['nginx', 'monitoring', 'docker', 'builder', 'databases', 'storage', 'relay'],
          description: 'Filter by node type',
        },
        status: { type: 'string', enum: ['pending', 'online', 'offline'], description: 'Filter by status' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        limit: { type: 'number', description: 'Items per page (default: 50)' },
      },
    },
    destructive: false,
    category: 'Nodes',
    requiredScope: 'nodes:details',
    invalidateStores: [],
  },
  {
    name: 'get_node',
    description:
      'Get detailed information about a specific node including live health, stats, and system info; usedFor says which tools accept it (Docker tools take only type docker nodes).',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID' },
      },
      required: ['nodeId'],
    },
    destructive: false,
    category: 'Nodes',
    requiredScope: 'nodes:details',
    invalidateStores: [],
  },
  {
    name: 'execute_node_console_command',
    description:
      'Run a one-shot command on a node as root (or console.user), in the agent sandbox. Agents CAN repair the host: systemctl, journalctl, apt, editing config files, restarting services that are not containers, reading logs, disk, memory and network. Do not use the container runtime from the console: the sandbox covers the Docker/containerd/Podman sockets and the docker, ctr, nerdctl, podman, crictl and runc programs, so ordinary Docker use does not work there. Containers change through the Docker tools. Use command as argv, for example ["sh","-lc","systemctl restart nginx && journalctl -u nginx -n 20 --no-pager"]. Clearly dangerous commands are blocked; the call needs explicit user approval. Runtime use is refused before sending: MANAGED_RESOURCE_CONSOLE_FORBIDDEN for a change to an Opfield-managed object or a write under the daemon state (it names the object and the tool to use: manage_docker_container recreate, remove/stop/start/restart_docker_container, manage_docker_deployment, manage_docker_compose, manage_docker_volume, manage_docker_network), NODE_CONSOLE_RUNTIME_UNAVAILABLE otherwise (read containers with list_docker_containers, get_docker_container, get_docker_container_logs, get_docker_container_stats). The sandbox is an accident guard that stops ordinary Docker use from the agent console, not a security boundary against a determined root process: root can still reach the runtime by another path to its socket (for example through /proc) or create systemd units and cron jobs. Do not try; use the Docker tools for containers. NODE_CONSOLE_AGENT_SANDBOX_REQUIRED means the node daemon must be updated first. Disk and file checks of runtime paths (df, du, findmnt, ls, stat of /var/lib/docker or a socket) run normally. A command runs at most timeoutSeconds (default 30, up to 300); at the limit it is stopped with everything it started, and the result has timedOut: true with the output so far. Background processes end with the command. The result has stdout, stderr, exitCode and risky (true for risky patterns, Docker changes, runtime use, namespace tools such as nsenter, unix-socket clients, or code the command line does not show), also when the command fails (then error says why, for example a non-zero exit). On a node whose daemon does not run as root (an installer --user), the command runs as the daemon user instead: the result names it in runAs and says in limits what that limits (no root: package installs, service changes and system files fail; the container runtime stays out of reach).',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID' },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command argv to execute. Use ["sh","-lc","..."] for shell syntax.',
        },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: 300,
          description:
            'How long the command may run, in seconds (default 30, at most 300). Raise it for package installs and long diagnostics.',
        },
      },
      required: ['nodeId', 'command'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:console',
    invalidateStores: ['nodes'],
  },
  {
    name: 'create_node',
    description:
      'Register (enroll) a server that already exists as a daemon node, including Relay Pool relays, and generate an enrollment token. To create a new VM as a node at a hosting provider or on a Proxmox host, use manage_hosting provision instead. Relay nodes require serviceAddresses (addresses daemons use to reach the relay) and optionally servicePort; other types reject them. IMPORTANT: The response contains enrollmentToken, opfieldCertSha256 and installCommands — display the token and fingerprint, and give the user the installCommands entry (curl or wget) for the target the host can reach, unchanged: it downloads the installer of this Opfield release, checks its checksum and pins the matching daemon release. The token is one-time-use and cannot be retrieved again; use manage_node regenerate_enrollment_token for a node that has not enrolled yet.',
    parameters: {
      type: 'object',
      properties: {
        hostname: { type: 'string', description: 'Node hostname (e.g., "proxy-01.example.com")' },
        type: {
          type: 'string',
          enum: ['nginx', 'monitoring', 'docker', 'builder', 'databases', 'storage', 'relay'],
          description: 'Node type (default: nginx). databases is the legacy database-only profile; prefer storage.',
        },
        displayName: { type: 'string', description: 'Optional display name' },
        folderId: {
          type: ['string', 'null'],
          description: 'Optional node folder UUID; creation there needs nodes:create on the folder.',
        },
        serviceAddresses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relay nodes only: unique advertised IP addresses or hostnames (1-10).',
        },
        servicePort: { type: 'number', description: 'Relay nodes only: advertised service port.' },
      },
      required: ['hostname'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:create',
    invalidateStores: ['nodes'],
  },
  {
    name: 'rename_node',
    description: 'Update a node display name.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID' },
        displayName: { type: 'string', description: 'New display name' },
      },
      required: ['nodeId', 'displayName'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:rename',
    invalidateStores: ['nodes'],
  },
  {
    name: 'set_node_service_creation_lock',
    description:
      'Lock or unlock new service creation on an nginx, Docker or Build Worker node, for example before maintenance or decommissioning. Existing services keep running. A locked Build Worker takes no new builds (running builds finish); while every online Build Worker is locked, new builds are refused and queued builds wait.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID' },
        serviceCreationLocked: { type: 'boolean', description: 'True blocks new services; false allows them again' },
      },
      required: ['nodeId', 'serviceCreationLocked'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:lock',
    invalidateStores: ['nodes'],
  },
  {
    name: 'delete_node',
    description:
      'Delete a daemon node. The node must have no assigned ingress routes unless cascadeProxyHosts is true and the node is offline. Also revokes its mTLS certificate.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Node UUID to delete' },
        cascadeProxyHosts: {
          type: 'boolean',
          description: 'Also delete the ingress routes assigned to an offline node (the UI cascade option).',
        },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:delete',
    invalidateStores: ['nodes'],
  },
  {
    name: 'manage_node_config',
    description:
      'Read, update, or test the global nginx configuration on a node. Operations: read, update, test. read requires nodes:config:view:<nodeId>; update/test require nodes:manage:<nodeId>.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['read', 'update', 'test'],
          description: 'Node config operation to perform.',
        },
        nodeId: { type: 'string', description: 'Node UUID' },
        content: { type: 'string', description: 'Full nginx config content for update.' },
      },
      required: ['operation', 'nodeId'],
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:config:view',
    invalidateStores: ['nodes'],
  },
  ...NODE_FILE_AI_TOOLS,

  // ── Raw Config ──
  {
    name: 'get_route_rendered_config',
    description:
      'Get the rendered nginx configuration for an ingress route. Shows either the template-generated or raw config.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route UUID' },
      },
      required: ['routeId'],
    },
    destructive: false,
    category: 'Ingress',
    requiredScope: 'proxy:raw:read',
    invalidateStores: [],
  },
  {
    name: 'update_route_raw_config',
    description: 'Write raw nginx configuration for an ingress route. Raw mode must be enabled first.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route UUID' },
        rawConfig: { type: 'string', description: 'Raw nginx configuration content' },
      },
      required: ['routeId', 'rawConfig'],
    },
    destructive: true,
    category: 'Ingress',
    requiredScope: 'proxy:raw:write',
    invalidateStores: ['proxy'],
  },
  {
    name: 'toggle_route_raw_mode',
    description:
      'Enable or disable raw config mode on an ingress route. Once a raw config is saved (update_route_raw_config), it is used directly instead of the rendered template; until then the managed config keeps rendering. A Docker Route keeps its Secure Link in raw mode, so the raw config must keep its upstream opfield_secure_link_<route id with - replaced by _>. Disabling returns a Route of type raw to proxy and renders the managed config again.',
    parameters: {
      type: 'object',
      properties: {
        routeId: { type: 'string', description: 'Route UUID' },
        enabled: { type: 'boolean', description: 'true to enable raw mode, false to disable' },
      },
      required: ['routeId', 'enabled'],
    },
    destructive: true,
    category: 'Ingress',
    requiredScope: 'proxy:raw:write',
    invalidateStores: ['proxy'],
  },

  // ── Administration ──
  {
    name: 'list_users',
    description: 'List all users with their roles, email, and last login info.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: [],
  },
  {
    name: 'create_user',
    description:
      'Create (invite) a user before first login and assign permission groups. authMethod password or email_otp emails the onboarding link or code and requires verified SMTP. With the Opfield setting generalSettings.sendInvitationOnUserCreate on, the account invitation email is also sent (a send failure does not fail the creation; the returned invitationSentAt stays null and manage_user send_invitation can retry). You can only assign groups within your own effective scopes.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'User email address' },
        name: { type: 'string', description: 'Display name' },
        groupId: { type: 'string', description: 'Initial permission group UUID (or pass groupIds)' },
        groupIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Permission group UUIDs; the first is the primary group.',
        },
        authMethod: {
          type: 'string',
          enum: ['oidc', 'password', 'email_otp'],
          description: 'Sign-in method (default: oidc).',
        },
        folderId: { type: ['string', 'null'], description: 'Optional user folder UUID.' },
      },
      required: ['email', 'name'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'update_user_role',
    description:
      "Change a user's permission group membership. Pass groupId for a single group or groupIds to replace every membership. Use list_groups to see available groups.",
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
        groupId: { type: 'string', description: 'Permission group UUID to assign' },
        groupIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Complete replacement list of permission group UUIDs; the first is the primary group.',
        },
      },
      required: ['userId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'set_user_additional_permissions',
    description:
      "Replace a user's exact additional permissions. Use list_users first to inspect groupScopes, additionalScopes, and effective scopes. Pass an empty additionalScopes array to reset all user-specific permissions while keeping the user's permission group unchanged.",
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
        additionalScopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Complete replacement list of user-specific permission scopes; [] resets the override',
        },
      },
      required: ['userId', 'additionalScopes'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'set_user_blocked',
    description:
      'Block or unblock a user account. Cannot target yourself, the system user, or users whose scopes exceed yours. Returns the user with isBlocked and blockedBy (admin, or opfield_account when the Opfield account removed the access; that block lifts on the next sign-in with the Opfield account). Unblocking lifts either block; blocking a user blocked by the Opfield account makes it an administrator block.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
        blocked: { type: 'boolean', description: 'true to block, false to unblock' },
      },
      required: ['userId', 'blocked'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  {
    name: 'delete_user',
    description:
      'Soft-delete a user account and revoke access. Cannot target yourself, the system user, or users whose scopes exceed yours. Restoration is available only to system administrators through the Administration UI/API.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User UUID' },
      },
      required: ['userId'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },

  // ── AI Assistant Configuration ──
  {
    name: 'get_ai_settings',
    description:
      'Read AI Workspace configuration, including provider, limits, disabled tools, web search, and sandbox runner settings. Secrets are returned only as masked metadata.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'AI Workspace',
    requiredScope: 'feat:ai:configure',
    invalidateStores: [],
  },
  {
    name: 'update_ai_settings',
    description:
      'Update AI Workspace configuration. Only pass fields that should change; API keys may be replaced or cleared with an empty string.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Enable or disable AI Workspace.' },
        providerType: {
          type: 'string',
          enum: ['openai_compatible', 'opfield_inference'],
          description: 'Assistant response provider.',
        },
        providerUrl: { type: 'string', description: 'OpenAI-compatible provider base URL.' },
        endpointMode: {
          type: 'string',
          enum: ['auto', 'chat_completions', 'responses'],
          description: 'Provider endpoint family.',
        },
        apiKey: { type: 'string', description: 'Provider API key. Empty string clears the saved key.' },
        model: { type: 'string', description: 'Model name.' },
        opfieldInferenceModel: {
          type: 'string',
          description: 'Default published Opfield Inference model ID.',
        },
        opfieldInferenceAllowUserModelSelection: {
          type: 'boolean',
          description: 'Allow users to select another accessible Opfield Inference model.',
        },
        allowUserReasoningEffortSelection: {
          type: 'boolean',
          description: 'Allow users to override the default reasoning effort for the OpenAI-compatible provider.',
        },
        customSystemPrompt: { type: 'string', description: 'Additional system prompt instructions.' },
        rateLimitMax: { type: 'number', description: 'Maximum assistant requests per window.' },
        rateLimitWindowSeconds: { type: 'number', description: 'Rate limit window in seconds.' },
        maxToolRounds: { type: 'number', description: 'Maximum sequential tool calls per assistant response.' },
        maxContextTokens: { type: 'number', description: 'Context token budget.' },
        maxCompletionTokens: { type: 'number', description: 'Maximum generated response tokens.' },
        maxTokensField: {
          type: 'string',
          enum: ['max_tokens', 'max_completion_tokens'],
          description: 'Provider request token field.',
        },
        reasoningEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'none'],
          description: 'Reasoning effort setting.',
        },
        disabledTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tool names disabled for the assistant.',
        },
        webSearchProvider: {
          type: 'string',
          enum: ['tavily', 'brave', 'serper', 'searxng', 'exa'],
          description: 'Web search provider.',
        },
        webSearchBaseUrl: { type: 'string', description: 'Web search provider base URL, used by SearXNG.' },
        webSearchApiKey: { type: 'string', description: 'Web search API key. Empty string clears the saved key.' },
        sandboxEnabled: { type: 'boolean', description: 'Expose sandbox execution tools to the assistant.' },
        sandboxDefaultTier: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Default sandbox resource tier.',
        },
      },
    },
    destructive: true,
    category: 'AI Workspace',
    requiredScope: 'feat:ai:configure',
    invalidateStores: ['settings'],
  },
  {
    name: 'list_ai_tools',
    description:
      'List AI Workspace tools with categories, descriptions, scopes, and destructive metadata for configuration or auditing.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'AI Workspace',
    requiredScope: 'feat:ai:configure',
    invalidateStores: [],
  },
  {
    name: 'get_sandbox_runtime_status',
    description:
      'Read sandbox runner configuration and runtime health without starting a sandbox job. Use this to diagnose whether sandbox execution is enabled and available.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'AI Workspace',
    requiredScope: 'feat:ai:configure',
    invalidateStores: [],
  },
  {
    name: 'manage_ai_conversation',
    description:
      'Manage the current user AI conversations. Operations: list, get, delete, delete_by_title. This tool never creates or rewrites conversation history.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'get', 'delete', 'delete_by_title'],
          description: 'Conversation operation to perform.',
        },
        conversationId: { type: 'string', description: 'Conversation UUID for get or delete.' },
        title: { type: 'string', description: 'Conversation title for delete_by_title.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Conversations',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'manage_oauth_authorization',
    description:
      'Manage existing OAuth authorizations for the current user. Each authorization is one consent with its own scopes, expiry and allowed addresses; the same client can have several. Operations: list, update (scopes, expiresAt, allowedIps; omitted fields stay), update_scopes, revoke (by the id from list). Pending browser consent is intentionally not exposed.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'update', 'update_scopes', 'revoke'],
          description: 'OAuth authorization operation to perform.',
        },
        authorizationId: {
          type: 'string',
          description: 'Authorization id from list, for update, update_scopes or revoke.',
        },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replacement delegated scopes for update or update_scopes.',
        },
        expiresAt: {
          type: ['string', 'null'],
          description:
            'For update: when every token of the authorization stops working (ISO 8601 date-time in the future); null removes the limit.',
        },
        allowedIps: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For update: up to 20 IPv4/IPv6 addresses or CIDR ranges the authorization works from; [] allows any address.',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'OAuth',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'manage_api_token',
    description:
      'Manage Opfield API tokens for the current browser user. Operations: list, create, update, revoke. Token secrets are returned only on create.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'create', 'update', 'revoke'],
          description: 'API token operation to perform.',
        },
        tokenId: { type: 'string', description: 'Token UUID for update or revoke.' },
        name: { type: 'string', description: 'Token name for create or update.' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'API token scopes for create or update. Must be a subset of the current user scopes.',
        },
        registryAccess: {
          type: 'object',
          description:
            'Internal registry access for docker login with the token: pull and push each "all" or a list of exact repository names; omit an action to deny it, {} removes the access. Pull needs view access to a Docker workload or image, push edit or manage on a workload.',
        },
        expiresAt: {
          type: ['string', 'null'],
          description:
            'When the token stops working: an ISO 8601 date-time in the future, or null for no expiry (the default). An expired token is refused like a revoked one and removed by housekeeping after the Expired Tokens period.',
        },
        allowedIps: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Up to 20 IPv4/IPv6 addresses or CIDR ranges the token works from (for example "203.0.113.10", "10.0.0.0/8"); requests from other addresses are refused. [] allows any address (the default).',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Settings',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'never_full' },
  },
];
