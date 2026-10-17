/**
 * jsdom's WebSocket would dial the fixture origin for real. Screens with a live
 * stream (container logs, consoles) install this stub instead: it opens at once
 * and delivers the fixture frames for its URL, the way the server's first frames
 * would, then stays open and silent.
 */
import { ago } from "../time";

type FrameResolver = (url: string) => unknown[] | undefined;

export function installFixtureWebSocket(resolve: FrameResolver) {
  class FixtureWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = 0;
    binaryType: BinaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    readonly url: string;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      const frames = resolve(this.url) ?? [];
      if (process.env.DESIGN_SCREENS_TRACE) {
        process.stderr.write(`[design-screens] WS ${this.url} (${frames.length} frames)\n`);
      }
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        const open = new Event("open");
        this.onopen?.(open);
        this.dispatchEvent(open);
        for (const frame of frames) {
          if (this.readyState !== 1) return;
          const data = typeof frame === "string" ? frame : JSON.stringify(frame);
          const message = new MessageEvent("message", { data });
          this.onmessage?.(message);
          this.dispatchEvent(message);
        }
      }, 0);
    }

    send() {}

    close() {
      this.readyState = 3;
    }
  }

  Object.defineProperty(window, "WebSocket", {
    configurable: true,
    writable: true,
    value: FixtureWebSocket,
  });
}

/** Docker log lines carry an RFC 3339 timestamp prefix, like `docker logs -t`. */
export function timestamped(lines: Array<[secondsAgo: number, text: string]>) {
  return lines.map(([seconds, text]) => `${ago(seconds, "s").replace("Z", "000000Z")} ${text}`);
}

export const webLogLines = timestamped([
  [412, "/docker-entrypoint.sh: Configuration complete; ready for start up"],
  [405, '10.0.4.21 - - "GET /healthz HTTP/1.1" 200 2 "-" "Opfield-Health/2.14"'],
  [398, '10.0.8.17 - - "GET / HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (Macintosh)"'],
  [397, '10.0.8.17 - - "GET /assets/app-4f1c2a.js HTTP/1.1" 200 184211 "https://app.example.com/"'],
  [397, '10.0.8.17 - - "GET /assets/app-9b02de.css HTTP/1.1" 200 22410 "https://app.example.com/"'],
  [390, '10.0.4.21 - - "GET /healthz HTTP/1.1" 200 2 "-" "Opfield-Health/2.14"'],
  [361, '10.0.8.40 - - "GET /orders HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (Windows NT 10.0)"'],
  [
    360,
    '10.0.8.40 - - "GET /api/orders?page=1 HTTP/1.1" 200 8812 "https://app.example.com/orders"',
  ],
  [
    331,
    '10.0.8.40 - - "POST /api/orders/1842/notes HTTP/1.1" 201 311 "https://app.example.com/orders"',
  ],
  [330, '10.0.4.21 - - "GET /healthz HTTP/1.1" 200 2 "-" "Opfield-Health/2.14"'],
  [296, '10.0.8.52 - - "GET /login HTTP/1.1" 200 3310 "-" "Mozilla/5.0 (iPhone)"'],
  [281, '10.0.8.52 - - "POST /api/session HTTP/1.1" 401 64 "https://app.example.com/login"'],
  [274, '10.0.8.52 - - "POST /api/session HTTP/1.1" 200 412 "https://app.example.com/login"'],
  [270, '10.0.4.21 - - "GET /healthz HTTP/1.1" 200 2 "-" "Opfield-Health/2.14"'],
  [233, "[warn] 31#31: *4821 upstream response is buffered to a temporary file"],
  [210, '10.0.4.21 - - "GET /healthz HTTP/1.1" 200 2 "-" "Opfield-Health/2.14"'],
  [188, '10.0.8.61 - - "GET /reports/weekly HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (X11; Linux)"'],
  [
    187,
    '10.0.8.61 - - "GET /api/reports/weekly HTTP/1.1" 200 40211 "https://app.example.com/reports"',
  ],
  [150, '10.0.4.21 - - "GET /healthz HTTP/1.1" 200 2 "-" "Opfield-Health/2.14"'],
  [121, '10.0.8.17 - - "GET /settings HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (Macintosh)"'],
  [90, '10.0.4.21 - - "GET /healthz HTTP/1.1" 200 2 "-" "Opfield-Health/2.14"'],
  [64, '10.0.8.70 - - "GET /favicon.ico HTTP/1.1" 304 0 "-" "Mozilla/5.0 (Android 14)"'],
  [30, '10.0.4.21 - - "GET /healthz HTTP/1.1" 200 2 "-" "Opfield-Health/2.14"'],
  [
    12,
    '10.0.8.17 - - "GET /api/notifications HTTP/1.1" 200 911 "https://app.example.com/settings"',
  ],
]);

export const checkoutLogLines = timestamped([
  [540, "[1] [INFO] Starting gunicorn 23.0.0"],
  [540, "[1] [INFO] Listening at: http://0.0.0.0:8000 (1)"],
  [539, "[7] [INFO] Booting worker with pid: 7"],
  [539, "[8] [INFO] Booting worker with pid: 8"],
  [480, 'INFO checkout.api "GET /health HTTP/1.1" 200 in 3ms'],
  [455, 'INFO checkout.api "POST /v1/carts HTTP/1.1" 201 in 41ms cart=c_5f2a'],
  [431, 'INFO checkout.api "POST /v1/carts/c_5f2a/items HTTP/1.1" 200 in 18ms'],
  [402, "INFO checkout.payments intent created amount=129.00 currency=EUR order=NW-10842"],
  [398, 'INFO checkout.api "POST /v1/checkout HTTP/1.1" 200 in 212ms order=NW-10842'],
  [360, 'INFO checkout.api "GET /health HTTP/1.1" 200 in 2ms'],
  [311, "WARN checkout.payments provider latency 1.8s above 1.5s budget order=NW-10843"],
  [309, 'INFO checkout.api "POST /v1/checkout HTTP/1.1" 200 in 1911ms order=NW-10843'],
  [240, 'INFO checkout.api "GET /health HTTP/1.1" 200 in 2ms'],
  [201, 'INFO checkout.api "GET /v1/orders/NW-10842 HTTP/1.1" 200 in 9ms'],
  [120, 'INFO checkout.api "GET /health HTTP/1.1" 200 in 3ms'],
  [74, 'INFO checkout.api "POST /v1/carts HTTP/1.1" 201 in 37ms cart=c_6a11'],
  [18, 'INFO checkout.api "GET /health HTTP/1.1" 200 in 2ms'],
]);

export const composeLogLines = timestamped([
  [300, "redis-cache  | 1:M * Background saving started by pid 42"],
  [299, "redis-cache  | 42:C * DB saved on disk"],
  [280, 'api          | {"level":"info","msg":"GET /health","status":200,"ms":2}'],
  [
    262,
    'worker       | {"level":"info","msg":"job completed","queue":"mail","job":"welcome-email","ms":412}',
  ],
  [241, 'web          | 10.0.4.21 - - "GET /healthz HTTP/1.1" 200 2 "-" "Opfield-Health/2.14"'],
  [220, 'api          | {"level":"info","msg":"GET /v1/products","status":200,"ms":14}'],
  [
    201,
    'worker       | {"level":"info","msg":"job completed","queue":"default","job":"sync-inventory","ms":1830}',
  ],
  [180, 'api          | {"level":"warn","msg":"slow query","table":"orders","ms":812}'],
  [161, 'web          | 10.0.8.17 - - "GET / HTTP/1.1" 200 5123 "-" "Mozilla/5.0 (Macintosh)"'],
  [140, 'api          | {"level":"info","msg":"POST /v1/orders","status":201,"ms":64}'],
  [
    121,
    'worker       | {"level":"info","msg":"job completed","queue":"mail","job":"order-confirmation","ms":388}',
  ],
  [100, 'web          | 10.0.4.21 - - "GET /healthz HTTP/1.1" 200 2 "-" "Opfield-Health/2.14"'],
  [60, 'api          | {"level":"info","msg":"GET /health","status":200,"ms":2}'],
  [22, 'worker       | {"level":"info","msg":"heartbeat","queues":["default","mail"],"pending":0}'],
]);
