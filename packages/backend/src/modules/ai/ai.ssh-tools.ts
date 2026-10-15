import { container } from '@/container.js';
import { ExternalSshService } from '@/modules/integrations/external-ssh.service.js';
import { ExternalSshConnectorCreateSchema } from '@/modules/integrations/integrations.schemas.js';
import type { User } from '@/types.js';
import { assertAgentSshCommandAllowed } from './ai.console-agent-guard.js';
import { shellStringCommands } from './ai.console-commands.js';
import { inspectConsoleCommand } from './ai.console-safety.js';

export const SSH_TOOL_NAMES = new Set(['ssh_list_connectors', 'ssh_execute_command', 'create_ssh_connector']);

export async function executeSshTool(
  user: User,
  toolName: string,
  args: Record<string, unknown>,
  source?: 'ai' | 'mcp'
) {
  const service = container.resolve(ExternalSshService);
  if (toolName === 'ssh_list_connectors') return service.list(user);
  if (toolName === 'ssh_execute_command') {
    const connectorId = typeof args.connectorId === 'string' ? args.connectorId : '';
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!connectorId || !command) throw new Error('connectorId and command are required');
    const safety = inspectConsoleCommand(['sh', '-lc', command]);
    if (safety.blocked) throw new Error(safety.reason);
    await assertAgentSshCommandAllowed({
      user,
      connectorId,
      commands: shellStringCommands(command),
      probe: (probe) => service.execute(user, connectorId, probe),
      source,
    });
    return service.execute(user, connectorId, command);
  }
  if (toolName === 'create_ssh_connector') {
    const input = ExternalSshConnectorCreateSchema.parse({
      name: args.name,
      host: args.host,
      port: args.port,
      username: args.username,
      authMethod: args.authMethod ?? 'password',
      secret: args.secret,
      hostFingerprint: args.hostFingerprint,
      jumpConnectorId: args.jumpConnectorId,
      enabled: args.enabled,
      generatePrivateKey: args.generatePrivateKey,
      reuseCredentialFromConnectorId: args.reuseCredentialFromConnectorId,
    });
    return service.create(user, input);
  }
  throw new Error(`Unsupported SSH tool: ${toolName}`);
}
