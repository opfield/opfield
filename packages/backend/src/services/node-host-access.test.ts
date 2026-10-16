import { describe, expect, it } from 'vitest';
import { NodeDispatchService } from './node-dispatch.service.js';
import {
  NODE_CONSOLE_AGENT_SANDBOX_CAPABILITY,
  NODE_CONSOLE_DISABLED_CAPABILITY,
  NODE_CONSOLE_USER_UNAVAILABLE_CAPABILITY,
  NODE_FILES_DISABLED_CAPABILITY,
  NODE_PROTECTED_CAPABILITY,
  nodeConsoleRefusal,
  nodeHostAccessFlags,
  RELAY_PROTECTED_WITNESS_ALLOWED_CAPABILITY,
} from './node-host-access.js';

function dispatchFor(advertised: string[]) {
  const sent: unknown[] = [];
  const registry = {
    hasCapability: (_nodeId: string, capability: string) => advertised.includes(capability),
    sendCommand: async (_nodeId: string, command: unknown) => {
      sent.push(command);
      return { commandId: 'c', success: true };
    },
  };
  return { dispatch: new NodeDispatchService(registry as never, {} as never), sent };
}

describe('node host access switches', () => {
  it('maps the disabled markers a daemon advertises to node capability flags', () => {
    expect(nodeHostAccessFlags(undefined)).toEqual({});
    expect(nodeHostAccessFlags(['docker_compose_v1'])).toEqual({});
    expect(nodeHostAccessFlags([NODE_CONSOLE_DISABLED_CAPABILITY, NODE_FILES_DISABLED_CAPABILITY])).toEqual({
      nodeConsoleDisabled: true,
      nodeFilesDisabled: true,
    });
    expect(nodeHostAccessFlags([NODE_CONSOLE_USER_UNAVAILABLE_CAPABILITY])).toEqual({
      nodeConsoleUserUnavailable: true,
    });
  });

  it('refuses console commands with a 409 naming console.user when the daemon cannot switch to it', async () => {
    const { dispatch, sent } = dispatchFor([NODE_CONSOLE_USER_UNAVAILABLE_CAPABILITY]);
    for (const action of ['create', 'resize'] as const) {
      await expect(dispatch.sendNodeExecCommand('node-1', action, { command: ['id'] })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NODE_CONSOLE_USER_UNAVAILABLE',
        message: expect.stringContaining('Remove console.user from the daemon config file'),
      });
    }
    await expect(dispatch.sendNodeAgentCommand('node-1', ['id'])).rejects.toMatchObject({
      code: 'NODE_CONSOLE_USER_UNAVAILABLE',
    });
    expect(sent).toEqual([]);
    await expect(dispatch.sendNodeFileCommand('node-1', 'list', { path: '/' })).resolves.toMatchObject({
      success: true,
    });
  });

  it('refuses console commands with a 409 before dispatching when the node disabled its console', async () => {
    const { dispatch, sent } = dispatchFor([NODE_CONSOLE_DISABLED_CAPABILITY]);
    for (const action of ['create', 'resize'] as const) {
      await expect(dispatch.sendNodeExecCommand('node-1', action, { command: ['id'] })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NODE_CONSOLE_DISABLED',
        message: expect.stringContaining("Console is disabled in this node's daemon configuration"),
      });
    }
    await expect(dispatch.sendNodeAgentCommand('node-1', ['id'])).rejects.toMatchObject({
      code: 'NODE_CONSOLE_DISABLED',
    });
    expect(sent).toEqual([]);
    // The console switch does not touch file access.
    await expect(dispatch.sendNodeFileCommand('node-1', 'list', { path: '/' })).resolves.toMatchObject({
      success: true,
    });
  });

  it('refuses host file operations with a 409 when the node disabled file access, but keeps the host identity read', async () => {
    const { dispatch, sent } = dispatchFor([NODE_FILES_DISABLED_CAPABILITY, NODE_CONSOLE_AGENT_SANDBOX_CAPABILITY]);
    for (const action of ['list', 'read', 'write', 'delete', 'move', 'upload-init', 'upload-abort']) {
      await expect(dispatch.sendNodeFileCommand('node-1', action, { path: '/etc/passwd' })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NODE_FILES_DISABLED',
      });
    }
    expect(sent).toEqual([]);
    await expect(dispatch.sendNodeFileCommand('node-1', 'ensure-host-identity')).resolves.toMatchObject({
      success: true,
    });
    await expect(dispatch.sendNodeAgentCommand('node-1', ['id'])).resolves.toMatchObject({
      success: true,
    });
    expect(sent).toHaveLength(2);
  });

  it('maps protected mode and its database witness switch to node capability flags', () => {
    // A protected relay also advertises the console and file markers, for Opfield releases that know only those.
    expect(
      nodeHostAccessFlags([NODE_PROTECTED_CAPABILITY, NODE_CONSOLE_DISABLED_CAPABILITY, NODE_FILES_DISABLED_CAPABILITY])
    ).toEqual({ nodeProtected: true, nodeConsoleDisabled: true, nodeFilesDisabled: true });
    expect(nodeHostAccessFlags([NODE_PROTECTED_CAPABILITY, RELAY_PROTECTED_WITNESS_ALLOWED_CAPABILITY])).toEqual({
      nodeProtected: true,
      protectedWitnessAllowed: true,
    });
    // The witness switch means nothing without protected mode.
    expect(nodeHostAccessFlags([RELAY_PROTECTED_WITNESS_ALLOWED_CAPABILITY])).toEqual({});
  });

  it('refuses every console and host file command for a protected relay with NODE_PROTECTED, before dispatching', async () => {
    const { dispatch, sent } = dispatchFor([
      NODE_PROTECTED_CAPABILITY,
      NODE_CONSOLE_DISABLED_CAPABILITY,
      NODE_FILES_DISABLED_CAPABILITY,
    ]);
    for (const action of ['create', 'resize'] as const) {
      await expect(dispatch.sendNodeExecCommand('node-1', action, { command: ['id'] })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NODE_PROTECTED',
        message: expect.stringContaining('protected mode'),
      });
    }
    await expect(dispatch.sendNodeAgentCommand('node-1', ['id'])).rejects.toMatchObject({ code: 'NODE_PROTECTED' });
    for (const action of ['list', 'read', 'write', 'delete', 'move', 'create-dir', 'upload-init', 'upload-abort']) {
      await expect(dispatch.sendNodeFileCommand('node-1', action, { path: '/etc/passwd' })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NODE_PROTECTED',
      });
    }
    expect(sent).toEqual([]);
    // The fixed host identity read is Opfield's own file, not host access.
    await expect(dispatch.sendNodeFileCommand('node-1', 'ensure-host-identity')).resolves.toMatchObject({
      success: true,
    });
    expect(sent).toHaveLength(1);
  });

  it('refuses the console WebSocket of a protected relay with NODE_PROTECTED', () => {
    const registry = {
      hasCapability: (_nodeId: string, capability: string) => capability === NODE_PROTECTED_CAPABILITY,
    };
    expect(nodeConsoleRefusal(registry, 'node-1')).toMatchObject({ statusCode: 409, code: 'NODE_PROTECTED' });
    expect(nodeConsoleRefusal({ hasCapability: () => false }, 'node-1')).toBeNull();
  });

  it('sends agent console commands only to daemons that run them in the agent sandbox', async () => {
    const old = dispatchFor([]);
    await expect(old.dispatch.sendNodeAgentCommand('node-1', ['sh', '-c', 'docker ps'])).rejects.toMatchObject({
      statusCode: 409,
      code: 'NODE_CONSOLE_AGENT_SANDBOX_REQUIRED',
      message: expect.stringContaining("Update the node's daemon"),
    });
    expect(old.sent).toEqual([]);
    const current = dispatchFor([NODE_CONSOLE_AGENT_SANDBOX_CAPABILITY]);
    await current.dispatch.sendNodeAgentCommand('node-1', ['df', '-h']);
    expect(current.sent).toEqual([{ nodeExec: { action: 'run', command: ['df', '-h'] } }]);
  });

  it('dispatches console and file commands to a node that disabled nothing', async () => {
    const { dispatch, sent } = dispatchFor([]);
    await dispatch.sendNodeExecCommand('node-1', 'create', { tty: true });
    await dispatch.sendNodeFileCommand('node-1', 'read', { path: '/etc/hostname' });
    expect(sent).toHaveLength(2);
  });
});
