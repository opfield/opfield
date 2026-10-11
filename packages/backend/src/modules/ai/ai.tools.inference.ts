import type { AIToolDefinition } from './ai.types.js';

const POLICY_SCHEMA = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', description: 'Allow this user/default policy to use inference.' },
    credits5hEnabled: { type: 'boolean' },
    credits5h: {
      type: 'number',
      minimum: 0,
      description:
        'Public subscription credits for 5 hours. 1 credit equals 1,000,000 weighted tokens before multipliers.',
    },
    credits7dEnabled: { type: 'boolean' },
    credits7d: {
      type: 'number',
      minimum: 0,
      description:
        'Public subscription credits for 7 days. 1 credit equals 1,000,000 weighted tokens before multipliers.',
    },
    credits30dEnabled: { type: 'boolean' },
    credits30d: {
      type: 'number',
      minimum: 0,
      description:
        'Public subscription credits for 30 days. 1 credit equals 1,000,000 weighted tokens before multipliers.',
    },
    apiMonthlyMicrodollars: {
      type: 'number',
      minimum: 0,
      description: 'Monthly API budget in microdollars. 1 USD = 1,000,000 microdollars; 0 disables API usage.',
    },
    billingTimezone: { type: 'string', description: 'IANA billing timezone, for example Europe/Chisinau.' },
  },
  required: [
    'enabled',
    'credits5hEnabled',
    'credits5h',
    'credits7dEnabled',
    'credits7d',
    'credits30dEnabled',
    'credits30d',
    'apiMonthlyMicrodollars',
    'billingTimezone',
  ],
} as const;

export const INFERENCE_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'manage_inference_provider',
    description:
      'Inspect and manage inference provider templates, connections, and the managed inference core. Operations: list_templates, list_connections, connect_api_key, start_authorization, authorization_status, complete_authorization (finish a paste-back sign-in with callback), cancel_authorization, sync, update, set_routing, disconnect, core_status, core_check_updates, core_install (optional coreVersion), core_update (coreVersion), core_repair. Core operations work while inference is disabled. Never acknowledge subscription connector terms unless the user explicitly approves the warning.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'list_templates',
            'list_connections',
            'connect_api_key',
            'start_authorization',
            'authorization_status',
            'complete_authorization',
            'cancel_authorization',
            'sync',
            'update',
            'set_routing',
            'disconnect',
            'core_status',
            'core_check_updates',
            'core_install',
            'core_update',
            'core_repair',
          ],
        },
        providerId: { type: 'string', description: 'Provider template ID from list_templates.' },
        connectionId: { type: 'string', description: 'Provider connection UUID.' },
        sessionId: { type: 'string', description: 'Authorization session UUID.' },
        callback: {
          type: 'string',
          description: 'Redirect URL or code pasted back by the user for complete_authorization.',
        },
        coreVersion: { type: 'string', description: 'Inference core release version for core_install or core_update.' },
        name: { type: 'string', description: 'Connection display name.' },
        connectionName: { type: 'string', description: 'Connection name for start_authorization.' },
        authType: { type: 'string', enum: ['api_key', 'local'] },
        apiKey: { type: 'string', description: 'Provider API key for connect_api_key. Never repeat it.' },
        baseUrl: { type: 'string', description: 'Optional upstream URL for templates that allow overrides.' },
        allowPrivateNetwork: { type: 'boolean' },
        acceptTerms: {
          type: 'boolean',
          description: 'Only true after explicit user approval of the connector warning.',
        },
        termsVersion: { type: 'string', description: 'Exact terms version returned by list_templates.' },
        enabled: { type: 'boolean' },
        routingOrder: { type: 'number', description: 'Connection order used by sequential routing.' },
        minimumRemainingPercent: { type: 'number', minimum: 1, maximum: 100 },
        apiMonthlyLimitUsd: {
          type: ['number', 'null'],
          minimum: 0,
          description: 'Optional provider-connection monthly API budget in USD. null means no connection budget.',
        },
        routingStrategy: {
          type: 'string',
          enum: ['even', 'balanced', 'sequential'],
          description:
            'even spreads requests evenly; balanced distributes new threads; sequential exhausts connections by routing order.',
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Inference',
    requiredScope: 'inference:providers:view',
    invalidateStores: ['settings'],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_inference_model',
    description:
      'List, atomically create/replace, reorder, inspect source suggestions for, or delete published inference models. Operations: list, suggestions, save, reorder (items of {id, sortOrder}), delete. save always replaces the complete model/source/pricing/access configuration in one transaction.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'suggestions', 'save', 'reorder', 'delete'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, sortOrder: { type: 'number' } },
            required: ['id', 'sortOrder'],
          },
          description: 'Model order for reorder.',
        },
        modelId: { type: 'string', description: 'Model UUID. Omit for save to create a new logical model.' },
        configuration: {
          type: 'object',
          description: 'Complete atomic configuration; required for save.',
          properties: {
            model: {
              type: 'object',
              properties: {
                publicId: { type: 'string' },
                displayName: { type: 'string' },
                contextWindow: { type: 'number' },
                maxInputTokens: { type: 'number' },
                maxOutputTokens: { type: ['number', 'null'] },
                autoCompactTokenLimit: { type: 'number' },
                modalities: { type: 'array', items: { type: 'string' } },
                capabilities: { type: 'object', additionalProperties: { type: 'boolean' } },
                reasoningEfforts: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Advertised reasoning efforts in the exact order shown by clients and manifests.',
                },
                defaultReasoningEffort: { type: ['string', 'null'] },
                defaultAccessAllowed: { type: 'boolean' },
                subscriptionMultiplier: {
                  type: 'number',
                  description:
                    'Subscription credit multiplier. Required by the configuration schema; use 1 for API-backed models, where API accounting ignores it.',
                },
              },
              required: [
                'publicId',
                'displayName',
                'contextWindow',
                'maxInputTokens',
                'maxOutputTokens',
                'autoCompactTokenLimit',
                'modalities',
                'capabilities',
                'reasoningEfforts',
                'defaultAccessAllowed',
                'subscriptionMultiplier',
              ],
            },
            sources: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  connectionId: { type: 'string' },
                  discoveredModelId: { type: 'string' },
                  upstreamModelId: { type: 'string' },
                  enabled: { type: 'boolean' },
                  subscriptionMultiplierOverride: { type: ['number', 'null'] },
                  reasoningEffortMap: { type: 'object', additionalProperties: { type: 'string' } },
                  capabilitiesOverride: { type: ['object', 'null'], additionalProperties: { type: 'boolean' } },
                  manualMetadata: { type: 'object' },
                  pricing: { type: 'object' },
                },
                required: ['connectionId', 'reasoningEffortMap'],
              },
            },
            access: {
              type: 'object',
              properties: {
                mode: { type: 'string', enum: ['everyone', 'selected', 'disabled'] },
                subjects: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      subjectType: { type: 'string', enum: ['group', 'user'] },
                      subjectId: { type: 'string' },
                    },
                    required: ['subjectType', 'subjectId'],
                  },
                },
              },
              required: ['mode', 'subjects'],
            },
          },
          required: ['model', 'sources', 'access'],
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Inference',
    requiredScope: 'inference:models:manage',
    invalidateStores: ['settings'],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_inference_limits',
    description:
      'Inspect or manage default and per-user inference budgets. Operations: list_policies, list_users, set_default, set_user, remove_user, reset_user (clear the user current usage windows). Disabled 5h/7d/30d windows are unlimited; an API value of 0 disables API usage.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['list_policies', 'list_users', 'set_default', 'set_user', 'remove_user', 'reset_user'],
        },
        userId: { type: 'string', description: 'Target user UUID for set_user, remove_user, or reset_user.' },
        policy: POLICY_SCHEMA,
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Inference',
    requiredScope: 'inference:limits:manage',
    invalidateStores: ['settings'],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_inference_token',
    description:
      'Manage dedicated gwi_ inference tokens for the current user only. Operations: list, create, revoke. A created secret is shown once and is redacted from assistant history; never create a token for another user.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'create', 'revoke'] },
        name: { type: 'string', description: 'Token name for create.' },
        tokenId: { type: 'string', description: 'Token UUID for revoke.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Inference',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
    historyRetention: { mode: 'never_full' },
  },
  {
    name: 'manage_inference_usage',
    description:
      'Read inference usage. Operations: self and self_overview (the current user usage and remaining budget; feat:ai:use), system (Opfield-wide overview), users (per-user usage), activity_filters, activity (request log filtered by search, status, userId, model; paginated). system, users, and activity need inference:usage:view.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['self', 'self_overview', 'system', 'users', 'activity_filters', 'activity'],
        },
        page: { type: 'number' },
        limit: { type: 'number', description: 'Items per page (max 100)' },
        search: { type: 'string' },
        status: { type: 'string', enum: ['reserved', 'running', 'completed', 'failed', 'cancelled'] },
        userId: { type: 'string', description: 'User UUID filter for activity' },
        model: { type: 'string', description: 'Model filter for activity' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    destructive: false,
    category: 'Inference',
    requiredScope: 'feat:ai:use',
    invalidateStores: [],
    historyRetention: { mode: 'summary_only' },
  },
];
