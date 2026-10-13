import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { pathToFileURL } from 'node:url';

// Do not spawn wget: Alpine's TLS helper can outlive it and accumulate under
// the app's PID 1. A fresh Node process owns and closes both probe sockets.
export async function checkHealth({ port = Number(process.env.PORT || 3000), timeoutMs = 2000 } = {}) {
  const probe = (tls) => new Promise((resolve) => {
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(healthy);
    };
    const request = (tls ? httpsGet : httpGet)({
      hostname: '127.0.0.1', port, path: '/health', agent: false,
      // Self-signed, loopback-only Opfield TLS is expected.
      ...(tls ? { rejectUnauthorized: false } : {}),
    }, (response) => {
      response.on('error', () => finish(false));
      finish(response.statusCode === 200);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    request.on('error', () => finish(false));
  });
  return await probe(true) || await probe(false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await checkHealth() ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}
