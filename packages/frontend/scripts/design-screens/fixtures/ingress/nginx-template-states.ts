/**
 * Nginx template editor results: the rendered preview (sample data) and the
 * `nginx -t` check the Test button runs.
 */
import { http } from "msw";
import { wrapped } from "../../handlers";

export const renderedTemplatePreview = `# Rendered with sample data: route preview.example.com
server {
  listen 443 ssl;
  http2 on;
  server_name preview.example.com;

  ssl_certificate     /etc/opfield/tls/preview.example.com/fullchain.pem;
  ssl_certificate_key /etc/opfield/tls/preview.example.com/privkey.pem;

  add_header Strict-Transport-Security "max-age=63072000" always;
  add_header Content-Security-Policy "default-src 'self'" always;

  limit_req zone=route_preview burst=3000 nodelay;
  limit_conn route_preview_conn 1000;

  location / {
    proxy_pass http://127.0.0.1:42100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
`;

export function nginxTemplateStateHandlers() {
  return [
    http.post("*/api/nginx-templates/preview", () =>
      wrapped({ rendered: renderedTemplatePreview })
    ),
    http.post("*/api/nginx-templates/test", () =>
      wrapped({ rendered: renderedTemplatePreview, valid: true, errors: [] })
    ),
  ];
}
