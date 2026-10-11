// Catalog: page structure and data display.

export const layoutAndData = [
  {
    name: "PageHeader",
    group: "Layout",
    source: "src/components/common/PageHeader.tsx",
    exports: ["PageHeader"],
    height: 220,
    width: 900,
    summary: "The title row at the top of every page: an optional leading element, a bold 24px title with badges, a muted description and actions at the right.",
    guide: `
## Use it for
The first element of every page, inside the page padding (\`px-6 pt-6\`) with \`space-y-4\` to the content below.

## Rules
- Title: the page or resource name ("Routes", "api.example.com"). Description: one short line without a period ("Route incoming domain traffic to services").
- \`leading\`: \`PageBackButton\` on detail pages, \`LiteModeBackButton\` on list pages (it renders only in AI lite mode).
- \`badges\`: status badges of the resource.
- \`actions\`: \`ResponsiveHeaderActions\`, which moves actions into a ⋮ menu as the header narrows.

## The consumer provides
\`title\`, \`description\`, \`leading\`, \`badges\`, \`actions\`, \`className\`.
`,
    preview: () => `
function actions() {
  return h(G.ResponsiveHeaderActions, { actions: [{ label: "New Folder", onClick: function () {} }, { label: "Add Route", onClick: function () {} }] },
    h(G.Button, { variant: "outline" }, h(I.Folder), "New Folder"),
    h(G.Button, null, h(I.Plus), "Add Route"));
}
mount(h(G.MemoryRouter, null, h("div", { className: "space-y-8 p-6" },
  h(G.PageHeader, { title: "Routes", description: "Route incoming domain traffic to services", actions: actions() }),
  h(G.PageHeader, { leading: h(G.PageBackButton, { onClick: function () {} }), title: "api.example.com", description: "Proxy · edge-1, edge-2", badges: [h(G.Badge, { key: "a", variant: "success" }, "Online"), h(G.Badge, { key: "b", variant: "outline" }, "Proxy")], actions: h(G.Button, { variant: "outline" }, h(I.Pencil), "Edit") })
)));
`,
  },
  {
    name: "SectionHeader",
    group: "Layout",
    source: "src/components/common/SectionHeader.tsx",
    exports: ["SectionHeader"],
    height: 280,
    width: 820,
    summary: "The header band of a panel: an optional icon, a 14px semibold title and a 12px description on the muted band, actions at the right.",
    guide: `
## Use it for
The top of panels and cards inside pages (\`PanelShell\` renders it from its \`title\`). The band is \`bg-muted/60\` in light and solid \`bg-muted\` in dark, with a bottom border.

## Rules
- \`withBorder={false}\` when nothing follows; \`wrap\` when actions may wrap on narrow widths.
- Actions are \`sm\` or icon buttons.
- Descriptions here are \`text-muted-foreground\` on the muted band: 3.99:1 in light, below 4.5:1 (see the colour notes).

## The consumer provides
\`title\`, \`icon\`, \`description\`, \`actions\` (or children), class overrides.
`,
    preview: () => `
mount(stage(h("div", { className: "w-[40rem] space-y-4" },
  h("div", { className: "border border-border bg-card" }, h(G.SectionHeader, { title: "Health checks", icon: h(I.Activity, { className: "h-4 w-4" }), description: "Probe each upstream every 30 seconds", actions: h(G.Button, { size: "sm", variant: "outline" }, "Configure") }), h("p", { className: "p-4 text-sm" }, "Panel body")),
  h("div", { className: "border border-border bg-card" }, h(G.SectionHeader, { title: "Environment variables", withBorder: false, actions: h(G.Button, { size: "icon-sm", variant: "ghost", "aria-label": "Add variable" }, h(I.Plus)) }))
)));
`,
  },
  {
    name: "PanelShell",
    group: "Layout",
    source: "src/components/common/PanelShell.tsx",
    exports: ["PanelShell"],
    height: 360,
    width: 820,
    summary: "A bordered card with a SectionHeader and a body; a dirty panel swaps its border to the warning colour until saved.",
    guide: `
## Use it for
Every titled block of a detail or settings page. Rows inside are \`SettingsControlRow\`, \`DetailRow\` or a table.

## Rules
- \`dirty\` marks unsaved edits (warning border); pair it with a Save button that uses \`pending\`.
- Panels stack with \`space-y-4\`; they never nest.

## The consumer provides
\`title\`, \`icon\`, \`description\`, \`actions\` or a custom \`header\`, children, \`dirty\`, class overrides for header and body.
`,
    preview: () => `
mount(stage(h("div", { className: "grid w-[48rem] grid-cols-2 gap-4" },
  h(G.PanelShell, { title: "Upstream", description: "Where requests go" }, h(G.DetailRow, { label: "Target", value: "10.0.1.4:8080" }), h(G.DetailRow, { label: "Protocol", value: "HTTP/1.1" })),
  h(G.PanelShell, { title: "Headers", description: "Unsaved changes", dirty: true, actions: h(G.Button, { size: "sm", pending: true }, "Save") }, h(G.DetailRow, { label: "X-Frame-Options", value: "DENY" }), h(G.DetailRow, { label: "Cache-Control", value: "no-store" }))
)));
`,
  },
  {
    name: "ResponsiveHeaderActions",
    group: "Layout",
    source: "src/components/common/ResponsiveHeaderActions.tsx",
    exports: ["ResponsiveHeaderActions", "HeaderOverflowMenu"],
    height: 360,
    width: 900,
    summary: "Page header actions that fold into a ⋮ menu as the header narrows: at most four buttons, destructive actions always in the menu.",
    guide: `
## Use it for
The \`actions\` slot of \`PageHeader\`. It also registers the actions with the command palette.

## Rules
- Pass the rendered buttons as children and the same actions, in order, as \`actions\` metadata (label, icon, onClick, disabled, \`destructive\`, \`priority\`).
- Actions take at most half the row and never push the title below 320px; lower \`priority\` folds first.
- \`destructive\` and \`alwaysOverflow\` actions live only in the menu.

## The consumer provides
Children (buttons) and \`actions\` metadata; optional \`reservedContentWidth\`, \`menuClassName\`.
`,
    preview: () => `
var ACTIONS = [
  { label: "Refresh", icon: h(I.RefreshCw), onClick: function () {} },
  { label: "Edit", icon: h(I.Pencil), onClick: function () {} },
  { label: "Duplicate", icon: h(I.Copy), onClick: function () {} },
  { label: "Maintenance", icon: h(I.Settings), onClick: function () {}, alwaysOverflow: true },
  { label: "Delete", icon: h(I.Trash2), onClick: function () {}, destructive: true, separatorBefore: true }
];
function Header(props) {
  return h("div", { style: { width: props.width }, className: "border border-dashed border-border p-4" }, h(G.PageHeader, { title: "api.example.com", description: "Proxy route", actions: h(G.ResponsiveHeaderActions, { actions: ACTIONS },
    h(G.Button, { variant: "outline" }, h(I.RefreshCw), "Refresh"),
    h(G.Button, { variant: "outline" }, h(I.Pencil), "Edit"),
    h(G.Button, { variant: "outline" }, h(I.Copy), "Duplicate"),
    h(G.Button, { variant: "outline" }, "Maintenance"),
    h(G.Button, { variant: "destructive" }, "Delete")
  ) }));
}
mount(h(G.MemoryRouter, null, stage(h(Header, { width: 860 }), h(Header, { width: 560 }))));
`,
  },
  {
    name: "Tabs",
    group: "Layout",
    source: "src/components/ui/tabs.tsx",
    exports: ["Tabs", "TabsList", "TabsTrigger", "TabsContent"],
    height: 260,
    width: 820,
    summary: "Square segmented tabs in a bordered strip: the active tab is an ink fill; each panel is its own reveal gate.",
    guide: `
## Use it for
Sections of a detail page (Overview, Logs, Settings). Keep the tab in the URL where the page supports it.

## Rules
- Each \`TabsContent\` wraps its children in a \`PageTransition\`: report the tab's loads with \`useContentLoading\` inside the panel; a tab that loads during the page's first reveal holds the page.
- The strip scrolls horizontally on narrow screens; do not wrap it.
- Inactive tabs are \`text-muted-foreground\` on the page: 4.36:1 in light, just below 4.5:1.

## The consumer provides
\`value\` / \`onValueChange\` (or \`defaultValue\`), \`TabsList\` with \`TabsTrigger\`s, one \`TabsContent\` per value.
`,
    preview: (f) => `
var HOVER = ${JSON.stringify(f.hover)};
mount(stage(h(G.Tabs, { defaultValue: "overview" },
  h(G.TabsList, null,
    h(G.TabsTrigger, { value: "overview" }, "Overview"),
    h(G.TabsTrigger, { value: "logs", className: HOVER }, "Logs (hover)"),
    h(G.TabsTrigger, { value: "settings" }, "Settings"),
    h(G.TabsTrigger, { value: "danger", disabled: true }, "Disabled")
  ),
  h(G.TabsContent, { value: "overview" }, h(G.PanelShell, { title: "Overview" }, h(G.DetailRow, { label: "Status", value: h(G.Badge, { variant: "success" }, "Online") }))),
  h(G.TabsContent, { value: "logs" }, h("p", { className: "text-sm" }, "Logs panel")),
  h(G.TabsContent, { value: "settings" }, h("p", { className: "text-sm" }, "Settings panel"))
)));
`,
  },
  {
    name: "Separator",
    group: "Layout",
    source: "src/components/ui/separator.tsx",
    exports: ["Separator"],
    height: 150,
    summary: "A 1px color-border rule, horizontal or vertical.",
    guide: `
## Use it for
Dividing groups inside a panel or toolbar. Panels themselves are divided by their borders, not by separators.

## The consumer provides
\`orientation\`, \`decorative\` (true by default), \`className\`.
`,
    preview: () => `
mount(stage(
  h("div", { className: "w-80 space-y-3" }, h("p", { className: "text-sm" }, "Above"), h(G.Separator), h("p", { className: "text-sm" }, "Below")),
  h("div", { className: "flex h-6 items-center gap-3 text-sm" }, h("span", null, "edge-1"), h(G.Separator, { orientation: "vertical" }), h("span", null, "10.0.1.1"), h(G.Separator, { orientation: "vertical" }), h("span", null, "2.10.0"))
));
`,
  },
  {
    name: "Collapsible",
    group: "Layout",
    source: "src/components/ui/collapsible.tsx",
    exports: ["Collapsible", "CollapsibleTrigger", "CollapsibleContent"],
    height: 260,
    summary: "Shows and hides a region with a 200ms height-and-fade animation.",
    guide: `
## Use it for
Advanced options inside a form and long secondary details. Content that must animate its height as it changes uses \`AnimatedHeight\`.

## The consumer provides
\`open\` / \`onOpenChange\` (or \`defaultOpen\`), a \`CollapsibleTrigger asChild\` button and \`CollapsibleContent\`.
`,
    preview: () => `
function C(props) {
  var s = React.useState(props.open);
  return h(G.Collapsible, { open: s[0], onOpenChange: s[1], className: "w-96 border border-border bg-card" },
    h(G.CollapsibleTrigger, { asChild: true }, h(G.Button, { variant: "ghost", className: "w-full justify-between" }, "Advanced options", h(I.Settings))),
    h(G.CollapsibleContent, null, h("div", { className: "space-y-1.5 border-t border-border p-4" }, h("label", { className: "text-sm font-medium" }, "Client max body size"), h(G.Input, { defaultValue: "10m" })))
  );
}
mount(stage(h(C, { open: true }), h(C, { open: false })));
`,
  },
  {
    name: "ScrollArea",
    group: "Layout",
    source: "src/components/ui/scroll-area.tsx",
    exports: ["ScrollArea", "ScrollBar"],
    height: 240,
    summary: "A scroll container with a thin square color-border thumb that matches the native scrollbars.",
    guide: `
## Use it for
Fixed-height lists inside popovers and panels where the native scrollbar would look out of place. Page-level scrolling stays native (8px square thumbs in \`color-border\`, hidden below 640px).

## The consumer provides
Children and a height via \`className\`.
`,
    preview: () => `
var ITEMS = []; for (var i = 1; i <= 30; i += 1) ITEMS.push("route-" + i + ".example.com");
mount(stage(h(G.ScrollArea, { className: "h-44 w-72 border border-border bg-card" }, h("div", { className: "divide-y divide-border" }, ITEMS.map(function (item) { return h("p", { key: item, className: "px-3 py-2 text-sm" }, item); })))));
`,
  },
  {
    name: "ResizeHandle",
    group: "Layout",
    source: "src/components/ui/resize-handle.tsx",
    exports: ["ResizeHandle"],
    height: 240,
    summary: "An invisible 12px grip on a panel's edge that drags its width between limits and shows a 1px line on hover.",
    guide: `
## Use it for
Resizable side panels (the AI panel, file trees). The parent must be \`relative\`; the handle measures it.

## The consumer provides
\`side\` (the panel's side of the screen), \`onResize(width)\`, \`minWidth\`, \`maxWidth\`, start and end callbacks.
`,
    preview: () => `
function P() {
  var w = React.useState(240);
  return h("div", { className: "flex h-44 w-[36rem] border border-border" },
    h("div", { className: "relative shrink-0 border-r border-border bg-card p-3", style: { width: w[0] } }, h("p", { className: "text-sm font-medium" }, "Files"), h("p", { className: "text-xs text-muted-foreground" }, "Drag the right edge: " + Math.round(w[0]) + "px"), h(G.ResizeHandle, { side: "left", onResize: w[1], minWidth: 160, maxWidth: 400 })),
    h("div", { className: "flex-1 p-3 text-sm" }, "Editor")
  );
}
mount(stage(h(P)));
`,
  },
  {
    name: "AnimatedHeight",
    group: "Layout",
    source: "src/components/common/AnimatedHeight.tsx",
    exports: ["AnimatedHeight"],
    height: 300,
    summary: "Animates its own height over 250ms whenever its content grows or shrinks, so a changing form does not jump.",
    guide: `
## Use it for
Forms whose fields depend on a choice (a type select that adds fields). It adds 8px of breathing room around the content so focus rings are not clipped.

## The consumer provides
Children.
`,
    preview: () => `
function Demo() {
  var s = React.useState(false);
  React.useEffect(function () { var t = setInterval(function () { s[1](function (v) { return !v; }); }, 1800); return function () { clearInterval(t); }; }, []);
  return stage(h("div", { className: "w-96 border border-border bg-card p-4" }, h(G.AnimatedHeight, null, h("div", { className: "space-y-3" },
    h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Type"), h(G.Input, { value: s[0] ? "Redirect" : "Proxy", readOnly: true })),
    s[0] ? h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Redirect to"), h(G.Input, { defaultValue: "https://www.example.com" })) : null,
    s[0] ? h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Status code"), h(G.Input, { defaultValue: "301" })) : null
  ))));
}
mount(h(Demo));
`,
  },
  {
    name: "DetailRow",
    group: "Layout",
    source: "src/components/common/DetailRow.tsx",
    exports: ["DetailRow"],
    height: 240,
    summary: "A label and value row: a muted label column (96px, 160px from md) and the value right-aligned.",
    guide: `
## Use it for
Read-only properties in detail panels and sheets. Stack rows in a \`divide-y divide-border\` container.

## The consumer provides
\`label\` and \`value\` (text, a badge, a copy field).
`,
    preview: () => `
mount(stage(h("div", { className: "w-[32rem] divide-y divide-border border border-border bg-card" },
  h(G.DetailRow, { label: "Status", value: h(G.Badge, { variant: "success" }, "Online") }),
  h(G.DetailRow, { label: "Address", value: "10.0.1.1" }),
  h(G.DetailRow, { label: "Daemon", value: "2.10.0" }),
  h(G.DetailRow, { label: "Last seen", value: "Just now" })
)));
`,
  },
  {
    name: "PoweredByFooter",
    group: "Layout",
    source: "src/components/common/PoweredByFooter.tsx",
    exports: ["PoweredByFooter"],
    height: 90,
    summary: "The \"Powered by Opfield\" line under login and public pages, muted text with a foreground link.",
    guide: `
## Use it for
The foot of the login, consent and status pages only.

## The consumer provides
Nothing.
`,
    preview: () => `
mount(stage(h(G.PoweredByFooter)));
`,
  },
  {
    name: "ErrorBoundary",
    expectErrors: true,
    group: "Layout",
    source: "src/components/common/ErrorBoundary.tsx",
    exports: ["ErrorBoundary"],
    height: 260,
    summary: "Catches a render error below it and shows a centred \"Something went wrong\" with the message and Reload page.",
    guide: `
## Use it for
Around the app and around risky islands (editors, terminals) with a local \`fallback\`.

## The consumer provides
Children and an optional \`fallback\`.
`,
    preview: () => `
function Broken() { throw new Error("Cannot read the node list"); }
mount(h("div", { className: "h-full" }, h(G.ErrorBoundary, null, h(Broken))));
`,
  },
  {
    name: "DataTable",
    group: "Data",
    source: "src/components/ui/data-table.tsx",
    exports: ["DataTable"],
    height: 680,
    width: 900,
    summary: "The virtualised table: a sticky muted header of uppercase column names, 49px rows, clickable rows with the accent hover, optional group rows.",
    guide: `
## Use it for
Lists that can grow large: audit log, events, certificates, containers. Small fixed lists use \`SimpleTable\`; foldered resources use \`ResourceListForm\`.

## Rules
- Columns share the width equally unless \`width\` is set; \`truncate\` for long values; \`align: "right"\` for numbers.
- Initial loading: pass \`loading\`; while there are no rows it reports the load to the gate and renders nothing. After that, refreshes update rows in place.
- Empty: \`emptyMessage\` renders an \`EmptyState\`; pass \`emptyContent\` for one with an action.
- \`embedded\` removes the outer border when a panel already has one.

## The consumer provides
\`columns\` (\`{ key, header, render, width?, align?, truncate? }\`), \`data\`, \`keyFn\`, \`onRowClick\`, \`groupBy\`, \`loading\`, \`emptyMessage\`, and a height from its container.
`,
    preview: () => `
var ROWS = [
  { id: "1", name: "api.example.com", node: "edge-1", status: "online", requests: "12.4k" },
  { id: "2", name: "www.example.com", node: "edge-1", status: "online", requests: "8.1k" },
  { id: "3", name: "billing.example.com", node: "edge-2", status: "recovering", requests: "1.2k" },
  { id: "4", name: "legacy.example.com", node: "edge-2", status: "offline", requests: "0" },
  { id: "5", name: "status.example.com", node: "edge-3", status: "unknown", requests: "310" }
];
var COLUMNS = [
  { key: "name", header: "Domain", truncate: true, render: function (r) { return h("span", { className: "font-medium" }, r.name); } },
  { key: "node", header: "Node", width: "8rem", render: function (r) { return r.node; } },
  { key: "status", header: "Health", width: "9rem", render: function (r) { return h(G.Badge, { variant: G.proxyHealthTone(r.status) }, r.status); } },
  { key: "requests", header: "Requests", width: "7rem", align: "right", render: function (r) { return r.requests; } }
];
mount(stage(
  h("div", { style: { height: 420 } }, h(G.DataTable, { columns: COLUMNS, data: ROWS, keyFn: function (r) { return r.id; }, onRowClick: function () {}, groupBy: function (r) { return { key: r.node, label: h("span", { className: "text-xs font-medium uppercase tracking-wider" }, r.node) }; } })),
  h(G.DataTable, { columns: COLUMNS, data: [], keyFn: function (r) { return r.id; }, emptyMessage: "No routes match your search." })
));
`,
  },
  {
    name: "SimpleTable",
    group: "Data",
    source: "src/components/common/SimpleTable.tsx",
    exports: ["SimpleTable"],
    height: 380,
    width: 820,
    summary: "A plain HTML table with the same header and row treatment as DataTable, for short fixed lists.",
    guide: `
## Use it for
Short lists inside panels: ports, mounts, variables, sessions. It has no border of its own; put it in a \`PanelShell\` or bordered div.

## Rules
- Same loading and empty behaviour as \`DataTable\` (\`loading\`, \`emptyMessage\` → an embedded \`EmptyState\`).

## The consumer provides
\`columns\` (\`{ id, header, render, align? }\`), \`rows\`, \`getRowKey\`, \`onRowClick\`, \`loading\`, \`emptyMessage\`.
`,
    preview: () => `
var COLS = [
  { id: "host", header: "Host port", render: function (r) { return r.host; } },
  { id: "container", header: "Container port", render: function (r) { return r.container; } },
  { id: "proto", header: "Protocol", align: "right", render: function (r) { return h(G.Badge, { variant: "outline", size: "inline" }, r.proto); } }
];
mount(stage(
  h("div", { className: "border border-border bg-card" }, h(G.SimpleTable, { columns: COLS, rows: [{ host: "8080", container: "80", proto: "tcp" }, { host: "8443", container: "443", proto: "tcp" }, { host: "5353", container: "53", proto: "udp" }], getRowKey: function (r) { return r.host; }, onRowClick: function () {} })),
  h("div", { className: "border border-border bg-card" }, h(G.SimpleTable, { columns: COLS, rows: [], getRowKey: function (r) { return r.host; }, emptyMessage: "No port mappings" }))
));
`,
  },
  {
    name: "ResourceListFrame",
    group: "Data",
    source: "src/components/common/ResourceListLayout.tsx",
    exports: ["ResourceListFrame", "ResourceListHeaderTable", "ResourceListTable", "ResourceListRow", "ResourceListCell", "ResourceListSectionHeader"],
    height: 360,
    width: 900,
    summary: "The parts of the resource list layout: a bordered horizontally scrolling frame, a fixed-layout header table, section headers with counts, and 52px rows and cells.",
    guide: `
## Use it for
Building foldered resource lists; \`ResourceListForm\` assembles these parts with folders, search and drag and drop. Use the parts directly only for a list the form cannot express.

## Rules
- Header and body tables share one \`columns\` definition so their widths line up (\`table-layout: fixed\`).
- Rows the user cannot open render at 80% opacity (\`interactive={false}\`).
- Cells indent the first column by \`depth\` (24px per level).

## The consumer provides
\`columns\` (\`{ id, label, width?, align?, renderCell? }\`), rows and cells.
`,
    preview: () => `
var COLS = [{ id: "name", label: "Name", width: "40%" }, { id: "node", label: "Node", width: "25%" }, { id: "status", label: "Status", width: "20%" }, { id: "port", label: "Port", width: "15%", align: "right" }];
function r(name, node, status, port, interactive, depth) {
  return h(G.ResourceListRow, { key: name, interactive: interactive },
    h(G.ResourceListCell, { depth: depth }, h("span", { className: "text-sm font-medium" }, name)),
    h(G.ResourceListCell, null, h("span", { className: "text-sm" }, node)),
    h(G.ResourceListCell, null, h(G.Badge, { variant: G.dockerStateTone(status) }, status)),
    h(G.ResourceListCell, { align: "right" }, h("span", { className: "text-sm" }, port)));
}
mount(stage(h(G.ResourceListFrame, { minWidth: 700 },
  h(G.ResourceListHeaderTable, { columns: COLS }),
  h(G.ResourceListSectionHeader, { label: "Production", count: 2 }),
  h(G.ResourceListTable, { columns: COLS }, r("api", "docker-1", "running", "8080", true, 0), r("worker", "docker-1", "restarting", "–", true, 1)),
  h(G.ResourceListSectionHeader, { label: "Ungrouped", count: 1 }),
  h(G.ResourceListTable, { columns: COLS }, r("legacy-cron", "docker-2", "exited", "–", false, 0))
)));
`,
  },
  {
    name: "ResourceListForm",
    group: "Data",
    source: "src/components/common/ResourceListForm.tsx",
    extraSources: ["src/components/common/resource-list/types.ts"],
    exports: ["ResourceListForm"],
    height: 520,
    width: 900,
    summary: "The foldered list of routes, containers and databases: search and filters, collapsible folders with counts, rows that open the resource, drag and drop between folders.",
    guide: `
## Use it for
List pages of foldered resources. It owns search, folders, rows, the empty state and the first-load report to the page gate.

## Rules
- Pass \`loading\` from the first render until the first data arrives; it reports the load to the page and draws nothing meanwhile.
- \`hasContent\` false shows your \`emptyState\` (an \`EmptyState\` with "Add one" when the user may create).
- Folder actions (rename, delete, new subfolder) appear only where \`canManageFolder\` allows.

## The consumer provides
\`columns\`, \`search\` (SearchFilterBar props), \`folders\` (the tree and its callbacks), \`items\` (ids, click, drag rules), optional \`dnd\` handlers, \`loading\`, \`hasContent\`, \`emptyState\`.
`,
    preview: () => `
var FOLDERS = [
  { id: "prod", name: "Production", children: [], items: [{ id: "r1", name: "api.example.com", status: "online" }, { id: "r2", name: "www.example.com", status: "online" }] },
  { id: "stage", name: "Staging", children: [], items: [{ id: "r3", name: "staging.example.com", status: "recovering" }] }
];
var UNGROUPED = [{ id: "r4", name: "legacy.example.com", status: "offline" }];
var COLS = [
  { id: "name", label: "Domain", width: "55%", renderCell: function (i) { return h("span", { className: "text-sm font-medium" }, i.name); } },
  { id: "status", label: "Health", width: "25%", renderCell: function (i) { return h(G.Badge, { variant: G.proxyHealthTone(i.status) }, i.status); } },
  { id: "type", label: "Type", width: "20%", renderCell: function () { return h(G.Badge, { variant: "outline" }, "Proxy"); } }
];
function Demo() {
  var s = React.useState(""), open = React.useState(new Set(["prod"]));
  return h(G.ResourceListForm, {
    columns: COLS, minWidth: 640,
    search: { placeholder: "Search by domain name...", search: s[0], onSearchChange: s[1], hasActiveFilters: false, onReset: function () {} },
    hasContent: true, emptyState: h(G.EmptyState, { message: "No routes." }),
    folders: {
      folders: FOLDERS, ungroupedItems: UNGROUPED, expandedFolderIds: open[0],
      getFolderId: function (f) { return f.id; }, getFolderName: function (f) { return f.name; }, getFolderChildren: function (f) { return f.children; }, getFolderItems: function (f) { return f.items; },
      getFolderSortableId: function (f) { return "folder-" + f.id; }, getFolderSortableData: function (f) { return { type: "folder", folderId: f.id }; },
      isFolderExpanded: function (f) { return open[0].has(f.id); }, canManageFolder: function () { return true; }, canReorderFolder: function () { return true; }, canCreateSubfolder: function () { return true; },
      onToggleFolder: function (id) { var next = new Set(open[0]); if (next.has(id)) next.delete(id); else next.add(id); open[1](next); },
      onRenameFolder: function () {}, onDeleteFolder: function () {}, onRequestCreateSubfolder: function () {}
    },
    items: { getItemId: function (i) { return i.id; }, getItemSortableId: function (i) { return i.id; }, getItemSortableData: function (i) { return { type: "host", host: i }; }, onItemClick: function () {} }
  });
}
mount(h(G.MemoryRouter, null, h(G.TooltipProvider, null, stage(h(Demo)))));
`,
  },
  {
    name: "ReferenceTable",
    group: "Data",
    source: "src/components/common/ReferenceTable.tsx",
    exports: ["ReferenceTable"],
    height: 260,
    width: 760,
    summary: "A compact two-column table of template variables, helpers or query syntax: the term in monospace purple, its meaning in muted text.",
    guide: `
## Use it for
The reference beside template and query editors (nginx templates, notification templates, log queries).

## Rules
- The term colour (\`text-purple-400\`) is the variable colour of the template editors: syntax highlighting, so a raw hue is allowed. On a light card it is about 3:1, below 4.5:1 for 12px text.

## The consumer provides
\`termLabel\` ("Variable", "Usage", "Syntax"), \`rows\` (\`{ term, description }\`), optional \`title\` and \`descriptionLabel\`.
`,
    preview: () => `
mount(stage(h("div", { className: "w-[36rem]" }, h(G.ReferenceTable, { title: "Template variables", termLabel: "Variable", rows: [
  { term: "{{domain}}", description: "The route's primary domain" },
  { term: "{{upstream}}", description: "host:port of the first healthy upstream" },
  { term: "{{#if ssl}}…{{/if}}", description: "Rendered only when the route has a certificate" }
] }))));
`,
  },
  {
    name: "VirtualLogList",
    layoutDependent: true,
    group: "Data",
    source: "src/components/ui/virtual-log-list.tsx",
    exports: ["VirtualLogList"],
    height: 300,
    width: 820,
    summary: "A virtualised, bottom-anchored list of log lines that keeps its place when older history is prepended and loads more at the top.",
    guide: `
## Use it for
Container, nginx and daemon logs and any append-only stream. It sticks to the newest line while the user is at the bottom.

## Rules
- Rows are \`text-xs leading-5\` monospace; wrap each line's styling in \`renderLine\`.
- Older history: \`hasMore\`, \`onLoadMore\`, bump \`prependVersion\` after prepending; "Loading more…" shows at the top.

## The consumer provides
\`lines\`, \`renderLine\`, \`keyFn\`, paging props, \`emptyState\`, \`initialScrollToEnd\`, \`className\` with a height.
`,
    preview: () => `
var LEVELS = ["info", "info", "info", "warn", "info", "error"];
var LINES = []; for (var i = 0; i < 400; i += 1) LINES.push({ n: i, level: LEVELS[i % 6], text: "2026-09-26T10:" + String(Math.floor(i / 60)).padStart(2, "0") + ":" + String(i % 60).padStart(2, "0") + "Z  " + ["GET /api/nodes 200 4ms", "upstream 10.0.1.4:8080 healthy", "reload ok", "slow response 1840ms", "GET /health 200 1ms", "upstream refused connection"][i % 6] });
mount(stage(h("div", { className: "flex h-60 flex-col border border-border bg-card font-mono" }, h(G.VirtualLogList, { lines: LINES, keyFn: function (l) { return l.n; }, initialScrollToEnd: true, renderLine: function (l) { return h("div", { className: "whitespace-pre px-3 text-xs leading-5 " + (l.level === "error" ? "text-destructive" : l.level === "warn" ? "text-warning-foreground" : "") }, l.text); } }))));
`,
  },
  {
    name: "AnsiText",
    group: "Data",
    source: "src/components/ui/ansi-text.tsx",
    exports: ["AnsiText"],
    height: 220,
    width: 760,
    summary: "Renders terminal output with ANSI colours, bold, italic and underline, using the xterm palette.",
    guide: `
## Use it for
Build output, container logs and command results that carry ANSI escapes. Terminal colours are raw hues by nature.

## The consumer provides
\`text\` and \`className\`.
`,
    preview: () => `
var E = "\\u001b[";
var TEXT = E + "1m#5 [build 2/4]" + E + "0m RUN pnpm install --frozen-lockfile\\n" + E + "32m✓" + E + "0m dependencies installed in 14.2s\\n" + E + "33mwarn" + E + "0m peer react@19 satisfied by 19.2.7\\n" + E + "31merror" + E + "0m " + E + "4mtest/api.spec.ts" + E + "0m failed (2 of 118)";
mount(stage(h("pre", { className: "border border-border bg-card p-3 font-mono text-xs leading-5" }, h(G.AnsiText, { text: TEXT }))));
`,
  },
  {
    name: "TruncateStart",
    group: "Data",
    source: "src/components/ui/truncate-start.tsx",
    exports: ["TruncateStart"],
    height: 150,
    summary: "Truncates text at its start, keeping the end visible: for paths and hostnames where the tail matters.",
    guide: `
## Use it for
File paths, image references and long hostnames in narrow cells. The full text is in the title.

## The consumer provides
\`text\` and span props.
`,
    preview: () => `
var PATH = "/var/lib/gateway/volumes/production/postgres/data/pg_wal/000000010000000000000042";
mount(stage(
  row("start", h("div", { className: "w-72 border border-border bg-card p-2 text-sm" }, h(G.TruncateStart, { text: PATH }))),
  row("end (CSS)", h("div", { className: "w-72 truncate border border-border bg-card p-2 text-sm" }, PATH))
));
`,
  },
  {
    name: "EmptyState",
    group: "Data",
    source: "src/components/common/EmptyState.tsx",
    exports: ["EmptyState"],
    height: 480,
    width: 760,
    summary: "One muted sentence in a bordered card saying the list is empty, with an optional action link or a Clear filters button.",
    guide: `
## Use it for
Every empty list, table and panel. Tables render it themselves from \`emptyMessage\`.

## Rules
- Message: a short sentence ending with a period ("No routes.", "No incidents."); what is missing, not an apology.
- Action: a verb phrase after the message ("Add one"), only when the user may create; "Clear filters" when filters hide results.
- \`embedded\` inside a bordered panel (no second border).

## The consumer provides
\`message\`, \`actionLabel\` with \`actionHref\` or \`onAction\`, \`hasActiveFilters\` with \`onReset\`, \`embedded\`.
`,
    preview: () => `
mount(h(G.MemoryRouter, null, stage(
  h(G.EmptyState, { message: "No routes.", actionLabel: "Add one", onAction: function () {} }),
  h(G.EmptyState, { message: "No containers match your search.", hasActiveFilters: true, onReset: function () {} }),
  h(G.EmptyState, { message: "No incidents.", actionLabel: "View status page", actionHref: "/status-page" }),
  h("div", { className: "border border-border" }, h(G.EmptyState, { message: "No custom headers", embedded: true }))
)));
`,
  },
  {
    name: "ValueTile",
    group: "Data",
    source: "src/components/common/ValueTile.tsx",
    exports: ["ValueTile"],
    height: 220,
    summary: "A bordered tile with a muted label above a monospace value, for the fields of detail dialogs; an empty value shows a dash.",
    guide: `
## Use it for
Detail dialogs of audit entries, SIEM deliveries and log events: a grid of tiles (\`grid gap-2\` with column spans).

## Rules
- Long plain-text values truncate with a hover title; pass \`wrap\` for IDs and payloads that must be read whole.
- Its \`rounded-md\` resolves to 0 like every radius.

## The consumer provides
\`label\`, the value as children, \`wrap\`, \`className\`.
`,
    preview: () => `
mount(stage(h("div", { className: "grid w-[36rem] grid-cols-6 gap-2" },
  h(G.ValueTile, { className: "col-span-2", label: "Action" }, "proxy_host.update"),
  h(G.ValueTile, { className: "col-span-2", label: "Time" }, "26 Sep 2026, 14:02"),
  h(G.ValueTile, { className: "col-span-2", label: "Resource Type" }, "proxy_host"),
  h(G.ValueTile, { className: "col-span-3", label: "Resource ID", wrap: true }, "7f3a9c1e-4b2d-4f8a-9c6e-2d1b3a5f7e90"),
  h(G.ValueTile, { className: "col-span-3", label: "User ID" })
)));
`,
  },
  {
    name: "Avatar",
    group: "Data",
    source: "src/components/ui/avatar.tsx",
    exports: ["Avatar", "AvatarImage", "AvatarFallback"],
    height: 130,
    summary: "A square 40px user picture with a 1px border, falling back to initials on the muted fill.",
    guide: `
## Use it for
Users in the account menu, audit log and user lists. Square like everything else.

## The consumer provides
\`AvatarImage src\` and an \`AvatarFallback\` with initials; size via \`className\`.
`,
    preview: () => `
var IMG = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#3b3d87"/><rect x="12" y="12" width="16" height="16" fill="#f5f5f5"/></svg>');
mount(stage(row(null,
  h(G.Avatar, null, h(G.AvatarImage, { src: IMG, alt: "Alex" }), h(G.AvatarFallback, null, "AS")),
  h(G.Avatar, null, h(G.AvatarFallback, null, "AS")),
  h(G.Avatar, { className: "h-8 w-8" }, h(G.AvatarFallback, { className: "text-xs" }, "JD"))
)));
`,
  },
];
