import { Socket } from 'node:net';

export const RELAY_PORT_PROBE_TIMEOUT_MS = 3_000;

/** The advertised relay address (host name, IPv4 or IPv6, brackets optional) on the relay port. */
export function relayEndpoint(address: string, port: number) {
  const host = address.trim().replace(/^\[(.*)\]$/, '$1');
  return { host, port, label: host.includes(':') ? `[${host}]:${port}` : `${host}:${port}` };
}

export function relayPortUnreachableMessage(label: string) {
  return `The relay is installed, but ${label} does not answer from Opfield. Open TCP ${label.split(':').at(-1)} on the firewall and forward it to this VM; the installation finishes when it answers.`;
}

/** Whether a TCP connection to host:port opens within the timeout. */
export function tcpAnswers(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}
