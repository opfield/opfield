// project/README.md: the brand book. Prose is the product's rules; every
// value, name and number in it is read from the sources at export time.

import { formatRatio } from "./lib/color.mjs";

function valueOf(tokens, name, theme = "light") {
  const token = tokens.color.tokens.find((entry) => entry.name === name);
  if (!token) return "?";
  return typeof token.value === "string" ? token.value : token.value[theme];
}

function styleOf(tokens, name) {
  for (const group of tokens.type.groups) {
    const style = group.styles.find((entry) => entry.name === name);
    if (style) return style;
  }
  return null;
}

function failingPairs(contrast) {
  return contrast
    .filter((row) => !row.pass)
    .sort((a, b) => a.theme.localeCompare(b.theme) || a.ratio - b.ratio);
}

export function renderBrandBook({ tokens, contrast, timings, cva, components, reactVersion, notSynced, extraFindings }) {
  const t = (name, theme) => `\`${valueOf(tokens, name, theme)}\``;
  const colorRows = tokens.color.tokens
    .filter((token) => typeof token.value === "object" && token.name.startsWith("color-") && !/-\d{2,3}$/.test(token.name))
    .map((token) => `| \`${token.name}\` | \`${token.value.light}\` | \`${token.value.dark}\` |`)
    .join("\n");
  const typeRows = tokens.type.groups
    .flatMap((group) => group.styles)
    .map((style) => `| \`${style.name}\` | ${style.fontSize} / ${style.lineHeight} | ${style.fontWeight} | ${style.usage} |`)
    .join("\n");
  const fails = failingPairs(contrast);
  const failRows = fails
    .map((row) => `| ${row.theme} | \`${row.token}\` on \`${row.ground}\` | ${formatRatio(row.ratio)} | ${row.floor}:1 |`)
    .join("\n");
  const buttonVariants = Object.keys(cva.button.variants.variant).map((name) => `\`${name}\``).join(", ");
  const buttonSizes = Object.entries(cva.button.variants.size)
    .map(([name, classes]) => `\`${name}\` (${classes.split(" ").filter((c) => /^h-/.test(c)).join(" ")})`)
    .join(", ");
  const badgeVariants = Object.keys(cva.badge.variants.variant).map((name) => `\`${name}\``).join(", ");
  const groups = [...new Set(components.map((component) => component.group))];
  const componentIndex = groups
    .map((group) => `- **${group}:** ${components.filter((component) => component.group === group).map((component) => component.name).join(", ")}`)
    .join("\n");
  const pageTitle = styleOf(tokens, "page-title");

  return `Opfield is an infrastructure control plane: nodes, routes, containers, certificates, databases, logs. Its interface is a working tool that stays open all day, so it is **flat, square, neutral and calm**: ink on light grey, or light grey on near-black; 1px borders instead of shadows; no rounded corners; colour only where it means a status. Nothing moves after it appears.

Build with the real components (the kit in \`src/components/ui\`, the shared pieces in \`src/components/common\`) and the tokens in these pages. Every rule here comes from the product code.

## Visual foundations

### Colour

The palette is neutral first. \`color-primary\` is ink, not a hue: ${t("color-primary")} in light, ${t("color-primary", "dark")} in dark. The brand indigo \`theme-color\` (${t("theme-color")}) lives only in the mark, the browser chrome and the Windows tiles; never paint interface elements with it.

- Page on \`color-background\`; content blocks (panels, tables, cards) on \`color-card\`; floating layers on \`color-popover\`.
- Text in \`color-foreground\`; secondary text in \`color-muted-foreground\`.
- Borders are 1px \`color-border\`; form controls use \`color-input\`.
- Hover and highlight fill \`color-accent\`; quiet fills \`color-muted\` (table headers, section bands).
- Emphasis is ink: the default button, the active tab, a switch that is on.
- Themes: light and dark, switched by a \`light\` or \`dark\` class on \`<html>\` (the user picks light, dark or system). Every token has both values; Tailwind \`dark:\` variants key off the same class.

| Token | Light | Dark |
| --- | --- | --- |
${colorRows}

### Status colour

A status is a word first and a colour second. Use \`Badge\` variants (${badgeVariants}) or \`StatusBadge\`, and the tone helpers of \`resource-status.ts\` (\`nodeStatusTone\`, \`proxyHealthTone\`, \`databaseHealthTone\`, \`dockerStateTone\`, \`statusDotClass\`), so a status has one colour everywhere:

- **success**: online, running, healthy, active. **warning**: degraded, recovering, transitional (deploying, restarting), expiring. **destructive**: offline, failed, exited, revoked. **secondary**: unknown, stopped, pending, counts. **info**: neutral information with a hue. **outline**: types and labels.
- Tokens for status outside badges: \`text-success\`, \`text-warning-foreground\` on \`bg-warning/15\`, \`text-destructive\`, dots \`bg-success\` / \`bg-warning\` / \`bg-destructive\`.
- Never a raw palette class (\`text-red-500\`, \`bg-blue-500\`) where a token exists; raw hues stay only in charts, sparklines and syntax highlighting.
- Success green and destructive red differ mostly by hue: always pair them with the word.

### Contrast

Text meets 4.5:1 and meaningful marks 3:1 on the grounds their notes name, checked in both themes. These product pairs fall short today and are kept exact; do not add new uses of them on these grounds:

| Theme | Pair | Ratio | Needs |
| --- | --- | --- | --- |
${failRows}

${extraFindings.length ? `${extraFindings.map((line) => `- ${line}`).join("\n")}\n` : ""}
### Typography

One sans stack, \`${tokens.type.families.sans}\`, and the Tailwind mono stack for code. It is the system UI face and no font file ships; design with that in mind. The body is 16px with \`${styleOf(tokens, "body").letterSpacing}\` letter-spacing; the interface text size is \`body\` (14px).

| Style | Size / line | Weight | Use |
| --- | --- | --- | --- |
${typeRows}

- Use only \`text-xs\`, \`text-sm\`, \`text-base\` and the heading sizes above. No arbitrary sizes (\`text-[11px]\`, \`text-[13px]\`); the badge is the one exception left in the kit.
- Every button size keeps the same text (\`label\`, 14px medium); smaller buttons are only lower.
- One \`page-title\` (${pageTitle.fontSize} bold) per page, in \`PageHeader\`. Panels title in \`section-title\`; dialogs in \`dialog-title\`.
- Descriptions: \`text-sm text-muted-foreground\` under a page title, \`text-xs text-muted-foreground\` in dense cards and panel headers.
- Column headers: \`text-xs font-medium uppercase tracking-wider\`, muted.

### Spacing and layout

- One base unit: \`spacing\` (${tokens.spacing.tokens[0].value}); every size is a multiple.
- Page: \`px-6 pt-6 pb-3\` (24px), sections \`space-y-4\` (16px) apart, \`PageHeader\` first.
- Panels: \`PanelShell\` = border, \`color-card\`, a \`SectionHeader\` band with \`p-4\`; rows \`px-4 py-3\`.
- Controls are 36px high (\`h-9\`): inputs, selects, default buttons. Button sizes: ${buttonSizes}.
- Tables: header \`px-4 py-3\` on \`color-muted\`; rows 49px (\`DataTable\`) or 52px (resource lists).
- Below 640px the page padding drops to 12px, dialogs become bottom sheets and scrollbars hide.

### Shape, borders and elevation

- **Radius 0 everywhere.** \`radius-sm\` … \`radius-xl\` are 0, so even \`rounded-lg\` draws a square corner. Never introduce a radius.
- Surfaces are separated by 1px borders, not shadows. Shadows appear only under floating layers: \`shadow-sm\` menus, \`shadow-md\` popovers and select lists, \`shadow-lg\` dialogs and sheets, \`shadow-xl\` the command palette.
- Overlays: dialogs on \`bg-black/50\`, sheets on \`bg-black/80\`.
- Checkboxes are square, 16px, with a 2px border that turns ink when checked.

### Iconography

- lucide-react only, at 16px (\`size-4\`) in buttons, menus and rows, 14px (\`h-3.5 w-3.5\`) inside dense fields, 24px for a standalone spinner. Default stroke; icons take the text colour.
- Put icons before labels. Icon-only buttons carry an \`aria-label\` and usually a tooltip.
- No emoji in the interface.

### Motion

- Easing \`cubic-bezier(0.25, 0.1, 0.25, 1)\` throughout. Menus and tooltips fade in 120ms; dialogs rise 12px and fade in 200ms (250ms as a bottom sheet); sheets slide in 300ms and out 200ms; collapsibles 200ms; \`AnimatedHeight\` 250ms.
- Reduced motion turns off the reveal stagger, the dialog growth and decorative animations.

## Interaction

- **Hover:** \`color-accent\` fill on ghost and outline buttons, menu items and clickable rows; filled buttons lighten to 90% (\`hover:bg-primary/90\`).
- **Focus:** a 1px \`color-ring\` ring (\`focus-visible:ring-1 ring-ring\`), inset on text fields. Keyboard focus must always be visible: \`Slider\` and \`Switch\` have no ring of their own today.
- **Disabled:** 50% opacity, no pointer events. Disabled menu items stay visible with a reason in their title.
- **Pending:** every create, save, delete or apply button passes \`pending={isSaving}\`: disabled, spinner in place of its leading icon, width unchanged. A second click cannot submit twice. No hand-made spinner-plus-disabled.
- **Destructive actions** go through \`confirmAction()\` (\`ConfirmDialog\`): the dialog stays open with a pending confirm until the action finishes.
- **Results** of actions are toasts (\`toast.success\`, \`toast.error\`); form errors stay in the form.

## Loading: the reveal pipeline

The interface never shows half-loaded content and nothing jumps after it appears.

1. **Pages and tabs** render inside a gate (\`PageTransition\`; every \`TabsContent\`). While anything inside reports loading, the gate stays blank for up to **${timings.PAGE_LOADER_DELAY_MS} ms**. Ready by then: the content appears at once. Slower: a \`ContentLoader\` shows and stays at least **${timings.PAGE_LOADER_MIN_MS} ms**.
2. **Reveal:** the sections come in one after another, each fading up 6px over ${timings.REVEAL_DURATION_MS} ms, ${timings.REVEAL_STEP_MS} ms apart, at most ${timings.REVEAL_MAX_STAGGERED} steps.
3. **Dialogs** open complete, never with a loader inside. While a dialog's data loads it stays hidden: the button that opened it shows a spinner (\`data-dialog-opening\`); with no opener button, after **${timings.DIALOG_WAIT_INDICATOR_DELAY_MS} ms** the screen dims with a centred spinner that stays at least ${timings.DIALOG_WAIT_INDICATOR_MIN_MS} ms. After ${timings.DIALOG_MAX_WAIT_MS} ms the dialog opens anyway.
4. **Report** every request the first render depends on with \`useContentLoading(isLoading)\` (or \`<ContentLoading loading />\` inside a gate you render yourself), including follow-up requests; the gate waits ${timings.SETTLE_MS} ms after the last one for the next. The flag is true from the first render (\`useState(true)\` or "no data yet").
5. **Never report** background refreshes, polling or realtime updates: after the reveal they update in place. Cached store data shows at once.
6. **Spinners** only for in-place actions (\`Button pending\`) and explicitly incremental content (infinite lists, log streams, search results after typing): \`LoadingSpinner\`. No "Loading…" placeholders, no grey skeleton blocks.

## Writing

The voice is plain, technical and brief: name the object and what happened. No exclamation marks, no emoji, no "please", no apologies.

- **Page titles** are the object in the plural or the resource's own name: "Routes", "Dashboard", "api.example.com". **Descriptions** are one line without a period: "Route incoming domain traffic to services", "Routes, certificates and nodes at a glance".
- **Dialog titles** name the action and the object; resource actions are in Title Case, the majority form: "Add Node", "Remove Volume", "Revoke CA". Descriptions are sentences.
- **Buttons** are verbs: "Save", "Create", "Remove", "Add Route". Confirm buttons repeat the verb of the title ("Revoke CA"), never "OK" or "Yes".
- **Confirmations** state the consequence: \`Remove volume "pgdata"? Any data stored in this volume will be permanently lost.\` Add "This action cannot be undone." only when it is true.
- **Toasts:** success in past tense, no period: "Folder created", "Template deleted", "Provider connected", "Copied". Errors start with "Failed to": "Failed to load Docker nodes", "Failed to copy".
- **Empty states:** what is missing, with a period, then an action if the user may act: "No routes. Add one", "No incidents.", "No PostgreSQL extensions match your search."
- **Notices** state the condition, then what it affects: "TLS certificate distribution needs attention" / "At least one active route has not received its current certificate."
- Numbers with units and no ambiguity: "412 GB free", "8 cores", "Next attempt 26 Sep 2026, 14:00".

## Do and don't

**Do** mark a mutation pending with the button itself:

\`\`\`tsx
<Button pending={isSaving} onClick={save}>Save</Button>
\`\`\`

**Don't** hand-roll the spinner and the disabled state:

\`\`\`tsx
<Button disabled={isSaving}>{isSaving && <Loader2 className="animate-spin" />}Save</Button>
\`\`\`

**Do** pick an icon button size: \`<Button variant="ghost" size="icon-sm" aria-label="Delete"><Trash2 /></Button>\`. **Don't** override it: \`size="icon" className="h-8 w-8 text-xs"\`.

**Do** colour a status with a Badge variant from a tone helper: \`<Badge variant={nodeStatusTone(node.status)}>{node.status}</Badge>\`. **Don't** keep a per-page map of palette classes: \`{ online: "text-emerald-500", offline: "text-red-500" }\`.

**Do** use a token: \`text-destructive\`, \`text-muted-foreground\`, \`bg-warning/15 text-warning-foreground\`. **Don't** use raw palette classes such as \`text-red-500\` or \`bg-blue-500\` outside charts and syntax colours.

**Do** report the first load and let the gate handle it:

\`\`\`tsx
const [loading, setLoading] = useState(true);
useContentLoading(loading);
\`\`\`

**Don't** return \`<LoadingSpinner />\` or "Loading…" from a page, tab or dialog body for its first load, and don't report polling refreshes.

**Do** render lists with \`DataTable\`, \`SimpleTable\` or \`ResourceListForm\`, and emptiness with \`EmptyState\`. **Don't** hand-roll \`<table>\` markup or an ad-hoc "Nothing here" paragraph.

**Do** use \`PageHeader\` for the title row. **Don't** write your own \`<h1 className="text-2xl font-bold">\`.

## Brand assets

- **Mark:** a shield split in two indigo halves with a four-point star cut out, on a light rounded tile. It is the product icon: the sidebar shows it at 20px (\`opfield-mark-192.png\`, served as \`android-chrome-192x192.png\`), browsers and devices use the favicons and touch icons.
- **Lockups:** the mark beside the lowercase wordmark "opfield" set in a bold sans, for light grounds (ink wordmark) and dark grounds (white wordmark on a rounded black plate).
- Use the files as they are: never redraw, recolour, stretch or crop the mark, and never set the wordmark in the interface font. There is no vector version; use the 512px PNG where a large mark is needed.
- The name is "Opfield" in titles and running product copy ("Opfield renews it automatically before it expires"); only the logo wordmark is lowercase "opfield".
- **Editions:** four licence badges (personal, community, business, enterprise), 128px tiles shown in the licence settings.

## Components

Every component page renders the real sources (React ${reactVersion}) through \`scripts/design-system/prelude.ts\`. By group:

${componentIndex}

## Not synced

${notSynced.map((line) => `- ${line}`).join("\n")}
`;
}
