import { ACCESS_AREAS } from '@/lib/access-summary.js';
import type { AIToolDefinition } from './ai.types.js';

export const DISCOVERY_AI_TOOLS: AIToolDefinition[] = [
  // ── Discovery ──
  {
    name: 'discover_tools',
    description:
      'Discover Gateway tool groups without loading every tool schema. Call with no arguments for compact category summaries, with query for up to three category recommendations, or with one to three explicit categories plus includeTools:true to replace the current active tool working set. Never pre-open categories for future steps.',
    parameters: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description:
            'One explicit Gateway tool category to activate, for example Docker, Logging, SSL Certificates, Administration, or Ingress. Legacy shorthand for categories with one item.',
        },
        categories: {
          type: 'array',
          maxItems: 3,
          items: { type: 'string' },
          description: 'One to three explicit categories for the current task step. Replaces the previous working set.',
        },
        query: {
          type: 'string',
          description: 'Optional text to filter tool names, descriptions, categories, or required scopes.',
        },
        includeTools: {
          type: 'boolean',
          description:
            'Set true only with explicit category/categories to return tool details and activate that bounded working set.',
        },
      },
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'read_skill',
    description:
      'Read one available skill for inspection. Reading does not activate it; use activate_skill before applying its instructions.',
    parameters: {
      type: 'object',
      properties: { skillId: { type: 'string', description: 'Exact skill id from the system-prompt skill catalog.' } },
      required: ['skillId'],
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'activate_skill',
    description:
      'Activate one available skill until the next context compaction and return its complete instructions. Do not activate it again while that activation remains visible; base security and authorization rules always take priority.',
    parameters: {
      type: 'object',
      properties: { skillId: { type: 'string', description: 'Exact skill id from the system-prompt skill catalog.' } },
      required: ['skillId'],
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'get_current_context',
    description:
      'Return the current Gateway page context supplied by the UI: route, focused resource type, and focused resource ID. Use this when the user says "this page", "current resource", or refers to what they are viewing.',
    parameters: {
      type: 'object',
      properties: {},
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'read_tool_output',
    description:
      'Read a bounded byte range from a large output previously offloaded by Gateway. Use the artifactId from the tool-result manifest and advance with nextOffset until eof. Do not retry the original producer just to recover offloaded content.',
    parameters: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'Tool-output artifact UUID from the result manifest.' },
        offset: { type: 'number', description: 'Zero-based byte offset. Default: 0.' },
        limitBytes: { type: 'number', description: 'Bytes to read. Default: 32768, maximum: 65536.' },
      },
      required: ['artifactId'],
    },
    destructive: false,
    category: 'Artifact',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'search_tool_output',
    description:
      'Search literal text inside a large output previously offloaded by Gateway. The search is case-insensitive and returns bounded snippets; regex is not supported.',
    parameters: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'Tool-output artifact UUID from the result manifest.' },
        query: { type: 'string', description: 'Literal text to find. Must contain 1 to 512 characters.' },
        maxMatches: { type: 'number', description: 'Maximum snippets to return. Default: 20, maximum: 50.' },
      },
      required: ['artifactId', 'query'],
    },
    destructive: false,
    category: 'Artifact',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'wait',
    description:
      'Wait briefly before continuing. Use this when an operation is still pending or needs time to complete, then call the relevant status/read tool again instead of ending the conversation.',
    parameters: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          description: 'Seconds to wait before continuing. Clamped to 1-30 seconds. Default: 5.',
        },
        reason: {
          type: 'string',
          description:
            'Short reason for waiting, for example container startup, image pull, DNS propagation, or log ingestion.',
        },
      },
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'send_comment',
    description:
      'Send a short user-visible progress comment during a long multi-tool task, then continue working. Use this proactively before long tool sequences and when instructed that the tool-round limit requires a comment. This first user-visible text locks the response language for all later comments and the final answer in the current run. Call this tool by itself, without other tool calls in the same assistant turn.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description:
            'Concise progress update in the language already used by this run, or its selected response language if this is the first visible text. Mention what you learned or what you are checking next. Do not include secrets.',
        },
      },
      required: ['message'],
    },
    destructive: false,
    category: 'Interaction',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'end_conversation',
    description:
      'End this AI conversation with a localized reason. Use only when the conversation should be closed, for example after repeated unrelated requests or when continuing would be unsafe or outside scope.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short reason shown to the user in their language.',
        },
      },
      required: ['reason'],
    },
    destructive: false,
    category: 'Interaction',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'get_my_access',
    description:
      'Summarize what you can access in Gateway, grouped by area (Docker, routes, domains, certificates, databases, storage, Pages, logging, nodes, integrations, and more): whether access is broad, which folders (id, name, path), nodes and specific resources are granted with which actions, and where you may create (folders, nodes, or the root). Call it when a list comes back empty, when something is refused at the root, and before creating. Folder-limited access is normal: work inside the granted folders and pass folderId (and nodeId) when creating.',
    parameters: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          enum: ACCESS_AREAS.map((area) => area.id),
          description: 'Optional area to return, for example docker_containers or routes. Default: every area.',
        },
      },
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
  },
  {
    name: 'find_resource',
    description:
      'Global resource search and type-scoped listing. Use this FIRST when the user names a resource but you need its ID, nodeId, or exact type. When the user asks to list resources of a type, pass an empty query with that type, for example { query: "", types: ["docker_container"] }. It searches across readable nodes, Docker containers/images/volumes/networks, ingress routes (proxy_host resource type), Page Projects, apps, certificates, domains, logging resources, databases, notifications, and more. Members of an app carry `app` ({id, slug, name, environmentId, environmentName}). Do not manually list every node and then scan each node when find_resource can search the resource type directly.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search text, resource name, hostname, domain, ID, image, or key fragment. Use an empty string only when types is provided and you want to list resources of that type.',
        },
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'app',
              'node',
              'proxy_host',
              'proxy_template',
              'ssl_certificate',
              'domain',
              'access_list',
              'ca',
              'pki_certificate',
              'pki_template',
              'docker_container',
              'docker_deployment',
              'docker_compose_project',
              'docker_build',
              'docker_image',
              'docker_volume',
              'docker_network',
              'docker_registry',
              'database',
              'page_project',
              'logging_environment',
              'logging_schema',
              'status_page_service',
              'status_page_incident',
              'notification_rule',
              'notification_webhook',
            ],
          },
          description: 'Optional resource types to search. Omit to search all readable resource types.',
        },
        nodeId: { type: 'string', description: 'Optional node UUID to constrain Docker resource searches.' },
        limit: {
          type: 'number',
          description: 'Maximum matches to return across all resource types (default 25, max 50).',
        },
      },
    },
    destructive: false,
    category: 'Discovery',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'search_chats',
    description:
      "Search the user's previous AI chats using deterministic raw-history retrieval. Use this when the user refers to prior work, older decisions, previous bugs, commands, errors, files, projects, or missing context. Returns other chats only and excludes the current chat automatically. Returns conversation-level results with message-level snippets; use read_chat_slice for exact source details.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Keep exact identifiers, errors, file paths, commands, and tool names unchanged.',
        },
        scope: {
          type: 'object',
          description:
            'Search boundary. Default is current project when this chat is in a project, otherwise no_project. Use all_user_chats only when the user clearly asks broadly or project-local search is insufficient for an obviously cross-project reference.',
          properties: {
            type: {
              type: 'string',
              enum: ['current_project', 'project', 'no_project', 'all_user_chats'],
            },
            projectId: {
              type: 'string',
              description: 'Required when type is project.',
            },
          },
        },
        limit: { type: 'number', description: 'Maximum conversations to return. Default 10, max 20.' },
      },
      required: ['query'],
    },
    destructive: false,
    category: 'Conversation Retrieval',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'search_compacted_history',
    description:
      'Search exact durable messages from this current conversation before its latest compaction boundary. Use only when the lossy compacted summary is insufficient, the user asks for an exact older detail, or an older identifier, error, path, command, or decision is ambiguous. The server selects the current conversation; this tool cannot read another chat.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A narrow exact identifier, error fragment, path, command, name, or decision to recover.',
        },
        limit: { type: 'number', description: 'Maximum matches to return. Default 5, max 10.' },
      },
      required: ['query'],
    },
    destructive: false,
    category: 'Conversation Retrieval',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'recent_full', maxBytes: 12000 },
  },
  {
    name: 'find_in_chat',
    description:
      'Search inside a specific previous AI chat without reading the whole chat. Use after search_chats when you know the target conversation but need a more precise matching message.',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation UUID to search.' },
        query: { type: 'string', description: 'Search query within that conversation.' },
        limit: { type: 'number', description: 'Maximum matches to return. Default 10, max 20.' },
      },
      required: ['conversationId', 'query'],
    },
    destructive: false,
    category: 'Conversation Retrieval',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'read_chat_slice',
    description:
      'Read a bounded slice of raw messages from a previous AI chat for source verification. Do not use this to read entire chat histories; call search_chats or find_in_chat first unless the user named the exact chat.',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'Conversation UUID to read.' },
        mode: {
          type: 'string',
          enum: ['latest', 'first', 'around_message', 'after', 'before'],
          description: 'Which bounded slice to read.',
        },
        messageId: { type: 'string', description: 'Anchor message UUID for around_message, after, or before.' },
        cursor: { type: 'string', description: 'Cursor returned by a previous read_chat_slice call.' },
        limit: { type: 'number', description: 'Maximum messages to return. Default 20, max 50.' },
      },
      required: ['conversationId', 'mode'],
    },
    destructive: false,
    category: 'Conversation Retrieval',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'list_chat_projects',
    description:
      'List AI chat projects as retrieval boundaries. These are saved chat groupings, not GitLab projects. Never use this for GitLab; use gitlab_list_projects instead.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum projects to return. Default 20, max 50.' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous list_chat_projects response.' },
      },
    },
    destructive: false,
    category: 'Conversation Retrieval',
    requiredScope: 'ai:workspace:use',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
];
