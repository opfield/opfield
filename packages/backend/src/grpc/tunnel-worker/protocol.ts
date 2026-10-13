/** What Opfield's main thread and its tunnel worker exchange (see rpc.ts); every byte array may arrive as Uint8Array. */

export interface WireGrant {
  keyId: string;
  payload: Uint8Array;
  signature: Uint8Array;
}

export interface WireCandidate {
  addresses: string[];
  port: number;
  certificateIdentity: string;
  certificateFingerprint: string;
  grant: WireGrant;
  relayInstanceId: string;
}

/** Where a tunnel or path opens: the local relay with a grant, or a pool candidate (its addresses in order). */
export type WireOpen =
  | { kind: 'local'; grant: WireGrant; relayId: string }
  | { kind: 'candidate'; candidate: WireCandidate };

/** A relay path the worker opened for a resumable stream; it waits there until a dial hands it to its stream. */
export interface RemotePath {
  pathId: string;
  relayId: string;
}

export interface WireResumeConfig {
  routeId: string;
  keyId: string;
  key: Uint8Array;
  halfCloseTimeoutMs?: number;
}

export interface WireDialResult {
  pathId: string;
  keyId?: string;
  key?: Uint8Array;
}

/** One of the worker's resumable streams, for the return to the nearest relay (opfield-relay-paths). */
export interface StreamView {
  id: number;
  routeId: string;
  relayId: string | null;
  movable: boolean;
  lastMoveAt: number;
}

export interface WireIdentity {
  privateKey: Uint8Array;
  certificate: Uint8Array;
}

export interface TunnelWorkerData {
  target: string;
  systemCaPath: string;
  identity: WireIdentity;
}

export interface WorkerLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: Record<string, unknown>;
}
