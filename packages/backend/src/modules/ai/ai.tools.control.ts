import { INTERNAL_DOCS } from './ai.docs.js';
import type { AIToolDefinition } from './ai.types.js';

export const CONTROL_AI_TOOLS: AIToolDefinition[] = [
  // ── Maintenance and Control Plane ──
  {
    name: 'get_license_status',
    description: 'Read Gateway license status, tier, installation ID, expiry, grace state, and masked key metadata.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Maintenance',
    requiredScope: 'license:view',
    invalidateStores: [],
  },
  {
    name: 'manage_license',
    description:
      'Manage the Gateway license. operation must be one of activate, activate_module, check, or clear. activate requires licenseKey and then installs the licensed module; activate_module retries only the module installation.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['activate', 'activate_module', 'check', 'clear'],
          description: 'License operation to perform.',
        },
        licenseKey: { type: 'string', description: 'License key for activate.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Maintenance',
    requiredScope: 'license:manage',
    invalidateStores: ['settings'],
  },
  {
    name: 'get_cloud_status',
    description:
      'Read whether this Gateway is connected to a cloud account: not_connected, connected (account email, portal URL, connected since, socket online/connecting/reconnecting with the last error) or disconnected_by_account (when and why).',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Maintenance',
    requiredScope: 'license:view',
    invalidateStores: [],
  },
  {
    name: 'manage_cloud',
    description:
      "Connect this Gateway to a cloud account or disconnect it. operation must be connect or disconnect. connect requires code, the single-use CLD-XXXX-XXXX code from the installation's page in the cloud account (valid 10 minutes); connecting again replaces the previous connection. disconnect revokes the connection at the account and forgets it here; when the account cannot be reached it is forgotten here anyway and the result carries a warning.",
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['connect', 'disconnect'],
          description: 'Cloud operation to perform.',
        },
        code: { type: 'string', description: 'Connection code for connect, for example CLD-7K3M-Q9TX.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Maintenance',
    requiredScope: 'license:manage',
    invalidateStores: ['settings'],
  },
  {
    name: 'manage_housekeeping',
    description:
      'Read or manage housekeeping. operation: get_config, get_stats, get_history, update_config, or run. update_config requires config.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['get_config', 'get_stats', 'get_history', 'update_config', 'run'],
          description: 'Housekeeping operation to perform.',
        },
        config: {
          type: 'object',
          description:
            'Partial housekeeping config for update_config, validated like PUT /housekeeping/config (retention periods, cronExpression, enabled categories; operationHistory {enabled, retentionDays} prunes finished Docker tasks, builds, compose, availability and hosting operations; oauthCleanup {enabled} purges expired OAuth grants and client registrations that never completed an authorization).',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Maintenance',
    requiredScope: 'housekeeping:view',
    invalidateStores: ['settings'],
  },
  {
    name: 'manage_gateway_diagnostics',
    description:
      "Read the state of Gateway itself, the control plane (for managed nodes use get_node and manage_node). operation: snapshot (now: Gateway's host CPU, memory, load and data-volume disk, where host.cpuCount and host.cpuPercent cover the CPUs Gateway may use (kernelCpuCount is the kernel's count) and host.memoryScope says whether memory is the container cgroup limit (cgroup) or the kernel's view (kernel, as inside an LXC); the backend process memory, CPU and event-loop delay; Postgres and Redis reachability, latency, connection pool, size and long queries; the stack containers such as app, postgres, redis, relay and registry with state, health, restarts, CPU and memory; failing background jobs; API latency and 5xx), history (one-minute samples kept 48 hours: from/to as ISO or durations such as 6h or 1d, default the last 6 hours; metrics as dotted paths like host.cpuPercent, requests.p95Ms, postgres.poolWaiting or containers.postgres.memoryBytes, see availableMetrics; returns avg and max per step, stepMinutes defaults to at most 120 points), requests (per-route counts, p95 and 5xx over the last minutes, up to 60), jobs (every background job: last run, duration, last error, failures in a row), or logs (lines of one Gateway container, newest last: source app (default), update (the last Gateway update run), or a stack service such as postgres, redis, relay or registry; since/until as ISO or durations, default the last hour; level is the minimum (error, warn, info, debug); text, context and requestId filter app lines; limit up to 1000, default 200; needs diagnostics:logs).",
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['snapshot', 'history', 'requests', 'jobs', 'logs'],
          description: 'Diagnostics operation to perform.',
        },
        from: { type: 'string', description: 'history: start, ISO 8601 or a duration before now such as 6h.' },
        to: { type: 'string', description: 'history: end, ISO 8601 or a duration before now; default now.' },
        metrics: {
          type: 'array',
          items: { type: 'string' },
          description: 'history: dotted metric paths; default a compact overview set.',
        },
        stepMinutes: { type: 'number', description: 'history: minutes per point.' },
        minutes: { type: 'number', description: 'requests: how many recent minutes, 1 to 60 (default 15).' },
        source: {
          type: 'string',
          description: 'logs: app (default), update, or a stack service name such as postgres, redis, relay, registry.',
        },
        since: { type: 'string', description: 'logs: start, ISO 8601 or a duration before now such as 30m.' },
        until: { type: 'string', description: 'logs: end, ISO 8601 or a duration before now.' },
        level: {
          type: 'string',
          enum: ['error', 'warn', 'info', 'debug'],
          description: 'logs: minimum level.',
        },
        text: { type: 'string', description: 'logs: case-insensitive text to find.' },
        context: { type: 'string', description: 'logs: app component (the logger context), such as UpdateService.' },
        requestId: { type: 'string', description: 'logs: lines of one API request.' },
        limit: { type: 'number', description: 'logs: most lines to return, up to 1000 (default 200).' },
      },
      required: ['operation'],
    },
    destructive: false,
    category: 'Maintenance',
    requiredScope: 'diagnostics:view',
    invalidateStores: [],
  },
  {
    name: 'get_gateway_settings',
    description:
      'Read every Gateway settings section: sign-in methods, password policy and MFA grace, OIDC provisioning and provider, SMTP (secrets masked), logging backend, MCP server, web TLS transport, general settings (public URL, update channel, relay tuning, features), network security, outbound webhook policy, and environment settings with their defaults.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Maintenance',
    requiredScope: 'settings:gateway:view',
    invalidateStores: [],
  },
  {
    name: 'update_gateway_settings',
    description:
      'Update Gateway settings exactly like the Settings UI. Pass only fields to change. SMTP, the OIDC provider, the public URL, and relaxing OIDC verified-email enforcement require admin:system. smtp.testRecipient sends a test email; enabling password or email-code sign-in requires verified SMTP; enabling OIDC sign-in requires a configured provider. environmentSettings patches the environment (limits/timeouts) settings.',
    parameters: {
      type: 'object',
      properties: {
        oidcAutoCreateUsers: { type: 'boolean' },
        oidcDefaultGroupId: { type: 'string', description: 'Default permission group UUID for auto-created users.' },
        oidcRequireVerifiedEmail: { type: 'boolean' },
        oauthExtendedCallbackCompatibility: { type: 'boolean' },
        mfaExistingSessionGracePeriodDays: {
          type: 'number',
          description: 'Days (0-7) existing sessions may continue before newly required MFA is enforced.',
        },
        methods: {
          type: 'object',
          properties: {
            oidc: { type: 'boolean' },
            password: { type: 'boolean' },
            emailOtp: { type: 'boolean' },
            passkeyLogin: { type: 'boolean' },
          },
          additionalProperties: false,
          description: 'Enabled sign-in methods.',
        },
        passwordPolicy: {
          type: 'object',
          properties: {
            minLength: { type: 'number' },
            maxLength: { type: 'number' },
            requireUppercase: { type: 'boolean' },
            requireLowercase: { type: 'boolean' },
            requireDigit: { type: 'boolean' },
            requireSymbol: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        smtp: {
          type: 'object',
          properties: {
            host: { type: 'string' },
            port: { type: 'number' },
            tlsMode: { type: 'string', enum: ['starttls', 'tls'] },
            username: { type: 'string' },
            password: { type: 'string', description: 'Omit to keep the saved password.' },
            senderName: { type: 'string' },
            senderEmail: { type: 'string' },
            testRecipient: { type: 'string', description: 'Send a test email to this address after saving.' },
            testEmailKind: {
              type: 'string',
              enum: ['smtp_configuration', 'password_setup', 'password_reset', 'email_otp'],
            },
          },
          required: ['host', 'port', 'tlsMode', 'username', 'senderName', 'senderEmail'],
          additionalProperties: false,
          description: 'SMTP server used for sign-in emails. Requires admin:system unless unchanged.',
        },
        oidc: {
          type: 'object',
          properties: {
            issuer: { type: 'string' },
            clientId: { type: 'string' },
            clientSecret: { type: 'string', description: 'Omit to keep the saved client secret.' },
            redirectUri: { type: 'string' },
            scopes: { type: 'string' },
          },
          required: ['issuer', 'clientId', 'redirectUri'],
          additionalProperties: false,
          description: 'OIDC/SSO identity provider. Requires admin:system.',
        },
        logging: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['disabled', 'local', 'external'] },
            url: { type: 'string' },
            username: { type: 'string' },
            password: { type: 'string' },
            database: { type: 'string' },
            table: { type: 'string' },
            requestTimeoutMs: { type: 'number' },
          },
          required: ['mode'],
          additionalProperties: false,
          description: 'Structured-logging ClickHouse backend.',
        },
        webTlsEnabled: {
          type: 'boolean',
          description: 'Serve the web UI over TLS; changing it restarts the Gateway web runtime.',
        },
        mcpServerEnabled: { type: 'boolean' },
        mcpExtendedCompatibility: {
          type: 'boolean',
          description:
            'Return every OAuth-scoped MCP tool in the initial tools/list response. Enabled by default; disable only for harnesses that load every tool schema into context and exhaust it, because they may then be unable to use some Gateway tools.',
        },
        generalSettings: {
          type: 'object',
          description:
            'Partial general settings: publicUrl, updateChannel, hideExternalBranding, autoAssignCreatedResourcePermissions, sendInvitationOnUserCreate (email the account invitation to every created user; off by default), file limits, gatewayGrpcPublicTarget, gatewayGrpcLocalIp, relayAutoRecovery, relay tuning, shutdown deadlines, relayGrantTtlHours, relayPolicyLeaseHours (lifetime of the signed policy pushed to a relay, 1-168 hours, default 72), features.',
        },
        networkSecurity: { type: 'object' },
        outboundWebhookPolicy: { type: 'object' },
        environmentSettings: {
          type: 'object',
          description: 'Partial environment settings patch, validated like PATCH /settings/environment.',
        },
      },
      additionalProperties: false,
    },
    destructive: true,
    category: 'Maintenance',
    requiredScope: 'settings:gateway:edit',
    invalidateStores: ['settings'],
  },
  {
    name: 'manage_system_updates',
    description:
      'Read or manage Gateway, Relay Pool, and daemon updates. Operations: get_gateway_status, check_gateway, get_gateway_release_notes, list_gateway_release_notes (every release between the current and the available version), perform_gateway_update, proceed_gateway_update (stop waiting for running operations), acknowledge_gateway_update_failure, perform_relay_update, abandon_relay_update (end a stuck or paused Relay Pool update), list_daemon_updates, check_daemon_updates, update_daemon (waits up to 30 minutes for long tasks running on the node unless now is true). Mutating operations require explicit approval unless the user bypass mode allows it.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'get_gateway_status',
            'check_gateway',
            'get_gateway_release_notes',
            'list_gateway_release_notes',
            'perform_gateway_update',
            'proceed_gateway_update',
            'acknowledge_gateway_update_failure',
            'perform_relay_update',
            'abandon_relay_update',
            'list_daemon_updates',
            'check_daemon_updates',
            'update_daemon',
          ],
          description: 'System update operation to perform.',
        },
        version: {
          type: 'string',
          description: 'Version for get_gateway_release_notes, perform_gateway_update, or perform_relay_update.',
        },
        nodeId: { type: 'string', description: 'Daemon node UUID for update_daemon.' },
        now: {
          type: 'boolean',
          description:
            'update_daemon: update without waiting for the long tasks running on the node (backups, image builds, Docker migrations, image pulls, container actions, storage copies, container archive transfers); they may fail. Also ends the wait of an update that already waits for them. Only after the user confirmed it.',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Maintenance',
    requiredScope: 'admin:update',
    invalidateStores: ['settings', 'nodes'],
  },
  {
    name: 'get_audit_log',
    description:
      'Query the audit log like the Administration audit view. view entries (default) returns paginated entries; users returns the actors present in the log for filtering; export returns every matching entry (requires the audit export license feature). Filters apply to entries and export.',
    parameters: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['entries', 'users', 'export'], description: 'Default: entries.' },
        action: { type: 'string', description: 'Filter by action name' },
        actions: { type: 'array', items: { type: 'string' }, description: 'Filter by any of these actions' },
        resourceType: { type: 'string', description: 'Filter by resource type' },
        resourceTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by any resource type' },
        userIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by actor user UUIDs; "system" matches system entries',
        },
        excludedActions: { type: 'array', items: { type: 'string' } },
        excludedResourceTypes: { type: 'array', items: { type: 'string' } },
        from: { type: 'string', description: 'ISO 8601 start time' },
        to: { type: 'string', description: 'ISO 8601 end time' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        limit: { type: 'number', description: 'Items per page (default: 50)' },
      },
      additionalProperties: false,
    },
    destructive: false,
    category: 'Administration',
    requiredScope: 'admin:audit',
    invalidateStores: [],
  },
  {
    name: 'manage_system_alerts',
    description:
      "List Gateway's system alerts about certificates (expiry warnings, CA expiry, revocations) or dismiss one by alertId. Operations: list, dismiss. For Gateway's own health use manage_gateway_diagnostics; for configurable alerts use list_alert_rules.",
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'dismiss'] },
        alertId: { type: 'string', description: 'Alert ID for dismiss' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:alerts',
    invalidateStores: [],
  },
  {
    name: 'get_dashboard_stats',
    description:
      'Get dashboard statistics: counts of CAs, certificates, ingress routes, SSL certs, nodes, and expiring items.',
    parameters: {
      type: 'object',
      properties: {
        showSystem: {
          type: 'boolean',
          description: 'Include Gateway system certificates in the counts (requires admin:details:certificates).',
        },
      },
      additionalProperties: false,
    },
    destructive: false,
    category: 'Administration',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  // ── Permission Groups ──
  {
    name: 'list_groups',
    description: 'List all permission groups with their scopes, member counts, and inheritance info.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'Administration',
    requiredScope: 'admin:groups',
    invalidateStores: [],
  },
  {
    name: 'create_group',
    description: 'Create a new permission group with specific scopes. Can optionally inherit from a parent group.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Group name (e.g., "cert-operator")' },
        description: { type: 'string', description: 'Optional description' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of scope strings (e.g., ["cert:read", "cert:issue"])',
        },
        parentId: { type: 'string', description: 'Optional parent group UUID to inherit scopes from' },
        folderId: { type: ['string', 'null'], description: 'Optional group folder UUID.' },
        requireGateway2fa: { type: 'boolean', description: 'Require Gateway MFA for members of this group.' },
      },
      required: ['name', 'scopes'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:groups',
    invalidateStores: ['groups'],
  },
  {
    name: 'update_group',
    description: 'Update a permission group. Built-in groups cannot be modified.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Group UUID' },
        name: { type: 'string', description: 'New group name' },
        description: { type: 'string', description: 'New description' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'New scopes array (replaces existing)',
        },
        parentId: {
          type: ['string', 'null'],
          description: 'New parent group UUID, or null to remove inheritance',
        },
        requireGateway2fa: { type: 'boolean', description: 'Require Gateway MFA for members of this group.' },
      },
      required: ['groupId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:groups',
    invalidateStores: ['groups'],
  },
  {
    name: 'delete_group',
    description: 'Delete a permission group. Cannot delete built-in groups or groups with assigned users.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Group UUID to delete' },
      },
      required: ['groupId'],
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:groups',
    invalidateStores: ['groups'],
  },
  // ── User lifecycle ──
  {
    name: 'manage_user',
    description:
      'Administer another user account like the Administration > Users page. Operations: set_auth_method (password or email_otp emails onboarding and needs verified SMTP), rename (local accounts only), reset_avatar, send_password_link (setup or reset link for password users), send_invitation (emails the one-time "an account was created for you" invitation; only while the user has never signed in and was not invited yet; needs verified SMTP and the public URL), list_sessions, revoke_session, revoke_all_sessions, reset_mfa (admin:system; also ends their browser sessions), list_deleted and restore (admin:system; a restored account stays blocked until unblocked with set_user_blocked). Group membership, blocking, deletion, and additional permissions use update_user_role, set_user_blocked, delete_user, and set_user_additional_permissions. Your own password, MFA, passkeys, sessions, and impersonation stay in the browser.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'set_auth_method',
            'rename',
            'reset_avatar',
            'send_password_link',
            'send_invitation',
            'list_sessions',
            'revoke_session',
            'revoke_all_sessions',
            'reset_mfa',
            'list_deleted',
            'restore',
          ],
          description: 'User administration operation to perform.',
        },
        userId: { type: 'string', description: 'Target user UUID (every operation except list_deleted).' },
        authMethod: {
          type: 'string',
          enum: ['oidc', 'password', 'email_otp'],
          description: 'New sign-in method for set_auth_method.',
        },
        name: { type: 'string', description: 'New display name for rename.' },
        sessionId: { type: 'string', description: 'Public session ID from list_sessions for revoke_session.' },
        groupIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Permission groups for restore; omit to restore the previous memberships.',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Administration',
    requiredScope: 'admin:users',
    invalidateStores: ['users'],
  },
  // ── Node lifecycle ──
  {
    name: 'manage_node',
    description:
      'Operate on one daemon node like the node page. Operations: update (displayName, appearanceColor, serviceAddresses or legacy serviceAddress/secondaryServiceAddress, confirmDomainDnsUpdate, builderSettings; each field needs the same node permission as the UI), regenerate_enrollment_token (only for a node that never enrolled; needs nodes:manage, or nodes:create for a node you created; display the new token and gatewayCertSha256 and give the installCommands entry for the target the host can reach), health_history, monitoring_history, daemon_logs (buffered daemon log lines), and nginx_logs (recent access/error lines for the ingress routes on an nginx node).',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'update',
            'regenerate_enrollment_token',
            'health_history',
            'monitoring_history',
            'daemon_logs',
            'nginx_logs',
          ],
          description: 'Node operation to perform.',
        },
        nodeId: { type: 'string', description: 'Node UUID' },
        displayName: { type: ['string', 'null'], description: 'update: display name, or null to clear.' },
        appearanceColor: {
          type: ['string', 'null'],
          enum: ['blue', 'red', 'green', 'yellow', 'purple', 'pink', 'orange', null],
          description: 'update: node color, or null to clear.',
        },
        serviceAddresses: {
          type: 'array',
          items: { type: 'string' },
          description: 'update: advertised service addresses (IP addresses or hostnames).',
        },
        serviceAddress: { type: ['string', 'null'], description: 'update: legacy primary service address.' },
        secondaryServiceAddress: {
          type: ['string', 'null'],
          description: 'update: legacy secondary service address (nginx nodes).',
        },
        confirmDomainDnsUpdate: {
          type: 'boolean',
          description: 'update: also move assigned domain DNS targets to the new nginx address (domains:edit).',
        },
        builderSettings: {
          type: 'object',
          properties: {
            parallelism: { type: 'number' },
            timeoutMinutes: { type: 'number' },
          },
          required: ['parallelism', 'timeoutMinutes'],
          additionalProperties: false,
          description: 'update: Build Worker settings (builder nodes, nodes:manage).',
        },
        levels: {
          type: 'array',
          items: { type: 'string' },
          description: 'daemon_logs: keep only these levels (for example ["warn","error"]).',
        },
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['2xx', '3xx', '4xx', '5xx', 'error'] },
          description: 'nginx_logs: keep only these status classes or error-log lines.',
        },
        search: { type: 'string', description: 'daemon_logs/nginx_logs: case-insensitive text filter.' },
        limit: { type: 'number', description: 'daemon_logs/nginx_logs: maximum lines returned (default and max 300).' },
      },
      required: ['operation', 'nodeId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Nodes',
    requiredScope: 'nodes:details',
    invalidateStores: ['nodes'],
  },
  // ── Relay Pool ──
  {
    name: 'manage_relay_pool',
    description:
      'Inspect and operate the Relay Pool like Settings > Relay. Operations: get (pool and local relay health, instances with policyTrust, certificate, health.lastError, assignments; settings:gateway:view), local_policy_trust_status (policy signing trust of the local relay as seen by automatic recovery; settings:gateway:view), retry_recovery (retry local relay recovery), rebalance (stage a rebalance of relay assignments), drain_instance (stop placing new sessions on a relay; confirm: true required), resume_instance (undo a drain), force_disconnect_instance (drop every session on a relay; confirm: true required), renew_certificate (renew the server and admin certificates of a remote relay now instead of waiting for automatic renewal 60 days before expiry), reenroll_instance (single-use re-enrollment token for an enrolled remote relay whose policy trust is locked out; confirm: true required; returns installCommands pinned to the pool relay version with --version; give the user the installCommands entry (curl or wget) for the target the relay host can reach and the token expiry, and do not drop --version). Mutations require admin:system. Relay updates use manage_system_updates; relay tuning uses update_gateway_settings generalSettings.relay.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'get',
            'local_policy_trust_status',
            'retry_recovery',
            'rebalance',
            'drain_instance',
            'resume_instance',
            'force_disconnect_instance',
            'renew_certificate',
            'reenroll_instance',
          ],
          description: 'Relay Pool operation to perform.',
        },
        instanceId: { type: 'string', description: 'Relay instance UUID for instance operations.' },
        confirm: {
          type: 'boolean',
          description: 'Must be true for drain_instance, force_disconnect_instance, and reenroll_instance.',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Maintenance',
    requiredScope: 'settings:gateway:view',
    invalidateStores: ['settings', 'nodes'],
  },
  {
    name: 'set_resource_pin',
    description:
      "Set whether a readable resource is pinned to the current browser session's Dashboard or Sidebar. This is a local UI preference, not a server-side resource mutation. Resolve the resource with find_resource first; Docker pins also require nodeId, nodeSlug, and name. This tool is unavailable to MCP clients.",
    parameters: {
      type: 'object',
      properties: {
        resourceType: {
          type: 'string',
          enum: ['node', 'proxy_host', 'database', 'docker_container', 'docker_deployment'],
        },
        resourceId: { type: 'string', description: 'Gateway resource ID to pin or unpin.' },
        target: { type: 'string', enum: ['dashboard', 'sidebar'] },
        pinned: { type: 'boolean', description: 'True pins the resource; false removes only this placement.' },
        nodeId: { type: 'string', description: 'Required when resourceType is a Docker container or deployment.' },
        nodeSlug: { type: 'string', description: 'Required when resourceType is a Docker container or deployment.' },
        name: { type: 'string', description: 'Required when resourceType is a Docker container or deployment.' },
        scopeResourceId: { type: 'string', description: 'Optional stable Docker access identity.' },
      },
      required: ['resourceType', 'resourceId', 'target', 'pinned'],
    },
    destructive: false,
    category: 'Dashboard',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'open_node_enrollment',
    description:
      "Open the concrete Gateway node-enrollment flow in the user's current AI Workspace. Use only after the user has chosen to add a Gateway-managed node. This is a client-side setup handoff, not a blocker and not a resource mutation by itself.",
    parameters: {
      type: 'object',
      properties: {},
    },
    destructive: false,
    category: 'Setup',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'open_connector_setup',
    description:
      "Open the concrete add-connector flow in the user's current AI Workspace. Use only after the user has chosen a connector type for a missing prerequisite. Never open the Finalize Setup checklist for this. Use gitlab for a GitLab instance, github for an account-wide GitHub connection, git for a generic Git host, cloudflare for DNS, or ssh for an external server. Include a known generic Git host or repository only when the user already supplied it. This is a client-side setup handoff, not a blocker and not a resource mutation by itself.",
    parameters: {
      type: 'object',
      properties: {
        connector: {
          type: 'string',
          enum: ['cloudflare', 'gitlab', 'github', 'git', 'ssh'],
          description: 'The connector form to open.',
        },
        baseUrl: {
          type: 'string',
          description: 'Optional known provider or Git-host base URL to prefill.',
        },
        repositoryUrl: {
          type: 'string',
          description: 'Optional known repository URL to prefill for generic Git.',
        },
        host: {
          type: 'string',
          description: 'Optional known external SSH host to prefill.',
        },
      },
      required: ['connector'],
    },
    destructive: false,
    category: 'Setup',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },

  // ── Ask Question ──
  {
    name: 'ask_question',
    description:
      "Ask the user a clarifying question before proceeding. Use this only when a material requirement is unclear, ambiguous, or missing and cannot be inferred from context, tool results, or a standard default. Never use this tool to confirm or approve an action the user already requested; Gateway's approval UI handles policy-required confirmations. Do not ask when there is exactly one valid applicable option or the user asked you to choose automatically/use defaults. You can provide options for the user to pick from, allow free text input, or both.",
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short option label' },
              description: { type: 'string', description: 'Optional longer description' },
            },
            required: ['label'],
          },
          description: 'Optional list of choices for the user to pick from',
        },
        allowFreeText: {
          type: 'boolean',
          description:
            'Whether to also show a free text input (default: true if no options, false if options provided)',
        },
      },
      required: ['question'],
    },
    destructive: false,
    category: 'Interaction',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },

  // ── Internal Documentation ──
  {
    name: 'internal_documentation',
    description:
      'Get detailed internal documentation about a specific topic in this system. Use this whenever you need deeper knowledge about how something works, what fields mean, or what the correct workflow is. Topics: discovery, pki, ssl, proxy, pages, domains, ingress-groups, access-lists, templates, acme, users, audit, siem, nginx, nodes, housekeeping, permissions, docker, availability, databases, storage, storage-migration, postgres, redis, logging, folders, node-files, sandbox, conversations, ai-settings, status-page, api, gateway-settings, licensing-updates, inference, gitlab, notifications, overview, installation, authentication, cloudflare, docker-registries, clickhouse, troubleshooting.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: Object.keys(INTERNAL_DOCS),
          description: 'The topic to get documentation about',
        },
      },
      required: ['topic'],
    },
    destructive: false,
    category: 'Documentation',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context', maxBytes: 32000 },
  },
  {
    name: 'read_gateway_documentation',
    description:
      'Read Gateway internal operational documentation through remote MCP. Topic access is filtered by the OAuth token scopes; general MCP workflow topics remain available to every authenticated MCP connection.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: Object.keys(INTERNAL_DOCS),
          description: 'Gateway documentation topic to read.',
        },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    destructive: false,
    category: 'Documentation',
    requiredScope: 'mcp:use',
    invalidateStores: [],
    historyRetention: { mode: 'never_full' },
    mcpOnly: true,
  },
];
