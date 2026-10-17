// Design screen export, end to end:
//   1. compile the product stylesheet (Tailwind build of src/index.css),
//   2. render every screen spec in jsdom (vitest) into out/dom/*.json,
//   3. write the foss-design canvas `opfield` into the repository's .design folder.
// Usage: pnpm design-screens:export [--only <glob>] [--skip-css]
// View it with `design preview` (foss-design) from the repository root.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCss } from "./build-css.mjs";
import { writeCanvas } from "./canvas.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const only = option("--only");

if (!args.includes("--skip-css")) {
  const size = await buildCss();
  console.log(`[design-screens] opfield.css ${(size / 1024).toFixed(1)} KiB`);
}

if (!only) fs.rmSync(path.join(here, "out/dom"), { recursive: true, force: true });
const vitest = spawnSync(
  "npx",
  ["vitest", "run", "--config", "scripts/design-screens/vitest.config.ts"],
  {
    cwd: frontendRoot,
    stdio: "inherit",
    // The CSS build above sets NODE_ENV=production in this process; the screens render in test mode.
    env: { ...process.env, NODE_ENV: "test", ...(only ? { DESIGN_SCREENS_ONLY: only } : {}) },
  }
);
if (vitest.status !== 0) {
  console.error("[design-screens] some screens failed to render; writing the ones that did");
}

const result = writeCanvas();
console.log(`[design-screens] ${result.screens} screens on ${result.pages} pages → ${result.dir}`);
for (const warning of result.warnings) console.warn(`[design-screens] ${warning}`);
process.exitCode = vitest.status === 0 ? 0 : 1;
