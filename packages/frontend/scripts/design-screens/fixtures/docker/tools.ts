/**
 * Full-screen tool windows opened from the Docker and node pages: file editors,
 * log windows and consoles. Files here are what those windows open.
 */
import { HttpResponse, http } from "msw";
import { edgeNode } from "../nodes";
import { webContainerId } from "./container-detail";
import { apps1 } from "./data";

export const webNginxConf = `server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /api/ {
        proxy_pass http://api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /healthz {
        access_log off;
        return 200 "ok";
    }

    location / {
        try_files $uri /index.html;
    }
}
`;

export const catalogExport = `${JSON.stringify(
  {
    exportedAt: "2026-09-23T04:00:00Z",
    source: "northwind-catalog",
    products: [
      { sku: "NW-1001", name: "Canvas tote", price: 24.0, currency: "EUR", stock: 312 },
      { sku: "NW-1002", name: "Enamel mug", price: 14.5, currency: "EUR", stock: 128 },
      { sku: "NW-1003", name: "Linen apron", price: 39.0, currency: "EUR", stock: 46 },
      { sku: "NW-1004", name: "Oak serving board", price: 58.0, currency: "EUR", stock: 0 },
    ],
  },
  null,
  2
)}\n`;

export const edgeNginxConf = `user www-data;
worker_processes auto;
pid /run/nginx.pid;

events {
    worker_connections 4096;
    multi_accept on;
}

http {
    sendfile on;
    tcp_nopush on;
    server_tokens off;
    types_hash_max_size 2048;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    log_format opfield '$remote_addr - $host [$time_local] "$request" $status $body_bytes_sent '
                       '$request_time $upstream_response_time';
    access_log /var/log/nginx/access.log opfield;

    include /etc/nginx/conf.d/*.conf;
    include /var/lib/opfield/nginx/sites/*.conf;
}
`;

const text = (body: string) =>
  new HttpResponse(body, { headers: { "Content-Type": "application/octet-stream" } });

export function dockerToolHandlers() {
  const notFound = () => HttpResponse.json({ message: "Not found" }, { status: 404 });
  return [
    http.get("*/api/docker/nodes/:nodeId/containers/:containerId/files/read", ({ params }) =>
      params.nodeId === apps1.id && params.containerId === webContainerId
        ? text(webNginxConf)
        : notFound()
    ),
    http.get("*/api/docker/nodes/:nodeId/volumes/:name/files/read", ({ params }) =>
      params.nodeId === apps1.id && params.name === "web-uploads" ? text(catalogExport) : notFound()
    ),
    http.get("*/api/nodes/:nodeId/files/read", ({ params }) =>
      params.nodeId === edgeNode.id ? text(edgeNginxConf) : notFound()
    ),
  ];
}
