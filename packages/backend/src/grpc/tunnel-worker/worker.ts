import { parentPort, workerData } from 'node:worker_threads';
import { RelayControlClient } from '../relay-control.client.js';
import { RelayTunnelEngine } from './engine.js';
import type { TunnelWorkerData } from './protocol.js';
import { asBuffer, RpcPort } from './rpc.js';

/**
 * Opfield's tunnel worker: the data plane of Opfield's own Secure Link tunnels (see RelayTunnelEngine). It presents
 * the main thread's relay client identity and follows its changes; it makes no admin calls.
 */
if (!parentPort) throw new Error('The Opfield tunnel worker runs only as a worker thread');
const data = workerData as TunnelWorkerData;
const client = new RelayControlClient({
  target: data.target,
  systemCaPath: data.systemCaPath,
  certificatePath: '',
  privateKeyPath: '',
  identity: { privateKey: asBuffer(data.identity.privateKey), certificate: asBuffer(data.identity.certificate) },
});
const rpc = new RpcPort(parentPort);
new RelayTunnelEngine(rpc, client);
rpc.emit('ready');
