import path from "node:path";
import { defineConfig } from "vitest/config";

const frontendRoot = path.resolve(__dirname, "../..");

// Clock times and the browser time zone must not depend on the machine that renders the screens.
process.env.TZ = "UTC";

/**
 * Design screen exporter: mounts real pages in the jsdom test environment,
 * waits for their reveal and writes the settled DOM to `out/dom/`.
 * Run through `pnpm design-screens:export` (see run.mjs), not `pnpm test`.
 */
export default defineConfig({
  root: frontendRoot,
  test: {
    globals: true,
    environment: "jsdom",
    // The console is served from its public origin, so origin-derived text reads real.
    environmentOptions: { jsdom: { url: "https://opfield.example.com/" } },
    setupFiles: [
      path.resolve(frontendRoot, "src/test/setup.ts"),
      path.resolve(__dirname, "setup.ts"),
    ],
    include: [
      process.env.DESIGN_SCREENS_ONLY
        ? `scripts/design-screens/screens/${process.env.DESIGN_SCREENS_ONLY}.export.tsx`
        : "scripts/design-screens/screens/**/*.export.tsx",
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ["default"],
  },
  resolve: {
    alias: {
      "@": path.resolve(frontendRoot, "src"),
    },
  },
});
