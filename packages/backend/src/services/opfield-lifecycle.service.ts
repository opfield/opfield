import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export type OpfieldLifecycleState = 'running' | 'draining_user' | 'draining_logs' | 'terminating';
export type OpfieldTrafficClass = 'health' | 'status_page' | 'structured_logs' | 'user';

const LOG_INGEST_PATHS = new Set(['/api/logging/ingest', '/api/logging/ingest/batch']);

export class OpfieldLifecycleService {
  private state: OpfieldLifecycleState = 'running';
  private readonly active = new Map<OpfieldTrafficClass, number>([
    ['health', 0],
    ['status_page', 0],
    ['structured_logs', 0],
    ['user', 0],
  ]);
  private readonly sockets = new Map<OpfieldTrafficClass, Map<Socket, number>>([
    ['structured_logs', new Map()],
    ['user', new Map()],
  ]);
  private readonly zeroWaiters = new Map<OpfieldTrafficClass, Set<() => void>>();

  getState(): OpfieldLifecycleState {
    return this.state;
  }

  transition(next: Exclude<OpfieldLifecycleState, 'running'>): void {
    const order: OpfieldLifecycleState[] = ['running', 'draining_user', 'draining_logs', 'terminating'];
    if (order.indexOf(next) < order.indexOf(this.state)) return;
    this.state = next;
  }

  classifyRequest(method: string, path: string, isStatusHost = false): OpfieldTrafficClass {
    const normalizedMethod = method.toUpperCase();
    if (path === '/health' && (normalizedMethod === 'GET' || normalizedMethod === 'HEAD')) return 'health';
    if (path === '/api/public/status-page' && (normalizedMethod === 'GET' || normalizedMethod === 'HEAD')) {
      return 'status_page';
    }
    if (isStatusHost) return 'status_page';
    if (normalizedMethod === 'POST' && LOG_INGEST_PATHS.has(path)) return 'structured_logs';
    return 'user';
  }

  shouldAdmit(trafficClass: OpfieldTrafficClass): boolean {
    if (this.state === 'running') return true;
    if (this.state === 'draining_user') {
      return trafficClass === 'health' || trafficClass === 'status_page' || trafficClass === 'structured_logs';
    }
    if (this.state === 'draining_logs') return trafficClass === 'health' || trafficClass === 'status_page';
    return false;
  }

  trackHttpRequest(request: IncomingMessage, response: ServerResponse, isStatusHost = false): void {
    const path = request.url ? safePath(request.url) : '/';
    const trafficClass = this.classifyRequest(request.method ?? 'GET', path, isStatusHost);
    if (!this.shouldTrack(trafficClass)) return;

    this.active.set(trafficClass, (this.active.get(trafficClass) ?? 0) + 1);
    const socketSet = this.sockets.get(trafficClass);
    if (socketSet) socketSet.set(request.socket, (socketSet.get(request.socket) ?? 0) + 1);
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      response.off('finish', finish);
      response.off('close', finish);
      const remaining = Math.max(0, (this.active.get(trafficClass) ?? 1) - 1);
      this.active.set(trafficClass, remaining);
      if (socketSet) {
        const socketRequests = (socketSet.get(request.socket) ?? 1) - 1;
        if (socketRequests > 0) socketSet.set(request.socket, socketRequests);
        else socketSet.delete(request.socket);
      }
      if (remaining === 0) this.notifyZero(trafficClass);
    };
    response.once('finish', finish);
    response.once('close', finish);
  }

  getActiveCount(trafficClass: 'user' | 'structured_logs'): number {
    return this.active.get(trafficClass) ?? 0;
  }

  async waitForZero(trafficClass: 'user' | 'structured_logs', deadline: number): Promise<boolean> {
    if (this.getActiveCount(trafficClass) === 0) return true;
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) return false;
    return new Promise((resolve) => {
      const waiters = this.zeroWaiters.get(trafficClass) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve(true);
      };
      waiters.add(done);
      this.zeroWaiters.set(trafficClass, waiters);
      timer = setTimeout(() => {
        waiters.delete(done);
        resolve(false);
      }, remainingMs);
      timer.unref?.();
    });
  }

  forceClose(trafficClass: 'user' | 'structured_logs'): void {
    for (const socket of this.sockets.get(trafficClass)?.keys() ?? []) socket.destroy();
  }

  private shouldTrack(trafficClass: OpfieldTrafficClass): boolean {
    if (trafficClass === 'user') return this.state === 'running';
    if (trafficClass === 'structured_logs') return this.state === 'running' || this.state === 'draining_user';
    return false;
  }

  private notifyZero(trafficClass: OpfieldTrafficClass): void {
    for (const waiter of [...(this.zeroWaiters.get(trafficClass) ?? [])]) waiter();
  }
}

function safePath(url: string): string {
  try {
    return new URL(url, 'http://opfield.local').pathname;
  } catch {
    return '/';
  }
}
