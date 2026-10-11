// Catalog: status, data visualisation and the loading pipeline.

const json = (value) => JSON.stringify(value);

export const statusAndLoading = [
  {
    name: "Badge",
    group: "Status",
    source: "src/components/ui/badge.tsx",
    exports: ["Badge"],
    height: 360,
    width: 960,
    contrastFromCva: true,
    summary: "One or two uppercase words of status or type, on a tinted square: the only way the product colours a status.",
    guide: `
## Use it for
Statuses (online, expired, failed), types (proxy, redirect) and counts. Map a resource status to a variant with the tone helpers (\`nodeStatusTone\`, \`dockerStateTone\`, … see \`StatusBadge\`); never build a per-page colour map.

## Rules
- Variants mean: \`success\` healthy, running, active; \`warning\` degraded, transitional, expiring; \`destructive\` offline, failed, revoked; \`info\` neutral information with a hue; \`secondary\` unknown, stopped, counts; \`outline\` types and labels; \`default\` (ink) for emphasis, rarely.
- Size \`inline\` (20px, a \`span\`) only when the badge shares a line with running text; standalone badges keep \`default\` (24px).
- Text is \`text-[11px] font-semibold uppercase tracking-wider\`; write the label in plain case, CSS uppercases it.
- Long labels truncate; do not wrap badges.

## The consumer provides
Children (the label, optionally an icon), \`variant\`, \`size\`.
`,
    preview: (f) => `
var VARIANTS = ${json(Object.keys(f.cva.variants.variant))};
var LABELS = { default: "Primary", secondary: "Stopped", destructive: "Offline", outline: "Proxy", success: "Online", warning: "Degraded", "warning-solid": "Expiring", info: "Syncing" };
function grid(ground) {
  return h("div", { className: "space-y-2 p-3 " + ground },
    row(ground === "bg-card" ? "on card" : "on page", VARIANTS.map(function (v) { return h(G.Badge, { key: v, variant: v }, LABELS[v] || v); })),
    row("inline", VARIANTS.map(function (v) { return h(G.Badge, { key: v, variant: v, size: "inline" }, LABELS[v] || v); }))
  );
}
mount(stage(
  grid("bg-background"),
  h("div", { className: "border border-border" }, grid("bg-card")),
  h("p", { className: "text-sm" }, "Routes ", h(G.Badge, { variant: "secondary", size: "inline" }, "12"), " in this folder; one is ", h(G.Badge, { variant: "destructive", size: "inline" }, "Offline"), ".")
));
`,
  },
  {
    name: "StatusBadge",
    group: "Status",
    source: "src/components/common/StatusBadge.tsx",
    extraSources: ["src/components/common/resource-status.ts"],
    exports: ["StatusBadge", "nodeStatusTone", "proxyHealthTone", "databaseHealthTone", "dockerStateTone", "isDockerStateTransitional", "statusDotClass"],
    height: 420,
    width: 760,
    summary: "Certificate and token status as a Badge, and the resource tone helpers that give every status in the product one colour, as a Badge variant or a status dot.",
    guide: `
## Use it for
\`StatusBadge\` renders active, revoked and expired states (anything else as a secondary badge with the raw word). The helpers in \`resource-status.ts\` map resource states to a tone that is also a \`Badge\` variant, the same on dashboard cards, pinned sidebar items and lists:

- \`nodeStatusTone\`: online → success, degraded → warning, offline and error → destructive, anything else → secondary.
- \`proxyHealthTone\`: online → success, recovering → warning, offline and degraded → destructive.
- \`databaseHealthTone\`: online → success, degraded → warning, offline → destructive.
- \`dockerStateTone\`: running, healthy, succeeded → success; failed, dead, exited → destructive; degraded and every transitional state (stopping, restarting, deploying, building, …) → warning.
- \`statusDotClass(tone)\`: the \`bg-success\` / \`bg-warning\` / \`bg-destructive\` / \`bg-muted-foreground/40\` class of a small square dot.

## Rules
- A status always carries its word (badge label, or the dot beside a name). Colour alone never carries status: success and destructive differ mostly by hue.
- Note that a proxy's \`degraded\` is destructive while a node's \`degraded\` is warning; use the helper for the resource, not a guess.

## The consumer provides
\`status\` and optional \`size\` for \`StatusBadge\`; the raw state string for the helpers.
`,
    preview: () => `
var ROWS = [
  ["Node", ["online", "degraded", "offline", "pending"], G.nodeStatusTone],
  ["Route health", ["online", "recovering", "degraded", "offline", "unknown"], G.proxyHealthTone],
  ["Database", ["online", "degraded", "offline", "unknown"], G.databaseHealthTone],
  ["Container", ["running", "restarting", "exited", "created"], G.dockerStateTone]
];
mount(stage(
  row("StatusBadge", ["active", "revoked", "expired", "pending"].map(function (s) { return h(G.StatusBadge, { key: s, status: s }); })),
  ROWS.map(function (r) {
    return row(r[0], r[1].map(function (s) {
      var tone = r[2](s);
      return h("span", { key: s, className: "inline-flex items-center gap-2" }, h(G.Badge, { variant: tone }, s), h("span", { className: "inline-flex items-center gap-1.5 text-sm" }, h("span", { className: "h-2 w-2 " + G.statusDotClass(tone) }), s));
    }));
  })
));
`,
  },
  {
    name: "HealthBars",
    group: "Status",
    source: "src/components/ui/health-bars.tsx",
    exports: ["HealthBars"],
    height: 340,
    width: 760,
    summary: "The uptime strip: one 6px bar per five-minute bucket, green when every check passed, warning when some failed or were slow, red when all failed.",
    guide: `
## Use it for
Health history of routes, nodes and status-page components. The bar count follows the width (up to 192 bars); the newest bar reflects the current status at once.

## Rules
- Empty buckets are \`bg-muted\`; a stopped resource shows empty bars, not red ones.
- Labels ("N hours ago", "Now") show below by default; hide them in dense rows.
- Its colours are raw palette (\`bg-emerald-500\`, \`bg-red-400\`) next to the \`bg-warning\` token: a known gap against the token rule.

## The consumer provides
\`history\` (\`{ ts, status, slow? }\`), \`currentStatus\`, optional \`bucketMs\`, \`barWidth\`, \`barHeight\`, \`showLabels\`.
`,
    preview: () => `
var BUCKET = 5 * 60 * 1000;
function makeHistory(pattern) {
  var now = Date.now(), out = [];
  for (var i = 0; i < 150; i += 1) {
    var status = pattern(i);
    if (!status) continue;
    out.push({ ts: new Date(now - i * BUCKET).toISOString(), status: status === "slow" ? "online" : status, slow: status === "slow" });
  }
  return out;
}
mount(stage(
  h("div", { className: "space-y-1" }, h("p", { className: "text-sm font-medium" }, "api.example.com · healthy"), h(G.HealthBars, { history: makeHistory(function () { return "online"; }), currentStatus: "online" })),
  h("div", { className: "space-y-1" }, h("p", { className: "text-sm font-medium" }, "edge-2 · flapping"), h(G.HealthBars, { history: makeHistory(function (i) { return i % 17 === 3 ? "offline" : i % 11 === 5 ? "slow" : i > 60 && i < 70 ? "offline" : "online"; }), currentStatus: "recovering" })),
  h("div", { className: "space-y-1" }, h("p", { className: "text-sm font-medium" }, "docker-1 · offline, then no data"), h(G.HealthBars, { history: makeHistory(function (i) { return i < 20 ? "offline" : i < 90 ? "online" : null; }), currentStatus: "offline" })),
  h("div", { className: "space-y-1" }, h("p", { className: "text-sm font-medium" }, "Dense, no labels"), h(G.HealthBars, { history: makeHistory(function () { return "online"; }), currentStatus: "online", barHeight: "h-3", showLabels: false }))
));
`,
  },
  {
    name: "ProgressBar",
    group: "Status",
    source: "src/components/ui/progress-bar.tsx",
    exports: ["ProgressBar"],
    height: 200,
    summary: "A 6px bar on a color-border track, ink by default, clamped to 0–100.",
    guide: `
## Use it for
Usage against a limit (disk, memory, quota) and task progress. Colour the fill with a token when it crosses a threshold: \`var(--color-warning)\`, \`var(--color-destructive)\`.

## The consumer provides
\`value\` (0–100), optional \`indicatorColor\` or \`indicatorClassName\`.
`,
    preview: () => `
function P(label, value, color) { return h("div", { className: "w-96 space-y-1.5" }, h("div", { className: "flex justify-between text-sm" }, h("span", null, label), h("span", null, value + "%")), h(G.ProgressBar, { value: value, indicatorColor: color })); }
mount(stage(P("Memory", 32), P("Disk", 81, "var(--color-warning)"), P("Quota", 97, "var(--color-destructive)"), P("Done", 100)));
`,
  },
  {
    name: "Sparkline",
    group: "Status",
    source: "src/components/ui/sparkline.tsx",
    exports: ["Sparkline"],
    height: 180,
    summary: "A 32px trend line with a 10% area fill, scaled from zero, for a metric's recent history.",
    guide: `
## Use it for
The history under a StatCard and inline trends in tables. Pass \`maxValue\` for metrics with a known ceiling (memory, disk) so the line shows usage, not noise.

## Rules
- Colour is \`currentColor\` unless set; use a token (\`var(--color-primary)\`, \`var(--color-success)\`). Data visualisation is the one place raw hues may appear.

## The consumer provides
\`data\`, optional \`width\`, \`height\`, \`color\`, \`fillOpacity\`, \`minValue\`, \`maxValue\`, \`className\`.
`,
    preview: () => `
var CPU = [12, 18, 15, 22, 30, 26, 41, 38, 35, 29, 33, 45, 52, 48, 40, 36, 31, 34, 28, 25];
var MEM = [61, 61, 62, 62, 63, 63, 64, 64, 64, 65, 65, 66, 66, 66, 67, 67, 67, 68, 68, 68];
mount(stage(
  row("default", h("div", { className: "w-72 text-foreground" }, h(G.Sparkline, { data: CPU, className: "w-full" }))),
  row("success", h("div", { className: "w-72" }, h(G.Sparkline, { data: CPU, color: "var(--color-success)", className: "w-full" }))),
  row("max 100", h("div", { className: "w-72" }, h(G.Sparkline, { data: MEM, maxValue: 100, color: "var(--color-primary)", className: "w-full" })))
));
`,
  },
  {
    name: "StatCard",
    group: "Status",
    source: "src/components/ui/stat-card.tsx",
    exports: ["StatCard"],
    height: 240,
    width: 900,
    summary: "A bordered card with a label and icon, a bold value, an optional progress bar and subtitle, and a sparkline of its history along the bottom edge.",
    guide: `
## Use it for
Metrics on the dashboard (\`appearance="dashboard"\`: larger label and value) and on node and container detail pages (default, denser).

## Rules
- Warn with a token colour: \`valueColor="var(--color-warning)"\` or a \`progress.color\`.
- The default appearance's subtitle is \`text-[10px]\`, below the kit's smallest size: a known gap against the typography rule.

## The consumer provides
\`label\`, \`value\` (a formatted string), \`icon\` (a lucide component), optional \`history\`, \`color\`, \`subtitle\`, \`progress\`, \`sparklineMax\`, \`valueColor\`, \`appearance\`.
`,
    preview: () => `
var H = [12, 18, 15, 22, 30, 26, 41, 38, 35, 29, 33, 45, 52, 48, 40, 36, 31, 34, 28, 25];
mount(stage(h("div", { className: "grid grid-cols-4 gap-4" },
  h(G.StatCard, { label: "Nodes", value: "12", icon: I.Server, subtitle: "11 online, 1 degraded", appearance: "dashboard" }),
  h(G.StatCard, { label: "CPU", value: "34%", icon: I.Cpu, history: H, sparklineMax: 100, subtitle: "8 cores" }),
  h(G.StatCard, { label: "Memory", value: "6.1 GB", icon: I.Activity, progress: { percent: 38 }, subtitle: "of 16 GB" }),
  h(G.StatCard, { label: "Disk", value: "91%", icon: I.HardDrive, progress: { percent: 91, color: "var(--color-warning)" }, valueColor: "var(--color-warning)", subtitle: "412 GB free" })
)));
`,
  },
  {
    name: "ManagedCertificateNotice",
    group: "Status",
    source: "src/components/common/ManagedCertificateStatus.tsx",
    exports: ["ManagedCertificateNotice", "ManagedCertificateDetailRow"],
    height: 360,
    width: 760,
    summary: "The TLS certificate of a managed database or storage cluster: a quiet detail row always, and a warning notice only while the certificate needs attention.",
    guide: `
## Use it for
Detail pages of managed databases and managed storage. \`useManagedCertificateStatus(load, { enabled, refreshKey })\` loads the status once and reports the first load to the page gate, so the row and the notice appear with the page.

## Rules
- \`ManagedCertificateDetailRow\` goes in the resource's details panel: "Expires <date> · renewed automatically" (or "needs attention"). It renders nothing without a certificate (TLS off, no permission, older Opfield).
- \`ManagedCertificateNotice\` renders only when renewal failed, seven days or less remain, a delivered certificate is not loaded yet, or the renewal waits for the node daemon or its CA. Otherwise nothing: no banner for a healthy certificate.
- The action is a \`NoticeAction\` text link with an arrow, never a button; \`onRenew\` returns whether the renewal ran, and the action shows \`pending\` meanwhile.
- The dashboard lists every affected resource in one \`Notice\` (ManagedCertificatesNotice).

## The consumer provides
\`status\`; for the notice also \`onRenew\`, \`onRenewed\`, \`renewLabel\`.
`,
    preview: () => `
function status(days, renewal) {
  return { ownerType: "managed_database", ownerId: "db1", certificate: { id: "c1", serialNumber: "01", notBefore: "2026-06-01T00:00:00Z", notAfter: new Date(Date.now() + days * 864e5).toISOString(), daysRemaining: days, sans: ["db.internal"] },
    renewal: Object.assign({ state: "idle", reason: null, due: false, dueReason: null, urgent: false, hotReloadSupported: true, skipReason: null, attempts: 0, lastAttemptAt: null, nextAttemptAt: null, deliveredAt: null, lastSuccessAt: null, lastError: null, lastMethod: null, lastRestarted: false, pendingSerial: null }, renewal) };
}
mount(stage(
  h(G.PanelShell, { title: "Connection" },
    h(G.DetailRow, { label: "Host", value: "db.internal:5432" }),
    h(G.ManagedCertificateDetailRow, { status: status(64, { lastSuccessAt: "2026-08-28T09:12:00Z" }) })),
  h(G.ManagedCertificateNotice, { status: status(12, { state: "failed", attempts: 3, lastError: "node daemon unreachable", nextAttemptAt: "2026-09-26T14:00:00Z" }), onRenew: function () { return new Promise(function (r) { setTimeout(function () { r(false); }, 1500); }); } }),
  h(G.ManagedCertificateNotice, { status: status(5, {}), onRenew: function () { return Promise.resolve(false); } })
));
`,
  },
  {
    name: "Notice",
    group: "Status",
    source: "src/components/common/Notice.tsx",
    exports: ["Notice", "NoticeAction"],
    height: 330,
    width: 820,
    summary: "An attention notice on the dashboard or inside a page: a tone-coloured border, an icon and title, summary lines, and text actions with an arrow at the right.",
    guide: `
## Use it for
Conditions that need the operator: an expired licence, certificates that did not reach a route, an update, setup left to finish, a certificate that failed to renew. Show it only while something needs attention; one notice per condition, most severe first.

## Rules
- Tones: \`destructive\` for broken or expiring now (with \`role="alert"\`), \`warning\` for attention soon (title in \`text-warning-text\`), \`info\` (the link colour) for news and setup.
- Title: one sentence stating the condition ("Opfield license has expired"). Summary: \`text-sm text-muted-foreground\`, what it affects.
- Actions are \`NoticeAction\`s: a text link with an arrow in the tone colour, never a filled button. \`to\` for an app link, \`href\` for an external page, otherwise a button; \`pending\` swaps the arrow for a spinner; a secondary one (Hide) is \`muted\` with \`arrow: false\`.

## The consumer provides
\`tone\`, \`title\`, optional \`icon\`, summary as children, \`actions\`; \`role\` and \`aria-live\` for urgent notices.
`,
    preview: () => `
mount(h(G.MemoryRouter, null, stage(
  h(G.Notice, { tone: "destructive", role: "alert", title: "TLS certificate distribution needs attention", actions: h(G.NoticeAction, { tone: "destructive", to: "/ssl-certificates" }, "View certificates") },
    h("p", { className: "text-sm text-muted-foreground" }, "At least one active route has not received its current certificate.")),
  h(G.Notice, { tone: "warning", icon: I.RefreshCw, title: "Update Available", actions: [h(G.NoticeAction, { key: "a", tone: "warning", to: "/settings/general" }, "Go to Settings"), h(G.NoticeAction, { key: "b", tone: "warning", muted: true, arrow: false, onClick: function () {} }, "Hide")] },
    h("p", { className: "text-sm text-muted-foreground" }, "Opfield 2.11.0 is ready to install")),
  h(G.Notice, { tone: "info", title: "Finalize setup", actions: h(G.NoticeAction, { tone: "info", onClick: function () {} }, "Open checklist") },
    h("p", { className: "text-sm text-muted-foreground" }, "Connect infrastructure, secure your account, and enable optional Opfield features."))
)));
`,
  },
  {
    name: "PageTransition",
    group: "Loading",
    source: "src/components/common/PageTransition.tsx",
    extraSources: ["src/components/common/reveal-gate.tsx"],
    exports: ["PageTransition", "useContentLoading"],
    height: 400,
    width: 760,
    summary: "The page and tab gate of the reveal pipeline: content stays hidden while anything inside reports loading, then appears section by section.",
    guide: `
## Use it for
Every page route (a page renders inside one \`PageTransition\`) and, through \`TabsContent\`, every tab panel. Popouts, auth and setup windows are the exceptions.

## How it behaves
- Ready within **500 ms**: the page stays blank, then appears at once.
- Slower: a \`ContentLoader\` appears at 500 ms and stays **at least 500 ms**, so a load that ends just after it appeared does not flicker.
- Then the blocks reveal one after another: each fades in from 6px below over 220 ms, 35 ms apart, at most ten steps (\`cubic-bezier(0.25, 0.1, 0.25, 1)\`). The first element with several children is what staggers, so a page wrapped in one layout div still staggers its sections. Reduced motion skips the animation.
- A nested gate (a tab) that is still loading holds its parent, so a page never shows a half-loaded tab during its first reveal.

## Rules
- Report every request the first render depends on with \`useContentLoading(isLoading)\`, in the component that owns the loading state, below the gate. Follow-up requests (list, then details) too: the gate waits 50 ms after the last load for the next one.
- The flag must be true from the first render: \`useState(true)\` or "no data yet". A flag set in an effect is too late.
- Do not report background refreshes, polling or realtime updates; cached store data shows at once.
- No local spinners or "Loading…" placeholders for initial loads.

## The consumer provides
Children; optional \`className\` and \`offsetY\` (6px; tabs use 0).
`,
    preview: () => `
function Section(props) { return h("div", { className: "border border-border bg-card p-4" }, h("p", { className: "text-sm font-semibold" }, props.title), h("p", { className: "text-xs text-muted-foreground" }, props.children)); }
function Page(props) {
  var s = React.useState(true);
  G.useContentLoading(s[0]);
  React.useEffect(function () { var t = setTimeout(function () { s[1](false); }, props.ms); return function () { clearTimeout(t); }; }, []);
  return h("div", { className: "space-y-3" },
    h(G.PageHeader, { title: "Routes", description: "Route incoming domain traffic to services" }),
    h(Section, { title: "Health" }, "Loaded in " + props.ms + " ms."),
    h(Section, { title: "Certificates" }, "Each block reveals 35 ms after the one before."),
    h(Section, { title: "Recent activity" }, "Nothing moves after it appears.")
  );
}
function Demo() {
  var run = React.useState({ key: 0, ms: 1400 });
  return h("div", { className: "space-y-3 p-4" },
    h("div", { className: "flex items-center gap-2" },
      h(G.Button, { size: "sm", variant: "outline", onClick: function () { run[1]({ key: run[0].key + 1, ms: 300 }); } }, "Replay: 300 ms load"),
      h(G.Button, { size: "sm", variant: "outline", onClick: function () { run[1]({ key: run[0].key + 1, ms: 1400 }); } }, "Replay: 1400 ms load"),
      h("span", { className: "text-xs text-foreground" }, "Blank up to 500 ms, then a loader for at least 500 ms.")
    ),
    h("div", { className: "relative h-72 overflow-hidden border border-dashed border-border" }, h(G.PageTransition, { key: run[0].key }, h("div", { className: "p-4" }, h(Page, { ms: run[0].ms }))))
  );
}
mount(h(Demo));
`,
  },
  {
    name: "ContentLoader",
    group: "Loading",
    source: "src/components/common/reveal-gate.tsx",
    exports: ["ContentLoader"],
    height: 200,
    summary: "The one loader of the reveal pipeline: a 16px spinner and \"Loading…\" in muted text, centred in the space the content will take.",
    guide: `
## Use it for
Nothing directly: gates (pages, tab panels, dialogs) render it themselves when a load outlasts their delay. It is documented so it is recognised, and so no page draws its own.

## Rules
- It is marked \`data-reveal-skip\` so the stagger ignores it, and \`role="status"\` with the label "Loading".
- Standalone spinners elsewhere use \`LoadingSpinner\`, and only for explicitly incremental content.

## The consumer provides
Optional \`className\` (the gate's placement).
`,
    preview: () => `
mount(stage(row(null,
  h("div", { className: "relative h-32 w-72 border border-border bg-background" }, h(G.ContentLoader)),
  h("div", { className: "relative h-32 w-72 border border-border bg-card" }, h(G.ContentLoader, { className: "absolute inset-0 flex items-center justify-center" }))
)));
`,
  },
  {
    name: "ContentLoading",
    group: "Loading",
    source: "src/components/common/ContentLoading.tsx",
    exports: ["ContentLoading"],
    height: 420,
    width: 760,
    summary: "Reports a load to the gate it sits in, from a component that renders the gate itself; shown here in a dialog that waits and grows once.",
    guide: `
## Use it for
A page or dialog component that renders its own gate (\`PageTransition\` or \`DialogContent\`) and so cannot call \`useContentLoading\` above it: place \`<ContentLoading loading={isLoading} />\` inside the gate.

## How dialogs load
\`DialogContent\` is a gate that never shows a loader inside the dialog: it stays hidden (focusable, animations paused) until its loads finish and then opens at its final size, and the body's first field takes focus. Meanwhile the button that opened it shows a spinner (\`data-dialog-opening\`); without an opener, after **250 ms** the screen dims with a centred spinner that stays at least **300 ms**. After 10 s it opens anyway. Remove fixed min-heights and placeholders that only hid the jump.

## The consumer provides
\`loading\`.
`,
    preview: () => `
function Body() {
  var s = React.useState(true);
  React.useEffect(function () { var t = setTimeout(function () { s[1](false); }, 1200); return function () { clearTimeout(t); }; }, []);
  return h(React.Fragment, null,
    h(G.ContentLoading, { loading: s[0] }),
    h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Node"), h(G.Input, { defaultValue: "edge-1" })),
    h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Folder"), h(G.Input, { defaultValue: "Production" })),
    h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Upstream"), h(G.Input, { defaultValue: "http://10.0.1.4:8080" }))
  );
}
function Demo() {
  var k = React.useState(0);
  React.useEffect(function () { var t = setInterval(function () { k[1](function (v) { return v + 1; }); }, 4500); return function () { clearInterval(t); }; }, []);
  return h(G.Dialog, { key: k[0], open: true },
    h(G.DialogContent, { hideCloseButton: true },
      h(G.DialogHeader, null, h(G.DialogTitle, null, "Add Route"), h(G.DialogDescription, null, "Replays every 4.5 s: a 1200 ms load.")),
      h(Body),
      h(G.DialogFooter, null, h(G.Button, { variant: "outline" }, "Cancel"), h(G.Button, null, "Create"))
    )
  );
}
mount(h(Demo));
`,
  },
  {
    name: "Skeleton",
    group: "Loading",
    source: "src/components/ui/skeleton.tsx",
    exports: ["Skeleton"],
    height: 300,
    summary: "Renders nothing: while mounted it reports a load to the enclosing page, tab or dialog, exactly like useContentLoading(true).",
    guide: `
## Use it for
Older code that mounts \`<Skeleton />\` while data loads. It still works; new code calls \`useContentLoading(isLoading)\`. There are no grey placeholder blocks in this product: the gate hides the page instead.

## The consumer provides
Nothing (its props are ignored).
`,
    preview: () => `
function Panel() {
  var s = React.useState(true);
  React.useEffect(function () { var t = setTimeout(function () { s[1](false); }, 1500); return function () { clearTimeout(t); }; }, []);
  return s[0] ? h(G.Skeleton) : h(G.PanelShell, { title: "Environment", description: "Loaded after 1500 ms" }, h(G.DetailRow, { label: "Image", value: "nginx:1.27" }), h(G.DetailRow, { label: "Restart", value: "unless-stopped" }));
}
function Demo() {
  var k = React.useState(0);
  return h("div", { className: "space-y-3 p-4" },
    h(G.Button, { size: "sm", variant: "outline", onClick: function () { k[1](k[0] + 1); } }, "Replay"),
    h("div", { className: "relative h-48 border border-dashed border-border" }, h(G.PageTransition, { key: k[0] }, h("div", { className: "p-4" }, h(Panel))))
  );
}
mount(h(Demo));
`,
  },
  {
    name: "LoadingSpinner",
    group: "Loading",
    source: "src/components/common/LoadingSpinner.tsx",
    exports: ["LoadingSpinner"],
    height: 180,
    summary: "A standalone 24px ink spinner with a status role, for the few places a spinner is still right.",
    guide: `
## Use it for
Explicitly incremental content: infinite lists loading the next page, log streams, search results after typing. Never for a page's, tab's or dialog's first load (the gate handles it) and never inside a button (use \`pending\`).

## The consumer provides
Optional \`className\` (default \`py-16\`) and \`label\` (default "Loading").
`,
    preview: () => `
mount(stage(row(null,
  h("div", { className: "w-60 border border-border bg-card" }, h(G.LoadingSpinner)),
  h("div", { className: "w-60 border border-border bg-card" }, h(G.LoadingSpinner, { className: "py-4", label: "Loading more logs" }))
)));
`,
  },
  {
    name: "DetailPageSkeleton",
    checkWaitMs: 800,
    group: "Loading",
    source: "src/components/common/DetailPageSkeleton.tsx",
    exports: ["DetailPageSkeleton"],
    height: 220,
    summary: "The stand-in for a permission-gated detail route before its payload arrives: a page gate that keeps loading, so the route never remounts.",
    guide: `
## Use it for
Detail routes that check permission before they have the resource. It shows the gate's blank-then-loader behaviour until the real page replaces it; the loader hands over to the page without flicker.

## Rules
- \`tabs\` and \`panels\` are accepted but not drawn.

## The consumer provides
\`label\` (the accessible name of the busy region).
`,
    preview: () => `
mount(h("div", { className: "p-4" }, h("div", { className: "relative h-40 border border-dashed border-border" }, h(G.DetailPageSkeleton, { label: "Loading route" }))));
`,
  },
];
