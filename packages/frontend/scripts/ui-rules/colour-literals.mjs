// Fails on colour literals outside the theme token files, in the frontend and the status page.
// Every colour comes from a token: CSS custom properties in packages/frontend/src/index.css and
// packages/status-page/src/tokens.css (a literal is allowed there only on a `--name:` line), used as
// Tailwind token classes (bg-card, text-tone-blue, bg-scrim/50) or var(--color-…).
// Flagged: hex (#abc, #aabbcc, #aabbccdd), rgb()/rgba()/hsl()/hsla()/hwb()/lab()/lch()/oklab()/oklch()
// with literal channels, Tailwind palette classes (bg-red-500, text-white, from-zinc-900, …) and named
// colours as CSS or style values.
// Usage: node scripts/ui-rules/colour-literals.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packagesRoot = path.resolve(frontendRoot, "..");

const SCAN = [
  { root: path.join(frontendRoot, "src"), exts: [".ts", ".tsx", ".css", ".js", ".mjs", ".svg", ".html"] },
  { root: path.join(frontendRoot, "public"), exts: [".js", ".json", ".svg", ".html", ".css", ".xml", ".webmanifest"] },
  { root: path.join(packagesRoot, "status-page", "src"), exts: [".ts", ".tsx", ".css", ".js", ".svg", ".html"] },
  { root: path.join(packagesRoot, "status-page", "public"), exts: [".js", ".json", ".svg", ".html", ".css", ".xml", ".webmanifest"] },
];
const FILES = [
  path.join(frontendRoot, "index.html"),
  path.join(frontendRoot, "login.html"),
  path.join(packagesRoot, "status-page", "index.html"),
];

/** Token files: a colour literal may only appear on a custom property declaration line. */
const TOKEN_FILES = new Set([
  path.join(frontendRoot, "src/index.css"),
  path.join(packagesRoot, "status-page/src/tokens.css"),
]);

/**
 * The only exceptions: the brand (logo) colours in browser and OS metadata and in the SVG favicon
 * (logo artwork, like the PNG icons), which cannot read CSS tokens. Keyed by file, with the exact
 * literals allowed there.
 */
const BRAND_EXCEPTIONS = new Map([
  [path.join(frontendRoot, "index.html"), ["#141414"]],
  [path.join(frontendRoot, "login.html"), ["#141414"]],
  [path.join(frontendRoot, "public/site.webmanifest"), ["#141414", "#f3f2ef"]],
  [path.join(frontendRoot, "public/browserconfig.xml"), ["#141414"]],
  [path.join(packagesRoot, "status-page/index.html"), ["#141414"]],
  [path.join(packagesRoot, "status-page/public/site.webmanifest"), ["#141414", "#f3f2ef"]],
  [path.join(packagesRoot, "status-page/public/browserconfig.xml"), ["#141414"]],
  [path.join(frontendRoot, "public/favicon.svg"), ["#141414", "#f3f2ef"]],
  [path.join(packagesRoot, "status-page/public/favicon.svg"), ["#141414", "#f3f2ef"]],
]);

const HUES =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
const RULES = [
  { name: "hex colour", re: /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g },
  { name: "colour function", re: /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[\d.]/g },
  {
    name: "Tailwind palette class",
    re: new RegExp(
      `(?<![\\w-])(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|from|to|via|decoration|divide|shadow|accent|caret|placeholder)-(?:(?:${HUES})-\\d{2,3}|white|black)(?:/\\d+)?(?![\\w-])`,
      "g"
    ),
  },
  {
    // CSS, HTML and SVG values (`color: white`) and SVG/JSX attributes (`fill="white"`); a TS
    // property such as a tag's colour id ("blue") is data, not a colour.
    name: "named colour",
    re: /(?:\b(?:color|background(?:-color)?|border(?:-[a-z]+)?-color|fill|stroke|stop-color)\s*:\s*|\b(?:fill|stroke|stop-color|color)=["'{]+)(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|silver)\b/g,
    exts: [".css", ".html", ".svg", ".tsx"],
    cssOnlyColon: true,
  },
];

function walk(root, exts, out) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") walk(full, exts, out);
    } else if (exts.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

const files = [];
for (const { root, exts } of SCAN) walk(root, exts, files);
for (const file of FILES) if (fs.existsSync(file)) files.push(file);

const violations = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const allowed = BRAND_EXCEPTIONS.get(file) ?? [];
  lines.forEach((line, index) => {
    if (TOKEN_FILES.has(file) && /^\s*--[\w-]+\s*:/.test(line)) return;
    for (const rule of RULES) {
      if (rule.exts && !rule.exts.includes(path.extname(file))) continue;
      for (const match of line.matchAll(rule.re)) {
        // In TSX only the attribute form counts; `color: "blue"` there is an object property.
        if (rule.cssOnlyColon && path.extname(file) === ".tsx" && !match[0].includes("=")) continue;
        if (allowed.includes(match[0].toLowerCase())) continue;
        violations.push(
          `${path.relative(packagesRoot, file)}:${index + 1}: ${rule.name} ${match[0].trim()}`
        );
      }
    }
  });
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  console.error(
    `\nColour literals: ${violations.length}. Use a theme token (index.css / status-page tokens.css), adding a semantic one if needed.`
  );
  process.exit(1);
}
console.log(`Colour literals: none outside the token files (${files.length} files).`);
