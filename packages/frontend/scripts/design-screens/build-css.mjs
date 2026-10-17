// Compiles the product stylesheet (src/index.css through the Tailwind Vite
// plugin, exactly as `vite build` does) into out/opfield.css.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(here, "../..");
const outDir = path.join(here, "out");
const tmpDir = path.join(outDir, ".css-build");

export async function buildCss() {
  await build({
    root: frontendRoot,
    // Relative asset URLs, so the fonts load next to opfield.css wherever the canvas is served.
    base: "./",
    configFile: false,
    logLevel: "warn",
    plugins: [tailwindcss()],
    resolve: { alias: { "@": path.join(frontendRoot, "src") } },
    build: {
      outDir: tmpDir,
      emptyOutDir: true,
      minify: true,
      rollupOptions: {
        input: { opfield: path.join(frontendRoot, "src/index.css") },
        output: { assetFileNames: "[name][extname]" },
      },
    },
  });
  const css = fs.readFileSync(path.join(tmpDir, "opfield.css"), "utf8");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "opfield.css"), css);
  for (const file of fs.readdirSync(tmpDir)) {
    if (file.endsWith(".woff2")) fs.copyFileSync(path.join(tmpDir, file), path.join(outDir, file));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return css.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const size = await buildCss();
  console.log(`opfield.css: ${(size / 1024).toFixed(1)} KiB`);
}
