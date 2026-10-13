import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The real console, built for production, answering from the design-screen fixtures
 * through MSW in the browser instead of a backend. For checking behaviour a jsdom
 * render cannot show (reveal animations, layout, timing) without a release:
 *   pnpm app-preview            → http://localhost:4174
 *   ?latency=<ms>               → every API answer waits this long (default 250, remembered)
 */
const frontendRoot = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const serviceWorker = path.join(path.dirname(require.resolve("msw/package.json")), "lib/mockServiceWorker.js");

function previewEntry(): Plugin {
  return {
    name: "opfield-app-preview",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace('src="/src/main.tsx"', 'src="/scripts/app-preview/main.ts"'),
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "mockServiceWorker.js", source: fs.readFileSync(serviceWorker, "utf8") });
    },
  };
}

export default defineConfig({
  root: frontendRoot,
  plugins: [previewEntry(), react(), tailwindcss()],
  resolve: { alias: { "@": path.join(frontendRoot, "src") } },
  build: {
    outDir: path.join(__dirname, "out"),
    emptyOutDir: true,
    rollupOptions: { input: path.join(frontendRoot, "index.html") },
  },
  preview: { port: 4174, strictPort: true },
});
