import type { nodes } from '@/db/schema/index.js';

type HostedNodeReadiness = Pick<typeof nodes.$inferSelect, 'type' | 'status' | 'lastHealthReport' | 'capabilities'>;

/** Opfield usefulness is independent of provider VM power. Never writes node status. */
export function isHostedNodeReady(node: HostedNodeReadiness, connected: boolean): boolean {
  if (!connected || node.status !== 'online') return false;
  if (node.type === 'nginx') return node.lastHealthReport?.nginxRunning === true;
  // Secure Runtime is optional (installed only for Docker roles, skipped where unsupported); readiness is the engine.
  if (node.type === 'docker' || node.type === 'databases' || node.type === 'storage')
    return node.lastHealthReport?.dockerEngine?.available === true;
  if (node.type === 'builder') {
    const capabilities = node.capabilities?.capabilities;
    return Array.isArray(capabilities) && capabilities.includes('docker_builder_execution_v1');
  }
  return node.type === 'monitoring' || node.type === 'relay';
}
