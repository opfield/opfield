import { describe, expect, it } from 'vitest';
import { AI_TOOLS } from './ai.tools.js';
import { classifyAIToolForApproval, getAIToolApprovalDecision } from './ai-approval-policy.js';

describe('AI backend approval policy', () => {
  it('never asks for system assistant tools', () => {
    for (const toolName of [
      'ask_question',
      'discover_tools',
      'internal_documentation',
      'get_current_context',
      'wait',
      'send_comment',
      'search_chats',
      'find_in_chat',
      'read_chat_slice',
      'list_chat_projects',
      'enter_plan_mode',
      'submit_plan',
      'submit_plan_review',
      'update_plan_step',
      'pause_plan_execution',
      'resume_plan_execution',
      'finalize_plan_execution',
      'submit_plan_verification',
    ]) {
      expect(getAIToolApprovalDecision(toolName, 'always-ask')).toEqual({
        classification: 'system-never-ask',
        approvalPolicy: 'system_skipped',
        requiresApproval: false,
      });
    }
  });

  it('asks for every non-system tool in always-ask mode', () => {
    expect(getAIToolApprovalDecision('list_routes', 'always-ask')).toMatchObject({
      classification: 'read',
      approvalPolicy: 'requires_approval',
      requiresApproval: true,
    });
    expect(getAIToolApprovalDecision('create_route', 'always-ask')).toMatchObject({
      classification: 'create',
      requiresApproval: true,
    });
  });

  it('normal mode auto-approves reads and asks for mutations', () => {
    expect(getAIToolApprovalDecision('list_routes', 'normal')).toMatchObject({
      classification: 'read',
      approvalPolicy: 'auto_approved',
      requiresApproval: false,
    });
    expect(getAIToolApprovalDecision('update_route', 'normal')).toMatchObject({
      classification: 'update',
      approvalPolicy: 'requires_approval',
      requiresApproval: true,
    });
  });

  it('bypass-non-destructive mode still asks for delete and execute classes', () => {
    expect(getAIToolApprovalDecision('create_route', 'bypass-non-destructive')).toMatchObject({
      classification: 'create',
      approvalPolicy: 'auto_approved',
      requiresApproval: false,
    });
    expect(getAIToolApprovalDecision('delete_route', 'bypass-non-destructive')).toMatchObject({
      classification: 'delete',
      approvalPolicy: 'requires_approval',
      requiresApproval: true,
    });
    expect(getAIToolApprovalDecision('execute_node_console_command', 'bypass-non-destructive')).toMatchObject({
      classification: 'execute',
      approvalPolicy: 'requires_approval',
      requiresApproval: true,
    });
  });

  it('bypass-everything mode auto-approves policy-eligible tools', () => {
    expect(getAIToolApprovalDecision('delete_route', 'bypass-everything')).toMatchObject({
      classification: 'delete',
      approvalPolicy: 'auto_approved',
      requiresApproval: false,
    });
  });

  it('classifies multi-operation tools from validated arguments and fails closed without a discriminator', () => {
    expect(classifyAIToolForApproval('manage_license', { operation: 'check' })).toBe('destructive');
    expect(classifyAIToolForApproval('manage_license', { operation: 'activate' })).toBe('destructive');
    expect(classifyAIToolForApproval('manage_license', { operation: 'clear' })).toBe('delete');
    expect(classifyAIToolForApproval('manage_license')).toBe('destructive');
    expect(classifyAIToolForApproval('find_resource')).toBe('read');
  });

  it('declares an approval policy for every advertised operation', () => {
    const operationTools = AI_TOOLS.filter((tool) => {
      const properties = tool.parameters.properties as Record<string, unknown> | undefined;
      const operation = properties?.operation as { enum?: unknown } | undefined;
      return Array.isArray(operation?.enum);
    });

    expect(operationTools.length).toBeGreaterThan(20);
    for (const tool of operationTools) {
      const properties = tool.parameters.properties as Record<string, unknown>;
      const advertised = ((properties.operation as { enum: string[] }).enum ?? []).slice().sort();
      if (tool.operationDiscriminator?.arguments.length === 1) {
        const declared = Object.keys(tool.operationDiscriminator.operations).sort();
        expect(declared, tool.name).toEqual(advertised);
      } else {
        expect(tool.operationDiscriminator?.arguments, tool.name).toEqual(['resource', 'operation']);
        expect(Object.keys(tool.operationDiscriminator?.operations ?? {}).length, tool.name).toBeGreaterThan(0);
      }
    }
  });

  it('applies every operation policy in normal and bypass modes', () => {
    for (const tool of AI_TOOLS.filter((candidate) => candidate.operationDiscriminator)) {
      for (const [operation, policy] of Object.entries(tool.operationDiscriminator!.operations)) {
        const discriminatorValues = operation.split('.');
        const args = Object.fromEntries(
          tool.operationDiscriminator!.arguments.map((argument, index) => [argument, discriminatorValues[index]])
        );
        const label = `${tool.name}.${operation}`;
        expect(getAIToolApprovalDecision(tool.name, 'always-ask', args).requiresApproval, label).toBe(true);
        expect(getAIToolApprovalDecision(tool.name, 'normal', args).requiresApproval, label).toBe(
          policy.approvalClass !== 'read'
        );
        expect(getAIToolApprovalDecision(tool.name, 'bypass-non-destructive', args).requiresApproval, label).toBe(
          policy.approvalClass === 'delete' ||
            policy.approvalClass === 'destructive' ||
            policy.approvalClass === 'execute'
        );
        expect(getAIToolApprovalDecision(tool.name, 'bypass-everything', args).requiresApproval, label).toBe(false);
      }
    }
  });

  it('asks before credential reveals and key or secret exports reach the model', () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['manage_managed_database', { operation: 'reveal_credentials' }],
      ['manage_managed_database', { operation: 'reveal_binding_credentials' }],
      ['manage_managed_database', { operation: 'rotate_credentials' }],
      ['manage_database_connection', { operation: 'reveal_credentials' }],
      ['manage_storage_connection', { action: 'reveal_credentials' }],
      ['manage_managed_storage', { action: 'reveal_credentials' }],
      ['manage_ca', { operation: 'export_key' }],
      ['manage_certificate', { operation: 'export', format: 'pkcs12' }],
      ['manage_certificate', { operation: 'export', format: 'private-key' }],
      ['manage_docker_container_config', { operation: 'list_secrets', reveal: true }],
      ['manage_docker_container_config', { operation: 'get_webhook' }],
      ['manage_docker_container_config', { operation: 'upsert_webhook' }],
      ['manage_docker_container_config', { operation: 'regenerate_webhook_token' }],
    ];
    for (const [toolName, args] of calls) {
      const label = `${toolName} ${JSON.stringify(args)}`;
      expect(classifyAIToolForApproval(toolName, args), label).toBe('execute');
      expect(getAIToolApprovalDecision(toolName, 'normal', args).requiresApproval, label).toBe(true);
      expect(getAIToolApprovalDecision(toolName, 'bypass-non-destructive', args).requiresApproval, label).toBe(true);
    }

    expect(classifyAIToolForApproval('manage_certificate', { operation: 'export', format: 'pem' })).toBe('read');
    expect(classifyAIToolForApproval('manage_certificate', { operation: 'export' })).toBe('execute');
    expect(classifyAIToolForApproval('manage_docker_container_config', { operation: 'list_secrets' })).toBe('read');
    expect(
      classifyAIToolForApproval('manage_docker_container_config', { operation: 'list_secrets', reveal: false })
    ).toBe('read');
    expect(
      classifyAIToolForApproval('manage_docker_container_config', { operation: 'list_secrets', reveal: 'yes' })
    ).toBe('destructive');
  });

  it('asks in bypass-non-destructive mode before Docker changes that delete data or run other code', () => {
    const calls: Array<[string, Record<string, unknown>, string]> = [
      ['manage_docker_compose', { operation: 'operation_start', action: 'delete_volumes' }, 'delete'],
      ['manage_docker_compose', { operation: 'operation_start', action: 'down' }, 'delete'],
      ['manage_docker_compose', { operation: 'operation_start', action: 'pull_apply' }, 'execute'],
      ['manage_docker_compose', { operation: 'operation_start', action: 'unknown' }, 'destructive'],
      ['update_docker_container_image', { nodeId: 'node-1', containerId: 'c-1', tag: 'v2' }, 'execute'],
    ];
    for (const [toolName, args, classification] of calls) {
      const label = `${toolName} ${JSON.stringify(args)}`;
      expect(classifyAIToolForApproval(toolName, args), label).toBe(classification);
      expect(getAIToolApprovalDecision(toolName, 'bypass-non-destructive', args).requiresApproval, label).toBe(true);
    }
    expect(
      classifyAIToolForApproval('manage_docker_compose', { operation: 'operation_start', action: 'restart' })
    ).toBe('update');
  });

  it('classifies storage presign by the signed operation', () => {
    const presign = (config?: unknown) => ({ action: 'presign', storageId: 'storage-1', config });
    expect(classifyAIToolForApproval('manage_storage_objects', presign({ bucket: 'b', key: 'k' }))).toBe('read');
    expect(
      classifyAIToolForApproval('manage_storage_objects', presign({ bucket: 'b', key: 'k', operation: 'get' }))
    ).toBe('read');
    expect(
      getAIToolApprovalDecision(
        'manage_storage_objects',
        'normal',
        presign({ bucket: 'b', key: 'k', operation: 'put' })
      )
    ).toMatchObject({ classification: 'update', requiresApproval: true });
    expect(
      classifyAIToolForApproval('manage_storage_objects', presign({ bucket: 'b', key: 'k', operation: 'PUT' }))
    ).toBe('destructive');
    expect(classifyAIToolForApproval('manage_storage_objects', presign({ operation: ['put'] }))).toBe('destructive');
  });

  it('requires approval for outbound test side effects even in bypass-non-destructive mode', () => {
    for (const toolName of ['test_webhook', 'test_siem_destination']) {
      expect(getAIToolApprovalDecision(toolName, 'normal'), toolName).toMatchObject({
        classification: 'destructive',
        requiresApproval: true,
      });
      expect(getAIToolApprovalDecision(toolName, 'bypass-non-destructive'), toolName).toMatchObject({
        classification: 'destructive',
        requiresApproval: true,
      });
    }
    expect(
      getAIToolApprovalDecision('manage_domain', 'bypass-non-destructive', {
        operation: 'check_dns',
      }).requiresApproval
    ).toBe(true);
    expect(
      getAIToolApprovalDecision('manage_system_updates', 'bypass-non-destructive', {
        operation: 'check_opfield',
      }).requiresApproval
    ).toBe(true);
  });
});
