// Reads the product's CSS custom properties (src/index.css, src/css/base.css)
// and the Tailwind default theme the product builds on, and turns them into
// the design system's tokens.json, with a usage note and contrast check on
// every colour.

import fs from "node:fs";
import path from "node:path";
import { composite, contrastRatio, formatRatio, parseColor, withAlpha } from "./color.mjs";

/** Content between the brace that opens at `openIndex` and its partner. */
function blockAt(css, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return { body: css.slice(openIndex + 1, i), end: i };
    }
  }
  throw new Error("Unbalanced braces in CSS");
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Top-level rules (depth 0) as { prelude, body }. */
function topLevelRules(css) {
  const rules = [];
  let i = 0;
  let start = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === ";") {
      start = i + 1;
    } else if (ch === "{") {
      const prelude = css.slice(start, i).trim();
      const { body, end } = blockAt(css, i);
      rules.push({ prelude, body });
      i = end;
      start = end + 1;
    }
    i += 1;
  }
  return rules;
}

/** `--name: value;` declarations of a block, ignoring nested blocks (keyframes). */
function declarations(body) {
  const flat = [];
  let depth = 0;
  for (const ch of body) {
    if (ch === "{") depth += 1;
    if (depth === 0) flat.push(ch);
    if (ch === "}") depth -= 1;
  }
  const out = new Map();
  const re = /--([A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
  for (const match of flat.join("").matchAll(re)) {
    out.set(match[1], match[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

export function readProductCss(frontendDir) {
  const indexPath = path.join(frontendDir, "src/index.css");
  const css = stripComments(fs.readFileSync(indexPath, "utf8"));
  const rules = topLevelRules(css);
  const theme = rules.find((rule) => rule.prelude === "@theme");
  const media = rules.find((rule) => /^@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)/.test(rule.prelude));
  const mediaTheme = media ? topLevelRules(media.body).find((rule) => rule.prelude === "@theme") : null;
  const lightClass = rules.find((rule) => rule.prelude === ".light");
  const darkClass = rules.find((rule) => rule.prelude === ".dark");
  if (!theme || !darkClass) throw new Error("src/index.css: expected an @theme block and a .dark block");
  const variant = /@custom-variant\s+dark\s+\(([^;]+)\);/.exec(css)?.[1]?.trim() ?? null;

  const baseCss = stripComments(fs.readFileSync(path.join(frontendDir, "src/css/base.css"), "utf8"));
  const bodyRule = topLevelRules(baseCss).find((rule) => rule.prelude === "body");
  const bodyDecl = {};
  for (const match of (bodyRule?.body ?? "").matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) {
    bodyDecl[match[1]] = match[2].trim();
  }

  return {
    theme: declarations(theme.body),
    mediaDark: mediaTheme ? declarations(mediaTheme.body) : new Map(),
    lightClass: lightClass ? declarations(lightClass.body) : new Map(),
    darkClass: declarations(darkClass.body),
    darkVariant: variant,
    body: bodyDecl,
  };
}

/** The Tailwind default theme (`@theme default`), for type, spacing, shadows and palette. */
export function readTailwindTheme(themeCssPath) {
  const css = stripComments(fs.readFileSync(themeCssPath, "utf8"));
  const rules = topLevelRules(css);
  const block = rules.find((rule) => rule.prelude.startsWith("@theme"));
  return declarations(block.body);
}

function evalLength(value, rootPx = 16) {
  const text = value.trim();
  let match = /^calc\(\s*([\d.]+)\s*\/\s*([\d.]+)\s*\)$/.exec(text);
  if (match) return Number.parseFloat(match[1]) / Number.parseFloat(match[2]);
  match = /^([\d.]+)rem$/.exec(text);
  if (match) return Number.parseFloat(match[1]) * rootPx;
  match = /^([\d.]+)px$/.exec(text);
  if (match) return Number.parseFloat(match[1]);
  return Number.parseFloat(text);
}

function px(value) {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded}px`;
}

/** `rgb(0 0 0 / 0.1)` → `rgba(0, 0, 0, 0.1)`: the syntax every token reader accepts. */
function legacyRgb(value) {
  return value.replace(/rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\s*\)/g, "rgba($1, $2, $3, $4)");
}

// ---------------------------------------------------------------------------
// Where tokens are used
// ---------------------------------------------------------------------------

const UTILITY_PREFIXES = ["bg", "text", "border", "ring", "fill", "stroke", "outline", "divide", "placeholder", "from", "via", "to", "decoration", "shadow", "caret", "accent"];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Reads every product source once; the scans below share it. */
export function loadSources(frontendDir) {
  const srcDir = path.join(frontendDir, "src");
  return walk(srcDir)
    .sort()
    .map((file) => ({ rel: path.relative(frontendDir, file), text: fs.readFileSync(file, "utf8") }));
}

/** How often each utility prefix references a colour name, and in how many files. */
export function colorUsage(sources, colorName) {
  const escaped = colorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\w-])(?:[a-z-]+:)*(${UTILITY_PREFIXES.join("|")})-${escaped}(?:\\/\\d+)?(?![\\w-])|var\\(--color-${escaped}\\)`, "g");
  const byPrefix = {};
  const files = new Set();
  for (const source of sources) {
    for (const match of source.text.matchAll(re)) {
      const prefix = match[1] ?? "var()";
      byPrefix[prefix] = (byPrefix[prefix] ?? 0) + 1;
      files.add(source.rel);
    }
  }
  return { byPrefix, files: [...files] };
}

/** Raw Tailwind palette classes (`text-red-500`) in the given files: they bypass the theme. */
export function rawPaletteUsage(sources, relPaths) {
  const re = /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|from|via|to)-((?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3})(?:\/\d+)?(?![\w-])/g;
  const result = new Map();
  for (const source of sources) {
    if (relPaths && !relPaths.includes(source.rel)) continue;
    for (const match of source.text.matchAll(re)) {
      const entry = result.get(match[1]) ?? { count: 0, files: new Set() };
      entry.count += 1;
      entry.files.add(source.rel);
      result.set(match[1], entry);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Colour notes
// ---------------------------------------------------------------------------

/** What each theme colour is for, in the product's own terms. */
export const COLOR_NOTES = {
  "color-background": "Page background (body) and the fill of inputs, selects, textareas, outline buttons, dialogs and sheets.",
  "color-foreground": "Default text and icons on every ground; also the checked checkbox fill and the text selection.",
  "color-muted": "Quiet fills: table header rows, the section-header band (bg-muted/60 in light, solid in dark), secondary badges, slider track, empty health-bar buckets.",
  "color-muted-foreground": "Secondary text: descriptions, labels, placeholders, table headers, inactive tabs, resting icons.",
  "color-border": "1px borders of cards, panels, tables, tabs and menus; also the scrollbar thumb and progress track.",
  "color-input": "1px borders of form controls: input, textarea, select, outline button, copy and code fields. The divider grey, like tabs and panels: a resting control must not read as focused, and the focus ring carries the state, so it has no 3:1 floor.",
  "color-ring": "Keyboard focus: a 1px ring-ring (inset on text fields).",
  "color-primary": "Ink, not a hue: default button, active tab, switch on, slider range, progress fill, default badge. Near-black in light, white in dark.",
  "color-primary-foreground": "Text and icons on a primary fill.",
  "color-secondary": "Secondary button fill.",
  "color-secondary-foreground": "Text on a secondary fill.",
  "color-accent": "Hover and highlight fill: ghost and outline buttons, menu and select items, clickable table rows, inactive tab hover.",
  "color-accent-foreground": "Text on an accent (hovered) fill.",
  "color-destructive": "Irreversible actions and failures: destructive button fill, text-destructive, the invalid NumericInput border, the destructive status tone and dot.",
  "color-destructive-foreground": "Text on a destructive fill.",
  "color-card": "Cards, panels, tables, stat cards and empty states; the ground most content sits on.",
  "color-card-foreground": "Text on card.",
  "color-popover": "Floating layers: menus, select lists, popovers, tooltips, the command palette.",
  "color-popover-foreground": "Text in floating layers.",
  "color-link": "Links (Button variant link) and the info tone of Notice.",
  "color-success": "Healthy, online, succeeded: status dots (bg-success) and success text.",
  "color-warning": "Degraded and pending attention: the warning button (black text), status dots, a dirty panel's border, and bg-warning/15 tints behind warning text.",
  "color-warning-foreground": "Warning text, on the bg-warning/15 tint (warning badge, one-time-token notice) and on plain grounds.",
  "color-error": "Error text.",
  "color-sidebar-background": "Sidebar ground.",
  "color-sidebar-foreground": "Sidebar text and icons.",
  "color-sidebar-border": "Sidebar dividers.",
  "color-sidebar-accent": "Sidebar hover and the active item.",
  "color-sidebar-accent-foreground": "Text on the sidebar accent.",
  "color-sidebar-primary": "Sidebar primary fill.",
  "color-sidebar-primary-foreground": "Text on the sidebar primary fill.",
  "color-sidebar-ring": "Sidebar focus ring.",
};

/** Grounds each text colour is checked on (4.5:1). */
const TEXT_GROUNDS = {
  "color-foreground": ["color-background", "color-card", "color-popover", "color-muted", "color-accent", "color-secondary"],
  "color-muted-foreground": ["color-background", "color-card", "color-popover", "color-muted", "color-accent"],
  "color-primary-foreground": ["color-primary"],
  "color-secondary-foreground": ["color-secondary"],
  "color-accent-foreground": ["color-accent"],
  "color-destructive-foreground": ["color-destructive-solid"],
  "color-card-foreground": ["color-card"],
  "color-popover-foreground": ["color-popover"],
  "color-link": ["color-background", "color-card"],
  "color-destructive": ["color-background", "color-card"],
  "color-success": ["color-background", "color-card"],
  "color-warning": ["color-background", "color-card"],
  "color-warning-foreground": ["color-background", "color-card", { tint: "color-warning", alpha: 0.15, over: "color-card" }],
  "color-error": ["color-background", "color-card"],
  "color-sidebar-foreground": ["color-sidebar-background", "color-sidebar-accent"],
  "color-sidebar-accent-foreground": ["color-sidebar-accent"],
  "color-sidebar-primary-foreground": ["color-sidebar-primary"],
};

/** Colours that carry meaning without being text (3:1). */
const MARK_GROUNDS = {
  "color-ring": ["color-background", "color-card"],
  "color-sidebar-ring": ["color-sidebar-background"],
};

/** Colours only checked as text when the product actually sets text in them. */
const TEXT_WHEN_USED = new Set(["color-destructive", "color-success", "color-warning", "color-error", "color-link"]);

function groundLabel(ground) {
  if (typeof ground === "string") return ground.replace(/^color-/, "");
  return `${ground.tint.replace(/^color-/, "")}/${Math.round(ground.alpha * 100)} over ${ground.over.replace(/^color-/, "")}`;
}

function resolveGround(ground, values) {
  if (typeof ground === "string") return values.get(ground);
  const tint = values.get(ground.tint);
  const base = values.get(ground.over);
  if (!tint || !base) return null;
  return composite(withAlpha(tint, ground.alpha), base);
}

/**
 * Checks each text colour on its grounds in each theme.
 * @returns {{ token: string, theme: string, ground: string, ratio: number, floor: number, pass: boolean }[]}
 */
export function checkContrast(themes, usageByToken) {
  const results = [];
  for (const theme of themes) {
    const values = new Map([...theme.values].map(([name, value]) => [name, parseColor(value)]));
    const check = (token, grounds, floor) => {
      const fg = values.get(token);
      if (!fg) return;
      for (const ground of grounds) {
        const bg = resolveGround(ground, values);
        if (!bg) continue;
        const ratio = contrastRatio(composite(fg, bg), bg);
        results.push({ token, theme: theme.id, ground: groundLabel(ground), ratio, floor, pass: ratio >= floor });
      }
    };
    for (const [token, grounds] of Object.entries(TEXT_GROUNDS)) {
      if (TEXT_WHEN_USED.has(token) && !(usageByToken.get(token)?.byPrefix.text > 0)) continue;
      check(token, grounds, 4.5);
    }
    for (const [token, grounds] of Object.entries(MARK_GROUNDS)) check(token, grounds, 3);
  }
  return results;
}

function contrastSentence(results, token) {
  const mine = results.filter((result) => result.token === token);
  if (mine.length === 0) return "";
  const floor = mine[0].floor;
  const parts = [];
  for (const themeId of ["light", "dark"]) {
    const rows = mine.filter((result) => result.theme === themeId);
    if (rows.length === 0) continue;
    parts.push(`${themeId} ${rows.map((row) => `${formatRatio(row.ratio)} on ${row.ground}`).join(", ")}`);
  }
  const failing = mine.filter((result) => !result.pass);
  const kind = floor === 3 ? "non-text 3:1" : "text 4.5:1";
  let sentence = `Contrast (${kind}): ${parts.join("; ")}.`;
  if (failing.length > 0) {
    sentence += ` FLAG: below ${floor}:1 ${failing.map((row) => `on ${row.ground} in ${row.theme}`).join(", ")}; kept exact from the product.`;
  }
  return sentence;
}

function usageSentence(usage) {
  const entries = Object.entries(usage.byPrefix).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "No utility class references it in src/.";
  const list = entries
    .slice(0, 4)
    .map(([prefix, count]) => (prefix === "var()" ? `var() ×${count}` : `${prefix}-* ×${count}`))
    .join(", ");
  return `Used as ${list} in ${usage.files.length} files.`;
}

// ---------------------------------------------------------------------------
// tokens.json
// ---------------------------------------------------------------------------

function mapsDiffer(a, b) {
  const diffs = [];
  for (const [name, value] of a) {
    if (!/^color-/.test(name)) continue;
    if (!b.has(name)) diffs.push(`${name} missing`);
    else if (b.get(name).toLowerCase() !== value.toLowerCase()) diffs.push(`${name}: ${value} vs ${b.get(name)}`);
  }
  return diffs;
}

/**
 * Builds tokens.json and the findings the README and report use.
 */
export function buildTokens({ frontendDir, tailwindTheme, product, sources, brandColor, kitSources, meta }) {
  const lightValues = new Map([...product.theme].filter(([name]) => name.startsWith("color-")));
  const darkValues = new Map([...product.darkClass].filter(([name]) => name.startsWith("color-")));
  const consistency = {
    themeVsLightClass: mapsDiffer(product.theme, product.lightClass),
    mediaVsDarkClass: mapsDiffer(product.mediaDark, product.darkClass),
  };

  const usageByToken = new Map();
  for (const name of lightValues.keys()) {
    usageByToken.set(name, colorUsage(sources, name.replace(/^color-/, "")));
  }

  const themes = [
    { id: "light", values: lightValues },
    { id: "dark", values: new Map([...lightValues, ...darkValues]) },
  ];
  const contrast = checkContrast(themes, usageByToken);

  const colorTokens = [];
  for (const [name, light] of lightValues) {
    const dark = darkValues.get(name) ?? light;
    const usage = usageByToken.get(name);
    const note = [COLOR_NOTES[name] ?? "", usageSentence(usage), contrastSentence(contrast, name)]
      .filter(Boolean)
      .join(" ");
    colorTokens.push({
      name,
      value: { light: light.toLowerCase(), dark: dark.toLowerCase() },
      usage: note.slice(0, 1000),
    });
  }

  if (brandColor) {
    colorTokens.push({
      name: "theme-color",
      value: brandColor.value.toLowerCase(),
      usage: `The brand indigo, from ${brandColor.sources.join(" and ")}: browser chrome, Windows tiles and the shield of the mark. Never an interface colour: the product UI stays neutral and uses color-primary (ink) for emphasis. Same value in both themes.`,
    });
  }

  // Raw Tailwind palette colours the kit paints with: not themeable, listed so
  // their contrast is visible and so they read as debt against the token rule.
  const palette = rawPaletteUsage(sources, kitSources);
  const paletteTokens = [...palette.keys()].sort().map((shade) => {
    const value = tailwindTheme.get(`color-${shade}`);
    const entry = palette.get(shade);
    return {
      name: `color-${shade}`,
      // oklch(70.4% …) → oklch(0.704 …): the same colour with plain numeric arguments.
      value: value?.replace(/^oklch\(\s*([\d.]+)%/, (_, l) => `oklch(${Number((Number(l) / 100).toFixed(4))}`),
      usage: `Raw Tailwind palette, not a theme token: ${entry.count} class reference(s) in ${[...entry.files].map((file) => path.basename(file)).join(", ")}. The rc.10 rule asks for theme tokens instead; kept here because the product paints with it.`,
    };
  }).filter((token) => token.value);
  colorTokens.push(...paletteTokens);

  // Type: the Tailwind scale the product uses, with the product's own roles.
  const size = (key) => px(evalLength(tailwindTheme.get(`text-${key}`)));
  const lineHeight = (key) => px(evalLength(tailwindTheme.get(`text-${key}`)) * evalLength(tailwindTheme.get(`text-${key}--line-height`)));
  const weight = (key) => Number(tailwindTheme.get(`font-weight-${key}`));
  const tracking = (key) => tailwindTheme.get(`tracking-${key}`);
  const bodyTracking = product.body["letter-spacing"] ?? "normal";

  const sansStack = (product.body["font-family"] ?? tailwindTheme.get("font-sans")).replace(/\s+/g, " ");
  const monoStack = tailwindTheme.get("font-mono").replace(/\s+/g, " ");

  const type = {
    fonts: [],
    families: { sans: sansStack, mono: monoStack },
    groups: [
      {
        name: "Interface",
        family: "sans",
        note: `One sans stack for everything: the system UI face, no font files shipped. Body letter-spacing ${bodyTracking}.`,
        styles: [
          { name: "page-title", fontSize: size("2xl"), lineHeight: lineHeight("2xl"), fontWeight: weight("bold"), letterSpacing: bodyTracking, sample: "Routes", usage: "PageHeader title (h1, text-2xl font-bold). One per page." },
          { name: "dialog-title", fontSize: size("lg"), lineHeight: size("lg"), fontWeight: weight("semibold"), letterSpacing: tracking("tight"), sample: "Remove Volume", usage: "DialogTitle and SheetTitle (text-lg font-semibold leading-none tracking-tight)." },
          { name: "stat-value", fontSize: size("xl"), lineHeight: lineHeight("xl"), fontWeight: weight("bold"), letterSpacing: bodyTracking, sample: "42", usage: "StatCard value (text-xl; text-2xl on the dashboard)." },
          { name: "body-base", fontSize: size("base"), lineHeight: lineHeight("base"), fontWeight: weight("normal"), letterSpacing: bodyTracking, sample: "Route incoming domain traffic to services", usage: "The body default (16px). Rare in components; long-form text only." },
          { name: "body", fontSize: size("sm"), lineHeight: lineHeight("sm"), fontWeight: weight("normal"), letterSpacing: bodyTracking, sample: "At least one active route has not received its current certificate.", usage: "The interface text size (text-sm): table cells, form fields, menu items, page descriptions." },
          { name: "label", fontSize: size("sm"), lineHeight: lineHeight("sm"), fontWeight: weight("medium"), letterSpacing: bodyTracking, sample: "Save changes", usage: "Buttons at every size, tabs, field labels, settings row titles (text-sm font-medium)." },
          { name: "section-title", fontSize: size("sm"), lineHeight: lineHeight("sm"), fontWeight: weight("semibold"), letterSpacing: bodyTracking, sample: "Health checks", usage: "SectionHeader and panel titles (h3, text-sm font-semibold)." },
          { name: "caption", fontSize: size("xs"), lineHeight: lineHeight("xs"), fontWeight: weight("normal"), letterSpacing: bodyTracking, sample: "Maximum available now: 12 GB", usage: "Dense descriptions, hints under fields, section descriptions (text-xs, muted)." },
          { name: "table-header", fontSize: size("xs"), lineHeight: lineHeight("xs"), fontWeight: weight("medium"), letterSpacing: tracking("wider"), sample: "STATUS", usage: "Table and list column headers: text-xs font-medium uppercase tracking-wider, muted." },
          { name: "badge", fontSize: "11px", lineHeight: "11px", fontWeight: weight("semibold"), letterSpacing: tracking("wider"), sample: "ONLINE", usage: "Badge text: text-[11px] font-semibold uppercase tracking-wider leading-none. The one arbitrary size left in the kit." },
        ],
      },
      {
        name: "Code",
        family: "mono",
        styles: [
          { name: "code", fontSize: size("sm"), lineHeight: lineHeight("sm"), fontWeight: weight("normal"), sample: "proxy_pass http://upstream;", usage: "Tokens, IDs, config and template variables (font-mono, text-sm; text-xs in ReferenceTable)." },
          { name: "log-line", fontSize: size("xs"), lineHeight: "20px", fontWeight: weight("normal"), sample: "2026-09-26T10:00:01Z nginx reloaded", usage: "Log viewers and VirtualLogList rows (text-xs leading-5)." },
        ],
      },
    ],
  };

  const spacingBase = tailwindTheme.get("spacing");
  const basePx = evalLength(spacingBase);
  const step = (n, usage) => ({ name: `spacing-${String(n).replace(".", "_")}`, value: px(basePx * n), usage });
  const spacing = {
    note: `One base, --spacing: ${spacingBase} (${px(basePx)}); every step is a multiple (Tailwind p-4 = 4 × base).`,
    tokens: [
      { name: "spacing", value: spacingBase, usage: "The base unit every Tailwind spacing, size and gap utility multiplies." },
      step(0.5, "Hairline offsets (top-px thumb inset, mt-0.5 under a title)."),
      step(1, "Icon-to-text in dense rows (gap-1), label-to-hint."),
      step(1.5, "Label-to-field stacks (space-y-1.5), menu item padding-y (py-1.5)."),
      step(2, "Button and header gaps (gap-2), item padding-x (px-2)."),
      step(3, "Input padding-x (px-3), panel row padding (px-4 py-3 uses 3 vertically), list cells (p-3)."),
      step(4, "Card and panel padding (p-4), gap between page sections (space-y-4), table cell padding-x (px-4)."),
      step(6, "Page padding (p-6 / px-6 pt-6), dialog padding at sm and up (sm:px-6)."),
      step(8, "Large button padding-x (px-8), embedded empty state padding-y (py-8)."),
      step(12, "Empty state padding-y (py-12); dialog top offset (sm:py-12)."),
    ],
  };

  const radius = {
    note: "Square everywhere. The product sets every radius token to 0, so rounded-* utilities draw square corners.",
    tokens: [...product.theme]
      .filter(([name]) => name.startsWith("radius-"))
      .map(([name, value]) => ({ name, value, usage: `Tailwind rounded-${name.replace("radius-", "")}: 0 in this product, so cards, controls, badges and menus stay square.` })),
  };

  const shadowUse = {
    "shadow-xs": "Select trigger (shadow-xs).",
    "shadow-sm": "Dropdown menus, slider thumb, dark-theme tooltips.",
    "shadow-md": "Popovers and select lists.",
    "shadow-lg": "Dialogs, sheets, the drag overlay row.",
    "shadow-xl": "The command palette dialog.",
  };
  const shadow = {
    note: "Flat by default: borders separate surfaces; shadows appear only under floating layers.",
    tokens: Object.entries(shadowUse).map(([name, usage]) => ({ name, value: legacyRgb(tailwindTheme.get(name)), usage })),
  };
  shadow.tokens.push({ name: "shadow-tooltip", value: "0 1px 2px rgba(0, 0, 0, 0.04)", usage: "Tooltip in light theme (shadow-[0_1px_2px_rgba(0,0,0,0.04)]); dark uses shadow-sm." });

  return {
    tokens: {
      name: "Opfield",
      version: 1,
      meta,
      color: { themes: [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }], tokens: colorTokens },
      type,
      spacing,
      radius,
      shadow,
    },
    contrast,
    consistency,
    usageByToken,
    palette,
  };
}
