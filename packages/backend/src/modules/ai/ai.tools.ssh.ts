import type { AIToolDefinition } from './ai.types.js';

export const SSH_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'ssh_list_connectors',
    description: 'List available external SSH connectors. Opfield-managed nodes are intentionally excluded.',
    parameters: { type: 'object', properties: {} },
    destructive: false,
    category: 'External SSH',
    requiredScope: 'integrations:ssh:view',
    invalidateStores: [],
    historyRetention: { mode: 'persistent_context' },
  },
  {
    name: 'ssh_execute_command',
    description:
      'Execute one command on an external SSH connector. Use only after identifying the host and command; Opfield will apply its standard approval policy.',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string', description: 'External SSH connector UUID.' },
        command: { type: 'string', description: 'POSIX shell command to execute.' },
      },
      required: ['connectorId', 'command'],
    },
    destructive: true,
    category: 'External SSH',
    requiredScope: 'integrations:ssh:use',
    invalidateStores: [],
    historyRetention: { mode: 'never_full' },
    effect: 'external',
    approvalClass: 'execute',
  },
  {
    name: 'create_ssh_connector',
    description:
      'Create an external SSH connector once the host fingerprint is confirmed (get it with manage_integration_connector discover_host_key). authMethod password takes secret; private_key takes generatePrivateKey or reuseCredentialFromConnectorId (private key import is disabled). A generated public key is returned for installation on the host.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'number' },
        username: { type: 'string' },
        authMethod: { type: 'string', enum: ['password', 'private_key'], description: 'Default password.' },
        secret: { type: 'string', description: 'SSH account password for password auth.' },
        generatePrivateKey: { type: 'boolean', description: 'Generate a key pair (private_key only).' },
        reuseCredentialFromConnectorId: {
          type: 'string',
          description: 'Reuse the credential of another SSH connector (private_key only).',
        },
        hostFingerprint: {
          type: 'string',
          description: 'Pinned SHA256 host key fingerprint explicitly confirmed by the user.',
        },
        jumpConnectorId: { type: ['string', 'null'] },
        enabled: { type: 'boolean', description: 'Default true.' },
      },
      required: ['name', 'host', 'username', 'hostFingerprint'],
    },
    destructive: true,
    category: 'External SSH',
    requiredScope: 'integrations:ssh:manage',
    invalidateStores: ['integrations'],
    historyRetention: { mode: 'never_full' },
    effect: 'write',
    approvalClass: 'create',
  },
];
