import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from '@/types.js';
import { AppError, errorHandler } from './error-handler.js';

function appThrowing(error: unknown) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.get('/boom', () => {
    throw error;
  });
  return app;
}

function pgError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function drizzleWrapped(cause: unknown) {
  return Object.assign(new Error('Failed query: select ... where "id" = $1 params: profile'), { cause });
}

describe('errorHandler PostgreSQL uuid errors', () => {
  it('maps an invalid uuid text representation to 404, also when Drizzle wraps it', async () => {
    const cause = pgError('22P02', 'invalid input syntax for type uuid: "profile"');
    for (const error of [cause, drizzleWrapped(cause)]) {
      const res = await appThrowing(error).request('/boom');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        code: 'NOT_FOUND',
        message:
          'Resource not found: "profile" is not a UUID. Pass the resource id (a UUID) from the matching list operation.',
      });
    }
  });

  it('answers a value that is no uuid problem as a validation error, and anything else as 500', async () => {
    const other22P02 = drizzleWrapped(pgError('22P02', 'invalid input syntax for type integer: "x"'));
    // The wrapper text mentions uuid but the driver error does not.
    const wrapperOnly = Object.assign(new Error('Failed query: uuid'), {
      cause: pgError('22P02', 'invalid input syntax for type json'),
    });
    for (const error of [other22P02, wrapperOnly]) {
      const res = await appThrowing(error).request('/boom');
      expect(res.status).toBe(400);
    }
    expect((await appThrowing(new Error('boom')).request('/boom')).status).toBe(500);
    expect((await appThrowing(drizzleWrapped(pgError('53300', 'too many clients'))).request('/boom')).status).toBe(500);
  });
});

describe('errorHandler statements PostgreSQL refused', () => {
  const STILL_REFERENCED = 'Key (id)=(1) is still referenced from table "certificates".';
  const NOT_PRESENT = 'Key (template_id)=(1) is not present in table "certificate_templates".';

  function foreignKey(detail: string) {
    return drizzleWrapped(Object.assign(pgError('23503', 'violates foreign key constraint'), { detail }));
  }

  it.each([
    ['a row still referenced', foreignKey(STILL_REFERENCED), 409, 'RESOURCE_IN_USE'],
    ['a reference to a row that does not exist', foreignKey(NOT_PRESENT), 400, 'REFERENCE_NOT_FOUND'],
    ['a duplicate', drizzleWrapped(pgError('23505', 'duplicate key value')), 409, 'ALREADY_EXISTS'],
    ['a NUL byte in text', drizzleWrapped(pgError('22021', 'invalid byte sequence')), 400, 'VALIDATION_ERROR'],
    ['a value too long', drizzleWrapped(pgError('22001', 'value too long')), 400, 'VALIDATION_ERROR'],
    ['a deadlock', drizzleWrapped(pgError('40P01', 'deadlock detected')), 503, 'CONFLICT'],
  ])('answers %s with a typed error and no statement text', async (_name, error, status, code) => {
    const res = await appThrowing(error).request('/boom');
    expect(res.status).toBe(status);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe(code);
    expect(JSON.stringify(body)).not.toMatch(/select|query|constraint|params|Key \(/i);
  });

  it('does not take a Node system error for a statement', async () => {
    const res = await appThrowing(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })).request('/boom');
    expect(res.status).toBe(500);
  });
});

describe('errorHandler permission denials', () => {
  const FOLDER = '55555555-5555-4555-8555-555555555555';
  const DENIED = 'Missing databases:create permission for the selected destination';

  // The handler loads the folder lookup on its first 403; a cold load of the schema can outlast a test timeout.
  beforeAll(async () => {
    await Promise.all([import('@/lib/access-denied.js'), import('@/lib/access-summary-resolver.js')]);
  }, 60_000);

  function appDenying(scopes: string[]) {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.post('/databases', (c) => {
      c.set('effectiveScopes', scopes);
      throw new AppError(403, 'FORBIDDEN', DENIED);
    });
    return app;
  }

  it('names the folders a folder-limited caller may create in', async () => {
    const res = await appDenying([`databases:create:folder/${FOLDER}`]).request('/databases', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: 'FORBIDDEN',
      message: `${DENIED}. Your databases:create access is limited to folder ${FOLDER}: pass folderId for one of them. Call get_my_access to see every folder and node you can use.`,
    });
  });

  it('names the folders of a folder-limited caller refused one resource outside them', async () => {
    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    app.get('/pages/:id', (c) => {
      c.set('effectiveScopes', [`pages:view:folder/${FOLDER}`]);
      throw new AppError(403, 'FORBIDDEN', `Missing required scope: pages:view:${c.req.param('id')}`);
    });
    const res = await app.request('/pages/66666666-6666-4666-8666-666666666666');
    expect(await res.json()).toEqual({
      code: 'FORBIDDEN',
      message: `Missing required scope: pages:view:66666666-6666-4666-8666-666666666666. Your pages:view access is limited to folder ${FOLDER} (and what they contain): act on resources inside them, which the list tools return. Call get_my_access for details.`,
    });
  });

  it('keeps the message of a caller without a limited grant', async () => {
    const res = await appDenying(['databases:view']).request('/databases', { method: 'POST' });
    expect(await res.json()).toEqual({ code: 'FORBIDDEN', message: DENIED });
  });
});
