import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '@/middleware/error-handler.js';
import { describeToolError, formatToolError } from './ai-tool-errors.js';

function toolErrorText(err: unknown): string {
  return formatToolError(describeToolError(err));
}

describe('tool errors', () => {
  it('carry the REST code of an AppError', () => {
    expect(toolErrorText(new AppError(404, 'NOT_FOUND', 'Deployment not found'))).toBe(
      'NOT_FOUND: Deployment not found'
    );
    expect(toolErrorText(new AppError(404, 'MANAGED_DATABASE_NOT_FOUND', 'Managed database not found'))).toBe(
      'MANAGED_DATABASE_NOT_FOUND: Managed database not found'
    );
    expect(describeToolError(new AppError(409, 'CONTAINER_BUSY', 'Container is currently stopping')).expected).toBe(
      true
    );
    // A Route config nginx rejects (HTTP or HTTPS) is the caller's to fix.
    const rejected = describeToolError(
      new AppError(422, 'NGINX_CONFIG_FAILED', 'Failed to apply Nginx config: unknown directive "bogus_directive"')
    );
    expect(rejected.expected).toBe(true);
    expect(formatToolError(rejected)).toBe(
      'NGINX_CONFIG_FAILED: Failed to apply Nginx config: unknown directive "bogus_directive"'
    );
  });

  it('report a route middleware refusal (HTTPException) with its REST code', () => {
    const denied = describeToolError(
      new HTTPException(403, { message: 'Missing required scope: docker:volumes:view:node-1/data' })
    );
    expect(denied.expected).toBe(true);
    expect(formatToolError(denied)).toBe('PERMISSION_DENIED: Missing required scope: docker:volumes:view:node-1/data');
    expect(describeToolError(new HTTPException(502, { message: 'Bad gateway' })).expected).toBe(false);
  });

  it('report AppError details, except the permission metadata a 403 message already names', () => {
    expect(toolErrorText(new AppError(409, 'CONTAINER_BUSY', 'Container is busy', { name: 'api' }))).toBe(
      'CONTAINER_BUSY: Container is busy. Details: {"name":"api"}'
    );
    expect(
      toolErrorText(new AppError(403, 'FORBIDDEN', 'Missing scope', { missingScope: 'docker:containers:view' }))
    ).toBe('FORBIDDEN: Missing scope. Required permission: docker:containers:view');
  });

  it('turn a zod error into VALIDATION_ERROR with its fields instead of the raw issues', () => {
    const parsed = z.object({ domain: z.string(), limits: z.object({ cpuCores: z.number() }) }).safeParse({
      limits: {},
    });
    expect(parsed.success).toBe(false);
    const error = describeToolError(parsed.error);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', expected: true });
    expect(formatToolError(error)).toBe(
      'VALIDATION_ERROR: Request validation failed: domain: Required (expected string); limits.cpuCores: Required (expected number)'
    );
  });

  it('name what a field expects: a UUID, or one of the allowed values', () => {
    const parsed = z
      .object({ projectId: z.string().uuid(), operation: z.enum(['get', 'logs']) })
      .safeParse({ projectId: 'owner/repo', operation: 'status' });
    expect(parsed.success).toBe(false);
    const text = formatToolError(describeToolError(parsed.error));
    expect(text).toContain('projectId: Invalid uuid: expected the UUID of the resource');
    expect(text).toContain('operation: Expected one of: get, logs');
    expect(text).not.toContain('owner/repo');
  });

  it('keep the code a tool helper put in front of its message', () => {
    const error = describeToolError(new Error('PERMISSION_DENIED: Missing required scope docker:containers:view'));
    expect(error).toMatchObject({ code: 'PERMISSION_DENIED', expected: true });
    expect(formatToolError(error)).toBe('PERMISSION_DENIED: Missing required scope docker:containers:view');
  });

  it('treat an error without a code or a 5xx as unexpected', () => {
    expect(describeToolError(new TypeError('Cannot read properties of undefined'))).toEqual({
      message: 'Cannot read properties of undefined',
      expected: false,
    });
    expect(describeToolError(new AppError(502, 'NODE_OFFLINE', 'Node is offline')).expected).toBe(false);
  });
});
