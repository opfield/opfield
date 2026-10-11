import { z } from '@hono/zod-openapi';
import { appRoute, dataResponseSchema, jsonBody, okJson, optionalJsonBody, pathParamSchema } from '@/lib/openapi.js';
import {
  ManagedAvailabilityAddMemberSchema,
  ManagedAvailabilityDisableSchema,
  ManagedAvailabilityEnableSchema,
  ManagedAvailabilityEventsQuerySchema,
  ManagedAvailabilityMakePrimarySchema,
  ManagedAvailabilityPreflightSchema,
  ManagedAvailabilitySettingsSchema,
} from './databases.schemas.js';

/**
 * REST documentation of database and storage availability (one resource on several servers). Databases and managed
 * storage share the same routes under their own paths; the commercial edition serves them.
 */

const AvailabilityMemberSchema = z.object({
  id: z.string().uuid(),
  nodeId: z.string().uuid(),
  nodeName: z.string().nullable(),
  priority: z.number().int(),
  role: z.string().openapi({ description: 'primary | copy | rebuilding | fenced | unknown' }),
  previousPrimary: z.boolean().openapi({
    description:
      'It still reports itself primary but lost the role in a failover (role shows unknown until it reports)',
  }),
  eligible: z.boolean().openapi({ description: 'Whether this copy may take over now' }),
  eligibilityReason: z.string().nullable(),
  lagBytes: z.number().nullable(),
  lagSeconds: z.number().nullable(),
  syncState: z.string().openapi({ description: 'sync | async | none' }),
  status: z.string().openapi({ description: 'creating | ready | error | removing' }),
  desiredState: z.string().openapi({ description: 'member | removing' }),
  publishedPort: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastReportedAt: z.string().nullable(),
  reporting: z.boolean().openapi({ description: 'The member reported recently' }),
});

export const AvailabilityViewSchema = z
  .object({
    setId: z.string().uuid(),
    mode: z.string().openapi({
      description:
        'automatic | manual. `manual`: a replicated pair without automatic failover (no witness host); make a copy primary by hand',
    }),
    state: z.string().openapi({
      description:
        'converting | healthy | degraded | no_failover | failing_over | closing | error | paused (the resource is paused)',
    }),
    stateReason: z
      .object({ code: z.string(), message: z.string().optional(), since: z.string().optional() })
      .passthrough()
      .nullable(),
    durability: z.string().openapi({ description: 'synchronous | asynchronous' }),
    durabilitySource: z.string().openapi({ description: 'auto | admin' }),
    lossWindowText: z.string().openapi({ description: 'What an unplanned failover can lose with this durability' }),
    maxLagBytes: z.number(),
    syncDegradeAfterSeconds: z.number(),
    priorityMode: z.boolean(),
    failbackDelaySeconds: z.number(),
    rttP50Ms: z.number().nullable(),
    rttMeasuredAt: z.string().nullable(),
    primaryMemberId: z.string().uuid().nullable(),
    primarySince: z.string().nullable(),
    primaryGeneration: z.number(),
    members: z.array(AvailabilityMemberSchema),
    voters: z.array(z.string()),
    witnesses: z.array(
      z.object({
        id: z.string().uuid(),
        purpose: z.string().openapi({ description: 'lease | keeper' }),
        hostKind: z.string().openapi({ description: 'relay | node' }),
        relayInstanceId: z.string().uuid().nullable(),
        nodeId: z.string().uuid().nullable(),
        role: z.string().openapi({ description: 'active | standby' }),
        status: z.string(),
      })
    ),
    missingForAutomatic: z.string().nullable(),
    canLose: z.number().nullable().openapi({ description: 'Servers the set can lose now and keep its primary role' }),
    lease: z
      .object({
        mode: z.string(),
        degraded: z.boolean(),
        reason: z.string().nullable(),
        joint: z.boolean(),
        holderNodeId: z.string().nullable(),
      })
      .nullable(),
    policyLeaseHours: z.number().nullable().openapi({
      description: 'How long failover keeps working while Opfield is down (the relay policy lease)',
    }),
    operation: z
      .object({
        id: z.string(),
        kind: z.string(),
        step: z.string(),
        startedAt: z.string(),
        lastError: z.string().nullable(),
      })
      .nullable(),
    connection: z
      .object({
        multiHostUri: z.string().nullable(),
        hosts: z.array(z.object({ memberId: z.string(), host: z.string(), port: z.number() })),
      })
      .nullable(),
    changesBlocked: z.string().nullable().openapi({
      description:
        'Set when the license no longer covers changes: turning on, adding servers and settings are refused; everything else keeps working',
    }),
  })
  .openapi('AvailabilityView');

export const AvailabilityPreflightResultSchema = z
  .object({
    mode: z.string().openapi({ description: 'automatic | manual' }),
    voters: z.array(z.string()),
    witnesses: z.array(
      z.object({ kind: z.string().openapi({ description: 'relay | node' }), id: z.string(), name: z.string() })
    ),
    candidates: z.array(z.object({ kind: z.string(), id: z.string(), name: z.string() })).openapi({
      description: 'Every host that may be a witness for these servers, not only the ones picked',
    }),
    durabilityFixed: z.string().nullable().openapi({ description: 'The durability the engine always uses, or null' }),
    rttP50Ms: z.number().nullable(),
    defaultDurability: z.string().openapi({ description: 'synchronous | asynchronous' }),
    durability: z.string().openapi({ description: 'synchronous | asynchronous' }),
    lossWindowText: z.string(),
    restartNeeded: z.boolean(),
    policyLeaseHours: z.number().nullable(),
    missingForAutomatic: z.string().nullable(),
    blockers: z.array(z.object({ code: z.string(), message: z.string() })),
    warnings: z.array(z.string()),
  })
  .openapi('AvailabilityPreflight');

const AvailabilityEventsResponseSchema = z.object({
  data: z.array(z.record(z.unknown())).openapi({
    description:
      'Audit rows (`action` `availability.<event>`); `createdAt` is when it happened, also for events the servers queued while Opfield was down (`details.noticedAt`: when Opfield learned of it)',
  }),
  page: z.number(),
  limit: z.number(),
});

const LOSS_RULES =
  'A planned switch (the primary serves and the copy is eligible) loses nothing. When the primary is gone or no copy is eligible, the switch can lose recent writes: it is refused with 409 `AVAILABILITY_LOSSY_PROMOTION` and the estimate (`details.lossBytes`) unless the body has `acceptDataLoss: true`. A replicated pair without automatic failover switches as planned only while its primary reports: the primary steps down and confirms it before the copy is promoted (the operation fails and promotes nothing without that confirmation), and the copy must stream within the lag bound (409 `AVAILABILITY_COPY_NOT_STREAMING` unless `acceptDataLoss`). A primary that does not report is waited for until it was last seen 45 s ago (409 `AVAILABILITY_PRIMARY_RECENTLY_SEEN` with the seconds left). A member running another database cluster than the primary is never made primary (409 `AVAILABILITY_OTHER_CLUSTER`). A second switch while one runs is refused (409 `AVAILABILITY_OPERATION_PENDING`).';

interface AvailabilityDocsInput {
  /** Path of one resource, e.g. `/managed/{id}` or `/{id}`. */
  base: string;
  /** Path of the create-form preflight. */
  createPreflightPath: string;
  createPreflightSchema: z.ZodTypeAny;
  tag: string;
  noun: string;
  viewScope: string;
  editScope: string;
  createScope: string;
}

/** The availability routes of one resource kind (databases, managed storage). */
export function availabilityRouteDocs(input: AvailabilityDocsInput) {
  const { base, tag, noun, viewScope, editScope } = input;
  const params = pathParamSchema('id');
  const memberParams = pathParamSchema('id', 'memberId');
  const license = (gate: 'current' | 'existing') =>
    gate === 'current'
      ? 'Needs the current plan with multi-node availability (Business).'
      : 'Keeps working on an existing set after the license grace period.';
  return {
    createPreflight: appRoute({
      method: 'post',
      path: input.createPreflightPath,
      tags: [tag],
      summary: `Check a new ${noun} on several servers`,
      description: `What creating the ${noun} on these servers would do: the mode (\`automatic\` with witnesses, else \`manual\`), lease voters and witnesses, the measured round trip between the servers, the default durability and what an unplanned failover can lose, blockers and warnings. Needs ${input.createScope} on every server. ${license('current')}`,
      request: jsonBody(input.createPreflightSchema),
      responses: okJson(dataResponseSchema(AvailabilityPreflightResultSchema)),
    }),
    get: appRoute({
      method: 'get',
      path: `${base}/availability`,
      tags: [tag],
      summary: `Read the availability of a ${noun}`,
      description: `Members (role, eligible, lag, sync state, last report), voters, witnesses, state with its reason, durability and its loss window, the running operation. 404 \`AVAILABILITY_SET_NOT_FOUND\` when the ${noun} runs on one server. Needs ${viewScope}. ${license('existing')}`,
      request: { params },
      responses: okJson(dataResponseSchema(AvailabilityViewSchema)),
    }),
    events: appRoute({
      method: 'get',
      path: `${base}/availability/events`,
      tags: [tag],
      summary: `List availability events of a ${noun}`,
      description: `Failovers, switches, degraded and restored states, rejoins, rebuilds, witness moves, newest first. Needs ${viewScope}.`,
      request: { params, query: ManagedAvailabilityEventsQuerySchema },
      responses: okJson(AvailabilityEventsResponseSchema),
    }),
    preflight: appRoute({
      method: 'post',
      path: `${base}/availability/preflight`,
      tags: [tag],
      summary: `Check running a ${noun} on several servers`,
      description: `The preflight of turning availability on with these extra servers (the ${noun}'s own server is always a member). Needs ${editScope}. ${license('current')}`,
      request: { params, ...jsonBody(ManagedAvailabilityPreflightSchema) },
      responses: okJson(dataResponseSchema(AvailabilityPreflightResultSchema)),
    }),
    enable: appRoute({
      method: 'post',
      path: `${base}/availability`,
      tags: [tag],
      summary: `Run a ${noun} on several servers`,
      description: `Turns availability on: the ${noun} keeps serving from its server, the copies are seeded in the background (202). Refused with 409 \`AVAILABILITY_PREFLIGHT_FAILED\` and the blockers. \`manual: true\` makes a replicated pair of exactly two servers without automatic failover. Needs ${editScope}. ${license('current')}`,
      request: { params, ...jsonBody(ManagedAvailabilityEnableSchema) },
      responses: {
        202: {
          description: 'Started',
          content: { 'application/json': { schema: dataResponseSchema(AvailabilityViewSchema) } },
        },
      },
    }),
    update: appRoute({
      method: 'patch',
      path: `${base}/availability`,
      tags: [tag],
      summary: `Change availability settings of a ${noun}`,
      description: `Durability (switching a far pair to synchronous makes every commit wait for the round trip), failback, the fallback delay of a synchronous copy, the lag a copy may have and stay eligible, and the lease witnesses of a set with automatic failover (\`witness\`; null lets Opfield pick). Needs ${editScope}. ${license('current')}`,
      request: { params, ...jsonBody(ManagedAvailabilitySettingsSchema) },
      responses: okJson(dataResponseSchema(AvailabilityViewSchema)),
    }),
    disable: appRoute({
      method: 'delete',
      path: `${base}/availability`,
      tags: [tag],
      summary: `Run a ${noun} on one server again`,
      description: `Turns availability off: the primary stays and serves as the single server; the copies are removed (202). \`keepMemberId\` must name the primary. Needs ${editScope}. ${license('existing')}`,
      request: { params, ...optionalJsonBody(ManagedAvailabilityDisableSchema) },
      responses: {
        202: {
          description: 'Started',
          content: { 'application/json': { schema: dataResponseSchema(AvailabilityViewSchema) } },
        },
      },
    }),
    addMember: appRoute({
      method: 'post',
      path: `${base}/availability/members`,
      tags: [tag],
      summary: `Add a server to a ${noun}`,
      description: `Adds a copy on another storage node (202); it is seeded from the primary. Refused for a replicated pair without automatic failover. Needs ${editScope}. ${license('current')}`,
      request: { params, ...jsonBody(ManagedAvailabilityAddMemberSchema) },
      responses: {
        202: {
          description: 'Started',
          content: { 'application/json': { schema: dataResponseSchema(AvailabilityViewSchema) } },
        },
      },
    }),
    removeMember: appRoute({
      method: 'delete',
      path: `${base}/availability/members/{memberId}`,
      tags: [tag],
      summary: `Remove a server from a ${noun}`,
      description: `Removes a copy and its data (202). A set keeps at least two servers; make another copy primary before removing the primary of a replicated pair. Needs ${editScope}. ${license('existing')}`,
      request: { params: memberParams },
      responses: {
        202: {
          description: 'Started',
          content: { 'application/json': { schema: dataResponseSchema(AvailabilityViewSchema) } },
        },
      },
    }),
    rebuild: appRoute({
      method: 'post',
      path: `${base}/availability/members/{memberId}/rebuild`,
      tags: [tag],
      summary: `Rebuild a copy of a ${noun}`,
      description: `Deletes the copy's data and seeds it again from the primary (202). The primary cannot be rebuilt. Needs ${editScope}. ${license('existing')}`,
      request: { params: memberParams },
      responses: {
        202: {
          description: 'Started',
          content: { 'application/json': { schema: dataResponseSchema(AvailabilityViewSchema) } },
        },
      },
    }),
    makePrimary: appRoute({
      method: 'post',
      path: `${base}/availability/make-primary`,
      tags: [tag],
      summary: `Make a copy of a ${noun} primary`,
      description: `${LOSS_RULES} Needs ${editScope}. ${license('existing')}`,
      request: { params, ...jsonBody(ManagedAvailabilityMakePrimarySchema) },
      responses: {
        202: {
          description: 'Started',
          content: { 'application/json': { schema: dataResponseSchema(AvailabilityViewSchema) } },
        },
      },
    }),
  };
}

export type AvailabilityRouteDocs = ReturnType<typeof availabilityRouteDocs>;
