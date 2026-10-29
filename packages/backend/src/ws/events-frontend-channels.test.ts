import 'reflect-metadata';
// The schema barrel first: loading the services alone enters the schema import cycle mid-way.
import '@/db/schema/index.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_SCOPES } from '@/lib/scopes.js';
import { canReceiveChannelPayload } from './events.ws.js';
import { hasChannelAccess, isDefaultDeliverChannel } from './events-channel-access.js';

const FRONTEND_SRC = join(process.cwd(), '../frontend/src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) ? [path] : [];
  });
}

/** Channels the browser subscribes to: direct subscribe / useRealtime calls and quoted event-shaped names. */
function frontendChannels(): string[] {
  const channels = new Set<string>();
  const call = /(?:useRealtime|eventStream\.subscribe|subscribeEvent)\(\s*["']([^"']+)["']/g;
  const named = /["']([a-z][a-z-]*(?:\.[a-z_-]+)+\.(?:changed|fired|resolved|refreshed|ingested))["']/g;
  for (const file of sourceFiles(FRONTEND_SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(call)) channels.add(match[1]!);
    for (const match of text.matchAll(named)) channels.add(match[1]!);
  }
  return [...channels].sort();
}

// Every field a delivery rule may read, so a rule that exists is not mistaken for a missing one.
const PAYLOAD = {
  id: 'x',
  action: 'updated',
  nodeId: 'n1',
  nodeIds: ['n1'],
  kind: 'containers',
  scopeResourceId: 'r1',
  containerName: 'c1',
  containerId: 'c1',
  name: 'x',
  ref: 'img',
  volumeName: 'v1',
  projectId: 'p1',
  deploymentId: 'd1',
  sourceNodeId: 'n1',
  targetNodeId: 'n2',
  targetKind: 'container',
  environmentId: 'e1',
  ruleId: 'x',
  provider: 'gitlab',
  ownerKind: 'managed_database',
  policyId: 'x',
  resourceId: 'res1',
  connectorId: 'con1',
};

describe('events the frontend subscribes to', () => {
  const channels = frontendChannels();

  it('finds the subscriptions (the scan itself works)', () => {
    expect(channels.length).toBeGreaterThan(40);
    expect(channels).toContain('docker.availability.changed');
    expect(channels).toContain('proxy.host.changed');
  });

  it.each(channels)('%s is authorized by a rule, allow-listed, or not subscribable at all', (channel) => {
    const everything = [...ALL_SCOPES];
    // Not subscribable: the server refuses the subscription, so no event is ever delivered on it.
    if (!hasChannelAccess(everything, channel)) return;
    expect(
      isDefaultDeliverChannel(channel) || canReceiveChannelPayload(everything, channel, PAYLOAD, 'user-1'),
      `${channel} is subscribable but has neither a delivery rule in events.ws.ts nor an entry in the id-only allow-list`
    ).toBe(true);
  });

  it('delivers Docker Availability events to a container viewer, for its nodes only when node-limited', () => {
    for (const channel of ['docker.availability.changed', 'docker.availability.operation.changed']) {
      expect(canReceiveChannelPayload(['docker:containers:view'], channel, { policyId: 'p' })).toBe(true);
      expect(canReceiveChannelPayload(['docker:containers:view:n1'], channel, { policyId: 'p', nodeId: 'n1' })).toBe(
        true
      );
      expect(canReceiveChannelPayload(['docker:containers:view:n1'], channel, { policyId: 'p', nodeId: 'n2' })).toBe(
        false
      );
      expect(canReceiveChannelPayload(['nodes:details'], channel, { policyId: 'p' })).toBe(false);
    }
  });
});
