import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const LOGIN_ENTRY_PATHS = new Set(["/login", "/reset-password", "/callback"]);

// Icons and the share image keep fixed names in public/. Each reference in index.html gets ?v=<content hash>, so a new
// icon reaches browsers, CDNs and link previews at once instead of after their caches expire.
const VERSIONED_PUBLIC_ASSET =
  /(href|content)="\/((?:favicon|apple-touch-icon|android-chrome|og-image|mstile)[\w.-]*\.(?:ico|svg|png))"/g;

function publicAssetVersion(file: string): string | null {
  const full = path.join(import.meta.dirname, "public", file);
  if (!existsSync(full)) return null;
  return createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 10);
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "");
  const backendTarget = env.GATEWAY_DEV_PROXY_TARGET || "http://localhost:3000";

  return {
    plugins: [
      {
        name: "opfield-versioned-icons",
        transformIndexHtml(html) {
          return html.replace(VERSIONED_PUBLIC_ASSET, (match, attribute: string, file: string) => {
            const version = publicAssetVersion(file);
            return version ? `${attribute}="/${file}?v=${version}"` : match;
          });
        },
      },
      {
        name: "gateway-login-entry",
        configureServer(server) {
          server.middlewares.use((request, _response, next) => {
            if (!request.url) return next();
            const url = new URL(request.url, "http://localhost");
            if (LOGIN_ENTRY_PATHS.has(url.pathname)) {
              request.url = `/login.html${url.search}`;
            }
            next();
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/api": {
          target: backendTarget,
          changeOrigin: true,
          ws: true,
        },
        "/auth": {
          target: backendTarget,
          changeOrigin: true,
        },
        "/.well-known": {
          target: backendTarget,
          changeOrigin: true,
        },
        "/pki": {
          target: backendTarget,
          changeOrigin: true,
        },
        "/docs": {
          target: backendTarget,
          changeOrigin: true,
        },
        "/health": {
          target: backendTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      rollupOptions: {
        input: {
          app: path.resolve(import.meta.dirname, "index.html"),
          login: path.resolve(import.meta.dirname, "login.html"),
        },
      },
    },
  };
});
