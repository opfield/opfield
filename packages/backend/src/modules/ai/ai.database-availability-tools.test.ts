import { afterEach, describe, expect, it, vi } from 'vitest';
import { container } from '@/container.js';
import { AppError } from '@/middleware/error-handler.js';
import { ManagedDatabaseService } from '@/modules/databases/managed-databases.service.js';
import { LicensePolicyService } from '@/modules/license/license-policy.service.js';
import { executeResourceSetupTool } from './ai.resource-setup-tools.js';

const DATABASE = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const NODE = '44444444-4444-4444-8444-444444444444';

const view = { setId: 'set', mode: 'automatic', state: 'healthy', members: [] };

function setup() {
  const license = {
    requireFeature: vi.fn(async () => undefined),
    requireFeatureForExistingRuntime: vi.fn(async () => undefined),
  };
  const service = {
    getCanonicalScopeResourceId: vi.fn(async () => CONNECTION),
    availabilityView: vi.fn(async () => view),
    availabilityEvents: vi.fn(async () => ({ data: [], page: 1, limit: 50 })),
    availabilityPreflight: vi.fn(async () => ({ mode: 'automatic', blockers: [] })),
    availabilityPreflightForCreate: vi.fn(async () => ({ mode: 'manual', blockers: [] })),
    enableAvailability: vi.fn(async () => view),
    updateAvailability: vi.fn(async () => view),
    addAvailabilityMember: vi.fn(async () => view),
    removeAvailabilityMember: vi.fn(async () => view),
    rebuildAvailabilityMember: vi.fn(async () => view),
    disableAvailability: vi.fn(async () => view),
    makeAvailabilityPrimary: vi.fn(async (_id: string, input: { acceptDataLoss?: boolean }) => {
      if (!input.acceptDataLoss) {
        throw new AppError(409, 'AVAILABILITY_LOSSY_PROMOTION', 'Making this copy primary may lose writes', {
          lossBytes: 4096,
        });
      }
      return view;
    }),
  };
  container.registerInstance(LicensePolicyService, license as never);
  container.registerInstance(ManagedDatabaseService, service as never);
  return { license, service };
}

const user = (scopes: string[]) => ({ id: 'user', scopes }) as never;
const call = (scopes: string[], args: Record<string, unknown>) =>
  executeResourceSetupTool(user(scopes), 'manage_managed_database', args);

afterEach(() => container.reset());

describe('manage_managed_database availability', () => {
  it('runs every availability operation with the REST scopes and inputs', async () => {
    const { service } = setup();
    const edit = [`databases:edit:${CONNECTION}`];

    await call([`databases:view:${CONNECTION}`], { operation: 'availability', databaseId: DATABASE });
    expect(service.availabilityView).toHaveBeenCalledWith(DATABASE);
    await call([`databases:view:${CONNECTION}`], { operation: 'availability_events', databaseId: DATABASE, page: 2 });
    expect(service.availabilityEvents).toHaveBeenCalledWith(DATABASE, { page: 2 });

    await call(edit, {
      operation: 'availability_preflight',
      databaseId: DATABASE,
      availability: { nodeIds: [NODE], priorityMode: true },
    });
    expect(service.availabilityPreflight).toHaveBeenCalledWith(DATABASE, { nodeIds: [NODE] });
    await call(edit, {
      operation: 'make_available',
      databaseId: DATABASE,
      availability: { nodeIds: [NODE], manual: true },
    });
    expect(service.enableAvailability).toHaveBeenCalledWith(DATABASE, { nodeIds: [NODE], manual: true }, 'user');
    await call(edit, {
      operation: 'update_availability',
      databaseId: DATABASE,
      availability: { durability: 'asynchronous', witness: null },
    });
    expect(service.updateAvailability).toHaveBeenCalledWith(
      DATABASE,
      { durability: 'asynchronous', witness: null },
      'user'
    );
    await call(edit, { operation: 'add_member', databaseId: DATABASE, nodeId: NODE });
    expect(service.addAvailabilityMember).toHaveBeenCalledWith(DATABASE, { nodeId: NODE }, 'user');
    await call(edit, { operation: 'remove_member', databaseId: DATABASE, memberId: MEMBER });
    expect(service.removeAvailabilityMember).toHaveBeenCalledWith(DATABASE, MEMBER, 'user');
    await call(edit, { operation: 'rebuild_member', databaseId: DATABASE, memberId: MEMBER });
    expect(service.rebuildAvailabilityMember).toHaveBeenCalledWith(DATABASE, MEMBER, 'user');
    await call(edit, { operation: 'disable_availability', databaseId: DATABASE, keepMemberId: MEMBER });
    expect(service.disableAvailability).toHaveBeenCalledWith(DATABASE, 'user', { keepMemberId: MEMBER });
    await call(edit, { operation: 'make_primary', databaseId: DATABASE, memberId: MEMBER, acceptDataLoss: true });
    expect(service.makeAvailabilityPrimary).toHaveBeenCalledWith(
      DATABASE,
      { memberId: MEMBER, acceptDataLoss: true },
      'user'
    );
  });

  it('refuses changes with view access only, and reads without a database grant', async () => {
    const { service } = setup();
    await expect(
      call([`databases:view:${CONNECTION}`], { operation: 'make_primary', databaseId: DATABASE, memberId: MEMBER })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(call(['nodes:details'], { operation: 'availability', databaseId: DATABASE })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(service.makeAvailabilityPrimary).not.toHaveBeenCalled();
    expect(service.availabilityView).not.toHaveBeenCalled();
  });

  it('passes a lossy switch refusal with its estimate through unless acceptDataLoss is set', async () => {
    setup();
    await expect(
      call(['databases:edit'], { operation: 'make_primary', databaseId: DATABASE, memberId: MEMBER })
    ).rejects.toMatchObject({ statusCode: 409, code: 'AVAILABILITY_LOSSY_PROMOTION', details: { lossBytes: 4096 } });
  });

  it('checks the create preflight against databases:create on every server', async () => {
    const { service } = setup();
    const args = {
      operation: 'availability_preflight',
      type: 'postgres',
      version: '17.6',
      nodeId: NODE,
      availability: { nodeIds: [MEMBER] },
    };
    await expect(call([`databases:create:node/${NODE}`], args)).rejects.toMatchObject({ statusCode: 403 });
    await call(['databases:create'], args);
    expect(service.availabilityPreflightForCreate).toHaveBeenCalledWith({
      nodeIds: [NODE, MEMBER],
      type: 'postgres',
      version: '17.6',
    });
  });

  it('gates the database feature like the routes: changes need the current plan, switches keep working', async () => {
    const { license } = setup();
    await call(['databases:edit'], { operation: 'add_member', databaseId: DATABASE, nodeId: NODE });
    expect(license.requireFeature).toHaveBeenLastCalledWith('external-database-connections');
    license.requireFeature.mockClear();
    await call(['databases:edit'], {
      operation: 'make_primary',
      databaseId: DATABASE,
      memberId: MEMBER,
      acceptDataLoss: true,
    });
    await call(['databases:edit'], { operation: 'rebuild_member', databaseId: DATABASE, memberId: MEMBER });
    await call(['databases:edit'], { operation: 'disable_availability', databaseId: DATABASE });
    expect(license.requireFeature).not.toHaveBeenCalled();
    expect(license.requireFeatureForExistingRuntime).toHaveBeenCalledWith('external-database-connections');
  });
});
