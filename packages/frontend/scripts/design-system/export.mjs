#!/usr/bin/env node
// Exports the Good Gateway design system from the frontend sources into the
// repository's foss-design system folder, .design/system/:
//
//   system.json                 name, description, and src/index.css as the stylesheet
//   specimens/<component>.html  one page per component: the catalog preview running the
//                               real component through prelude.ts (`@ds/` alias)
//   guidelines/*.md             the brand book, one page per section, and the rules of
//                               every component, one page per catalog group
//   assets/<Group>/             logos, favicons and edition badges
//
// It also makes sure .design/design.json aliases `@/` (the frontend sources) and
// `@ds/` (this folder) and lists the frontend sources for Tailwind.
//
// Usage (from packages/frontend): pnpm design-system:export
// Then from the repository root: `design check --render`, `design preview` → /system.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBrandBook } from "./brand-book.mjs";
import { actionsAndForms } from "./catalog/actions-forms.mjs";
import { layoutAndData } from "./catalog/layout-data.mjs";
import { overlays } from "./catalog/overlays.mjs";
import { statusAndLoading } from "./catalog/status-loading.mjs";
import { loadToolchain } from "./lib/build.mjs";
import { composite, contrastRatio, formatRatio, parseColor, withAlpha } from "./lib/color.mjs";
import { buildTokens, loadSources, readProductCss, readTailwindTheme } from "./lib/css-tokens.mjs";
import { createProgram, readCva, readExports } from "./lib/source-meta.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../..");
const REPO = path.resolve(FRONTEND, "../..");
const DOCS_REPO = path.resolve(REPO, "../gateway-docs");
const DESIGN = path.join(REPO, ".design");
const SYSTEM = path.join(DESIGN, "system");
const TITLE = "Opfield";

const CATALOG = [...actionsAndForms, ...statusAndLoading, ...overlays, ...layoutAndData];

/** Components the export deliberately leaves out, and why (the "Not synced" guideline). */
const NOT_CARDED = [
  ["CommandPalette", "src/components/common/CommandPalette.tsx", "app-level: reads the API, auth and navigation stores"],
  ["AppStatusGate", "src/components/common/AppStatusGate.tsx", "app-level: polls the backend status"],
  ["ScopeList", "src/components/common/ScopeList.tsx", "reads the API and auth stores"],
  ["FolderedResourceList", "src/components/common/FolderedResourceList.tsx", "reads folder stores and realtime; ResourceListForm shows its UI"],
  ["RequireScope", "src/components/common/RequireScope.tsx", "a route guard with no UI of its own"],
  ["LiteModeBackButton", "src/components/common/LiteModeBackButton.tsx", "PageBackButton in AI lite mode only"],
  ["GitScopeRestriction", "src/components/common/GitScopeRestriction.tsx", "part of ScopeList: searches Git providers through the API"],
];

/** Timing constants the guides quote; a change in the source is reported. */
const EXPECTED_TIMINGS = {
  PAGE_LOADER_DELAY_MS: 500,
  PAGE_LOADER_MIN_MS: 500,
  SETTLE_MS: 50,
  REVEAL_STEP_MS: 35,
  REVEAL_DURATION_MS: 220,
  REVEAL_MAX_STAGGERED: 10,
  DIALOG_WAIT_INDICATOR_DELAY_MS: 250,
  DIALOG_WAIT_INDICATOR_MIN_MS: 300,
  DIALOG_MAX_WAIT_MS: 10_000,
};

const ASSETS = [
  { group: "Logos", files: [
    [path.join(DOCS_REPO, "public/brand/good-gateway-lockup-light.png"), "good-gateway-lockup-light.png", "Lockup for light grounds: the mark and the ink wordmark \"opfield\". 1968 × 584."],
    [path.join(DOCS_REPO, "public/brand/good-gateway-lockup-dark.png"), "good-gateway-lockup-dark.png", "Lockup for dark grounds: white wordmark on a rounded black plate. 1932 × 512."],
    [path.join(FRONTEND, "public/android-chrome-512x512.png"), "good-gateway-mark-512.png", "The mark on its tile, 512px (the product's android-chrome-512, og-image and the docs logo are this same file)."],
    [path.join(FRONTEND, "public/android-chrome-192x192.png"), "good-gateway-mark-192.png", "The mark, 192px: what the sidebar shows at 20px."],
  ] },
  { group: "Favicons", files: [
    [path.join(FRONTEND, "public/favicon-48x48.png"), "favicon-48x48.png", "Browser favicon, 48px."],
    [path.join(FRONTEND, "public/favicon-32x32.png"), "favicon-32x32.png", "Browser favicon, 32px."],
    [path.join(FRONTEND, "public/favicon-16x16.png"), "favicon-16x16.png", "Browser favicon, 16px."],
    [path.join(FRONTEND, "public/apple-touch-icon.png"), "apple-touch-icon.png", "iOS home screen icon, 180px."],
    [path.join(FRONTEND, "public/mstile-310x310.png"), "mstile-310x310.png", "Windows tile, 310px (tile colour theme-color)."],
    [path.join(FRONTEND, "public/mstile-150x150.png"), "mstile-150x150.png", "Windows tile, 150px."],
    [path.join(FRONTEND, "public/mstile-70x70.png"), "mstile-70x70.png", "Windows tile, 70px."],
  ] },
  { group: "Editions", files: [
    [path.join(FRONTEND, "public/license/wiolett-gw-personal.png"), "wiolett-gw-personal.png", "Personal edition badge, 128px (licence settings)."],
    [path.join(FRONTEND, "public/license/wiolett-gw-community.png"), "wiolett-gw-community.png", "Community edition badge, 128px."],
    [path.join(FRONTEND, "public/license/wiolett-gw-business.png"), "wiolett-gw-business.png", "Business edition badge, 128px."],
    [path.join(FRONTEND, "public/license/wiolett-gw-enterprise.png"), "wiolett-gw-enterprise.png", "Enterprise edition badge, 128px."],
  ] },
];

/** Brand book sections (its `## ` headings) → guideline pages, in order; the intro opens Overview. */
const BRAND_BOOK_PAGES = [
  { heading: null, title: "Overview" },
  { heading: "Visual foundations", title: "Visual foundations" },
  { heading: "Interaction", title: "Interaction" },
  { heading: "Loading: the reveal pipeline", title: "Loading" },
  { heading: "Writing", title: "Writing" },
  { heading: "Do and don't", title: "Do and don't" },
  { heading: "Brand assets", title: "Brand assets" },
  { heading: "Components", title: "Overview", keepHeading: true },
  { heading: "Not synced", title: "Not synced", order: 99 },
];

// ---------------------------------------------------------------------------

function git(...args) {
  try {
    return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function writeFile(rel, content) {
  const full = path.join(SYSTEM, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const kebab = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase();

function mdCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Every Markdown heading one level deeper (`# A` → `## A`). */
function demote(markdown, levels = 1) {
  return markdown.replace(/^(#{1,5}) /gm, (_, hashes) => `${"#".repeat(Math.min(6, hashes.length + levels))} `);
}

function stateClasses(text, prefix) {
  const re = new RegExp(`(?<![\\w:-])${prefix}:([^\\s"'\`]+)`, "g");
  const out = new Set();
  for (const match of text.matchAll(re)) out.add(match[1]);
  return [...out].join(" ");
}

function readTimings() {
  const text = ["src/components/common/reveal-gate.tsx", "src/components/ui/dialog.tsx"]
    .map((rel) => fs.readFileSync(path.join(FRONTEND, rel), "utf8"))
    .join("\n");
  const timings = {};
  const drift = [];
  for (const [name, expected] of Object.entries(EXPECTED_TIMINGS)) {
    const match = new RegExp(`const ${name} = ([\\d_]+);`).exec(text);
    const value = match ? Number(match[1].replaceAll("_", "")) : expected;
    timings[name] = value;
    if (!match) drift.push(`${name} not found in the source`);
    else if (value !== expected) drift.push(`${name} is ${value} in the source, the guides say ${expected}`);
  }
  return { timings, drift };
}

function brandColor() {
  const html = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(FRONTEND, "public/site.webmanifest"), "utf8"));
  const meta = /<meta name="theme-color" content="([^"]+)"/.exec(html)?.[1];
  const sources = [];
  if (meta) sources.push("index.html theme-color");
  if (manifest.theme_color) sources.push("site.webmanifest theme_color");
  const findings = [];
  if (meta && manifest.theme_color && meta.toLowerCase() !== manifest.theme_color.toLowerCase()) {
    findings.push(`theme-color differs: index.html ${meta}, site.webmanifest ${manifest.theme_color}.`);
  }
  if (manifest.background_color) {
    findings.push(`site.webmanifest background_color is ${manifest.background_color}, not a theme token (dark background is #0e0e0e).`);
  }
  return { value: meta ?? manifest.theme_color, sources, findings, tagline: manifest.description ?? "" };
}

// --- contrast of cva variants (Button, Badge) ------------------------------

const TEXT_SIZE = /^text-(xs|sm|base|lg|xl|[2-9]xl|left|right|center|ellipsis|wrap|nowrap|\[\d)/;

function resolveColorName(name, themeValues, tailwindTheme) {
  const cssVar = /^\[color:var\(--([\w-]+)\)\]$/.exec(name);
  if (cssVar) return themeValues.get(cssVar[1]) ?? null;
  const [base, alphaText] = name.split("/");
  let color = null;
  if (themeValues.has(`color-${base}`)) color = themeValues.get(`color-${base}`);
  else if (tailwindTheme.has(`color-${base}`)) color = parseColor(tailwindTheme.get(`color-${base}`));
  if (!color) return null;
  return alphaText ? withAlpha(color, Number(alphaText) / 100) : color;
}

function variantPaint(classes, theme, themeValues, tailwindTheme) {
  const tokens = classes.split(/\s+/);
  const pick = (prefix) => {
    const plain = tokens.filter((c) => c.startsWith(`${prefix}-`) && !(prefix === "text" && TEXT_SIZE.test(c)));
    const dark = tokens.filter((c) => c.startsWith(`dark:${prefix}-`)).map((c) => c.slice(5));
    const chosen = theme === "dark" && dark.length ? dark : plain;
    for (const cls of chosen) {
      const color = resolveColorName(cls.slice(prefix.length + 1), themeValues, tailwindTheme);
      if (color) return color;
    }
    return null;
  };
  return { bg: pick("bg"), text: pick("text") };
}

function cvaContrast(cva, themes, tailwindTheme) {
  const rows = [];
  for (const [variant, classes] of Object.entries(cva.variants.variant)) {
    const cells = [];
    for (const theme of themes) {
      const values = new Map([...theme.values].map(([name, value]) => [name, parseColor(value)]));
      const paint = variantPaint(classes, theme.id, values, tailwindTheme);
      for (const groundName of ["color-background", "color-card"]) {
        const ground = values.get(groundName);
        const fill = paint.bg ? composite(paint.bg, ground) : ground;
        const text = paint.text ?? values.get("color-foreground");
        const ratio = contrastRatio(composite(text, fill), fill);
        cells.push({ theme: theme.id, ground: groundName.replace("color-", ""), ratio });
      }
    }
    rows.push({ variant, cells });
  }
  return rows;
}

// --- specimens -------------------------------------------------------------------

/** A specimen page: the catalog preview script, run as a module against the real kit. */
function renderSpecimen(entry, facts) {
  const script = entry.preview(facts).trim();
  if (/<\/script/i.test(script)) throw new Error(`${entry.name}: preview script would end its element`);
  const summary = entry.summary.replace(/`/g, "");
  if (/-->|\n\s*@/.test(summary)) throw new Error(`${entry.name}: summary would break the doc comment`);
  const specimenDir = path.join(SYSTEM, "specimens");
  const sources = [entry.source, ...(entry.extraSources ?? [])]
    .map((rel) => path.relative(specimenDir, path.join(FRONTEND, rel)))
    .join(" ");
  return `<!doctype html>
<!--
@title ${entry.name}
@group ${entry.group}
@description ${summary}
@source ${sources}
-->
<html lang="en">
<head><meta charset="utf-8"><title>${entry.name}</title></head>
<body>
<div id="root" style="min-height: ${entry.height ?? 120}px"></div>
<script type="module">
import { G, I, React, h, mount, row, stage } from "@ds/prelude";
${script}
</script>
</body>
</html>
`;
}

// --- guidelines ---------------------------------------------------------------------

function renderComponentReadme(entry, facts, exportsMeta, contrastRows) {
  const lines = [`# ${entry.name}`, "", entry.summary, "", entry.guide.trim(), ""];
  if (facts.cva) {
    lines.push("## Variants", "");
    for (const [group, options] of Object.entries(facts.cva.variants)) {
      lines.push(`**${group}** (default \`${facts.cva.defaults[group] ?? "none"}\`)`, "", "| Option | Classes |", "| --- | --- |");
      for (const [option, classes] of Object.entries(options)) lines.push(`| \`${option}\` | \`${mdCell(classes)}\` |`);
      lines.push("");
    }
    lines.push(`Base classes: \`${mdCell(facts.cva.base)}\``, "");
    const undescribed = Object.entries(facts.cva.variants).flatMap(([group, options]) =>
      Object.keys(options)
        .filter((option) => !entry.guide.includes(`\`${option}\``))
        .map((option) => `\`${option}\` (${group}: \`${mdCell(options[option])}\`)`)
    );
    if (undescribed.length) lines.push(`In the source but not yet described in these guidelines: ${undescribed.join(", ")}.`, "");
  }
  if (contrastRows) {
    lines.push("## Contrast", "", "Label text on the variant's fill, over the page (`background`) and a card (`card`); 4.5:1 needed.", "", "| Variant | Light · background | Light · card | Dark · background | Dark · card |", "| --- | --- | --- | --- | --- |");
    for (const row of contrastRows) {
      const cell = (theme, ground) => {
        const c = row.cells.find((x) => x.theme === theme && x.ground === ground);
        return `${formatRatio(c.ratio)}${c.ratio < 4.5 ? " ✗" : ""}`;
      };
      lines.push(`| \`${row.variant}\` | ${cell("light", "background")} | ${cell("light", "card")} | ${cell("dark", "background")} | ${cell("dark", "card")} |`);
    }
    lines.push("");
  }
  lines.push("## Props", "");
  for (const name of entry.exports) {
    const meta = exportsMeta.get(name);
    if (!meta) {
      lines.push(`- \`${name}\`: not exported by \`scripts/design-system/entry.tsx\`.`);
      continue;
    }
    if (meta.kind === "value") {
      lines.push(`**\`${name}\`**: \`${mdCell(meta.type)}\``, "");
      continue;
    }
    const generics = meta.typeParams.length ? `<${meta.typeParams.join(", ")}>` : "";
    lines.push(`**\`${name}${generics}\`**${meta.doc ? `: ${meta.doc}` : ""}`, "");
    if (meta.own.length) {
      lines.push("| Prop | Type | Notes |", "| --- | --- | --- |");
      for (const prop of meta.own) lines.push(`| \`${prop.name}${prop.optional ? "?" : ""}\` | \`${mdCell(prop.type)}\` | ${mdCell(prop.doc)} |`);
      lines.push("");
    }
    if (meta.inherited.length) {
      const parts = meta.inherited.map(([pkg, count, names]) =>
        pkg === "@types/react"
          ? `${count} HTML attributes and event handlers (\`@types/react\`)`
          : count <= 16
            ? `from \`${pkg}\`: ${names.map((n) => `\`${n}\``).join(", ")}`
            : `${count} props from \`${pkg}\``
      );
      lines.push(`Also accepts ${parts.join("; ")}.`, "");
    }
    if (!meta.own.length && !meta.inherited.length) lines.push("No props.", "");
  }
  const sources = [entry.source, ...(entry.extraSources ?? [])];
  lines.push("## Source", "", sources.map((source) => `\`packages/frontend/${source}\``).join(", "), "");
  return lines.join("\n");
}

/** Heights of controls and rows, read from the component sources (Visual foundations). */
function sizeTable(cva) {
  const rem = (cls) => {
    const match = /^(?:h|w|min-h)-(\d+(?:\.\d+)?)$/.exec(cls);
    return match ? `${Number(match[1]) * 4}px` : null;
  };
  const rows = [];
  for (const [size, classes] of Object.entries(cva.button.variants.size)) {
    const height = classes.split(" ").map(rem).find(Boolean);
    const icon = size.startsWith("icon");
    if (!height) rows.push([`button-${size}`, "auto", `Button size \`${size}\` has no box of its own (${classes}).`]);
    else rows.push([`button-${size}`, height, icon ? `Square icon button, ${height} (Button size \`${size}\`).` : `Button size \`${size}\`: ${height} high, text stays 14px.`]);
  }
  for (const [size, classes] of Object.entries(cva.badge.variants.size)) {
    rows.push([`badge-${size}`, classes.split(" ").map(rem).find(Boolean), `Badge size \`${size}\`.`]);
  }
  rows.push(["control", "36px", "Input, Select trigger, NumericInput, CopyValueField (h-9): every single-line control."]);
  const dataTable = fs.readFileSync(path.join(FRONTEND, "src/components/ui/data-table.tsx"), "utf8");
  const rowHeight = /const ROW_HEIGHT = (\d+);/.exec(dataTable)?.[1];
  if (rowHeight) rows.push(["datatable-row", `${rowHeight}px`, "DataTable row height used for virtualisation (px-4 py-3 cells)."]);
  rows.push(["resource-row", "52px", "Resource list rows (ResourceListCell min-h-[52px])."]);
  return [
    "## Sizes",
    "",
    "Heights of controls and rows, read from the component sources.",
    "",
    "| Name | Height | Use |",
    "| --- | --- | --- |",
    ...rows.map(([name, value, usage]) => `| \`${name}\` | ${value} | ${mdCell(usage)} |`),
    "",
  ].join("\n");
}

/** Splits the brand book at its `## ` headings into guideline pages (BRAND_BOOK_PAGES). */
function brandBookPages(markdown, extra) {
  const parts = markdown.split(/^## /m);
  const sections = [{ heading: null, body: parts[0] }];
  for (const part of parts.slice(1)) {
    const newline = part.indexOf("\n");
    sections.push({ heading: part.slice(0, newline).trim(), body: part.slice(newline + 1) });
  }
  const pages = new Map();
  for (const section of sections) {
    const spec = BRAND_BOOK_PAGES.find((page) => page.heading === section.heading);
    if (!spec) throw new Error(`brand book section "${section.heading}" has no guideline page`);
    const page = pages.get(spec.title) ?? { title: spec.title, order: spec.order, bodies: [] };
    // A section's sub-sections become the page's sections; a section merged into another page keeps its heading.
    const body = spec.keepHeading ? `## ${section.heading}\n${section.body}` : section.body.replace(/^### /gm, "## ");
    page.bodies.push(body.trim());
    pages.set(spec.title, page);
  }
  for (const [title, body] of Object.entries(extra)) pages.get(title)?.bodies.push(body.trim());
  return [...pages.values()];
}

function guideline(title, order, body) {
  return `---\ntitle: ${title}\norder: ${order}\n---\n\n${body.trim()}\n`;
}

// --- foss-design project config ---------------------------------------------------

function ensureDesignConfig() {
  const file = path.join(DESIGN, "design.json");
  if (!fs.existsSync(file)) throw new Error(`no foss-design project at ${DESIGN}: run \`design init\` in ${REPO}`);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const rel = (dir) => `${path.relative(REPO, dir)}/`;
  config.alias = { ...(config.alias ?? {}), "@/": rel(path.join(FRONTEND, "src")), "@ds/": rel(HERE) };
  const sources = new Set(config.sources ?? []);
  sources.add(path.relative(REPO, path.join(FRONTEND, "src")));
  config.sources = [...sources];
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

// ---------------------------------------------------------------------------

function main() {
  ensureDesignConfig();
  for (const dir of ["specimens", "guidelines", "assets"]) fs.rmSync(path.join(SYSTEM, dir), { recursive: true, force: true });

  const tool = loadToolchain(FRONTEND);
  const sha = git("rev-parse", "--short", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const dirty = git("status", "--porcelain", "--", "packages/frontend/src", "packages/frontend/public", "packages/frontend/index.html").length > 0;
  console.log(`Opfield design system → ${SYSTEM}`);
  console.log(`  source ${branch}@${sha}${dirty ? " (+ uncommitted frontend changes)" : ""}`);

  // Sources ---------------------------------------------------------------------
  const sources = loadSources(FRONTEND);
  const product = readProductCss(FRONTEND);
  const tailwindTheme = readTailwindTheme(tool.tailwindThemePath);
  const brand = brandColor();
  const { timings, drift } = readTimings();

  const entryFile = path.join(HERE, "entry.tsx");
  const program = createProgram(tool.ts, FRONTEND, entryFile);
  const exportsMeta = readExports(tool.ts, program, entryFile, FRONTEND);
  const cvaOf = (rel) => readCva(tool.ts, program, path.join(FRONTEND, rel));
  const cva = { button: cvaOf("src/components/ui/button.tsx"), badge: cvaOf("src/components/ui/badge.tsx") };

  const kitSources = CATALOG.flatMap((entry) => [entry.source, ...(entry.extraSources ?? [])]);
  const tokenResult = buildTokens({ frontendDir: FRONTEND, tailwindTheme, product, sources, brandColor: brand, kitSources, meta: {} });
  const { tokens } = tokenResult;

  const lightValues = new Map(tokens.color.tokens.filter((t) => typeof t.value === "object").map((t) => [t.name, t.value.light]));
  const darkValues = new Map(tokens.color.tokens.filter((t) => typeof t.value === "object").map((t) => [t.name, t.value.dark]));
  lightValues.set("theme-color", brand.value);
  darkValues.set("theme-color", brand.value);
  const themes = [{ id: "light", values: lightValues }, { id: "dark", values: darkValues }];
  const contrastByComponent = {
    Button: cvaContrast(cva.button, themes, tailwindTheme),
    Badge: cvaContrast(cva.badge, themes, tailwindTheme),
  };

  // Specimens and component rules ------------------------------------------------------
  const groups = [...new Set(CATALOG.map((entry) => entry.group))];
  const rulesByGroup = new Map(groups.map((group) => [group, []]));
  for (const entry of CATALOG) {
    const text = [entry.source, ...(entry.extraSources ?? [])].map((rel) => fs.readFileSync(path.join(FRONTEND, rel), "utf8")).join("\n");
    const entryCva = /\bcva\(/.test(text) ? cvaOf(entry.source) : null;
    const hover = entryCva?.variants.variant
      ? Object.fromEntries(Object.entries(entryCva.variants.variant).map(([name, classes]) => [name, stateClasses(classes, "hover")]))
      : stateClasses(text, "hover");
    const focus = stateClasses(entryCva ? entryCva.base : text, "focus-visible");
    const facts = { cva: entryCva, hover, focus };
    writeFile(`specimens/${kebab(entry.name)}.html`, renderSpecimen(entry, facts));
    const contrastRows = entry.contrastFromCva || entry.name === "Button" ? contrastByComponent[entry.name] : null;
    rulesByGroup.get(entry.group).push(demote(renderComponentReadme(entry, facts, exportsMeta, contrastRows)));
  }

  // Assets ------------------------------------------------------------------------------
  const assetLines = ["## Files", "", "In the Assets page of this system."];
  for (const group of ASSETS) {
    assetLines.push("", `**${group.group}**`, "");
    for (const [file, name, usage] of group.files) {
      if (!fs.existsSync(file)) {
        console.warn(`  asset missing: ${file}`);
        continue;
      }
      fs.mkdirSync(path.join(SYSTEM, "assets", group.group), { recursive: true });
      fs.copyFileSync(file, path.join(SYSTEM, "assets", group.group, name));
      assetLines.push(`- \`${group.group}/${name}\`: ${usage}`);
    }
  }
  assetLines.push("", "Full-colour raster marks: use them as they are on light or dark grounds as named; never recolour. No vector (SVG) version of the mark exists in the product or the docs.");

  // Guidelines ---------------------------------------------------------------------------
  const extraFindings = [];
  for (const [component, rows] of Object.entries(contrastByComponent)) {
    const low = rows.flatMap((row) => row.cells.filter((cell) => cell.ratio < 4.5).map((cell) => ({ variant: row.variant, ...cell })));
    if (!low.length) continue;
    const byVariant = new Map();
    for (const cell of low) {
      const list = byVariant.get(cell.variant) ?? [];
      list.push(`${formatRatio(cell.ratio)} on ${cell.ground} in ${cell.theme}`);
      byVariant.set(cell.variant, list);
    }
    extraFindings.push(`${component} labels below 4.5:1: ${[...byVariant].map(([variant, list]) => `\`${variant}\` (${list.join(", ")})`).join("; ")}. See ${component} in the Components · ${CATALOG.find((entry) => entry.name === component)?.group} guideline.`);
  }
  const covered = new Set([...kitSources, ...NOT_CARDED.map(([, source]) => source)]);
  const uncovered = ["src/components/ui", "src/components/common"].flatMap((dir) =>
    fs
      .readdirSync(path.join(FRONTEND, dir))
      .filter((file) => /\.tsx$/.test(file) && !/\.test\.tsx$/.test(file))
      .map((file) => `${dir}/${file}`)
      .filter((rel) => !covered.has(rel))
  );
  const notSynced = [
    ...(uncovered.length ? [`Not yet in the catalog (no specimen): ${uncovered.map((rel) => `\`${rel.replace("src/components/", "")}\``).join(", ")}.`] : []),
    `Components without a specimen: ${NOT_CARDED.map(([name, , why]) => `${name} (${why})`).join("; ")}.`,
    "Fonts: no font files. The product uses the system UI stack; nothing to copy.",
    "`src/index.css`: the `@keyframes` inside `@theme` (accordion, collapsible) and the animation variables have no token family; their durations are under Motion.",
    "Specimens run the real components with sample data.",
    ...drift.map((line) => `Timing drift: ${line}.`),
  ];
  const brandBook = renderBrandBook({ tokens, contrast: tokenResult.contrast, timings, cva, components: CATALOG, reactVersion: tool.reactVersion, notSynced, extraFindings });
  const pages = brandBookPages(brandBook, { "Visual foundations": sizeTable(cva), "Brand assets": assetLines.join("\n") });
  pages.forEach((page, index) => {
    const order = page.order ?? index + 1;
    writeFile(`guidelines/${String(order).padStart(2, "0")}-${kebab(page.title)}.md`, guideline(page.title, order, page.bodies.join("\n\n")));
  });
  groups.forEach((group, index) => {
    const order = 20 + index;
    const intro = `The rules of every ${group.toLowerCase()} component. Live previews: the ${group} group under Components.`;
    writeFile(`guidelines/${order}-components-${kebab(group)}.md`, guideline(`Components · ${group}`, order, [intro, ...rulesByGroup.get(group)].join("\n\n")));
  });

  // system.json ---------------------------------------------------------------------------
  const systemJson = {
    name: TITLE,
    description: brand.tagline || "The Opfield console: flat, square, neutral and calm.",
    stylesheet: path.relative(SYSTEM, path.join(FRONTEND, "src/index.css")),
  };
  writeFile("system.json", `${JSON.stringify(systemJson, null, 2)}\n`);

  const failing = tokenResult.contrast.filter((row) => !row.pass);
  console.log(`  specimens: ${CATALOG.length}; guidelines: ${pages.length + groups.length}; assets: ${ASSETS.reduce((sum, group) => sum + group.files.length, 0)}`);
  console.log(`  contrast: ${failing.length} token pairs below their floor${extraFindings.length ? `; ${extraFindings.length} component variant finding(s)` : ""}`);
  for (const line of [...brand.findings, ...drift]) console.log(`  finding: ${line}`);
}

main();
