// Catalog: actions and form controls. Each entry names the real source and
// exports, the guidance for its README and the live preview script. Preview
// scripts get `f` (facts read from the source: cva variants and the classes
// its hover:/focus-visible: states apply) and run in the preview frame with
// the shared prelude (prelude.ts: G = the kit in entry.tsx, h, I, mount, stage, row).

const json = (value) => JSON.stringify(value);

export const actionsAndForms = [
  {
    name: "Button",
    group: "Actions",
    source: "src/components/ui/button.tsx",
    exports: ["Button"],
    height: 640,
    width: 820,
    summary: "The one button of the product: seven variants, seven sizes and a pending state that every mutation uses.",
    guide: `
## Use it for
Every clickable action that is not a link inside text or a structural row. A raw \`<button>\` styled like a button is a bug: use \`Button\` with \`variant="ghost"\` and an icon size instead.

## Rules
- **Mutations use \`pending\`.** Create, save, delete and apply buttons pass \`pending={isSaving}\`: the button disables itself and a spinner takes the place of its leading icon, so a second click cannot start the request again. Never hand-roll a spinner plus \`disabled\`.
- **One text size.** Every size sets \`text-sm font-medium\`; smaller sizes are only lower. Never add \`text-xs\` or \`text-[..]\` to a button.
- **Sizes, not class overrides.** Icon buttons use \`icon\` (36px), \`icon-lg\` (40px), \`icon-sm\` (32px) or \`icon-xs\` (28px); never \`size="icon" className="h-8 w-8"\`. \`sm\` (32px) only in dense places: table rows, toolbars, inline notices.
- **Variants carry meaning.** \`default\` (ink fill) for the action a view is for, at most one per view; \`outline\` for secondary actions and header actions; \`ghost\` for icon actions in rows and fields; \`destructive\` for irreversible actions, usually inside a confirm dialog; \`warning\` for risky but recoverable actions; \`secondary\` for quiet fills; \`link\` for inline navigation that must still be a button; \`quiet\` for a text-only action inside a sentence, footer or caption (muted until hovered).
- **The \`inline\` size** has no box of its own: it sits in running text at the surrounding font size, with \`link\` or \`quiet\`. It is the one size that does not set 14px.
- Icons are lucide-react, 16px (\`[&_svg]:size-4\` is built in); put the icon before the label.
- Label with a verb in the product's casing: "Save", "Add Node", "Remove", "Revoke CA".

## The consumer provides
Children (label and optional leading icon), \`onClick\`, \`variant\`, \`size\`, \`pending\` while its request runs, \`aria-label\` on icon-only buttons, \`asChild\` to render a link with button styling.
`,
    preview: (f) => `
var V = ${json(f.cva.variants.variant)};
var HOVER = ${json(f.hover)};
var SIZES = ${json(Object.keys(f.cva.variants.size))};
var FOCUS = ${json(f.focus)};
mount(stage(
  Object.keys(V).map(function (v) {
    return row(v,
      h(G.Button, { key: "a", variant: v }, "Save changes"),
      h(G.Button, { key: "b", variant: v, className: HOVER[v] }, "Hover"),
      h(G.Button, { key: "c", variant: v, disabled: true }, "Disabled"),
      h(G.Button, { key: "d", variant: v, pending: true }, h(I.Save), "Saving")
    );
  }),
  row("sizes", SIZES.map(function (s) {
    return s.indexOf("icon") === 0
      ? h(G.Button, { key: s, size: s, variant: "outline", "aria-label": "Add " + s, title: s }, h(I.Plus))
      : s === "inline"
        ? h(G.Button, { key: s, size: s, variant: "link" }, "inline link")
        : h(G.Button, { key: s, size: s }, s);
  })),
  row("focus", h(G.Button, { variant: "outline", className: FOCUS }, "Focused"), h(G.Button, { className: FOCUS }, "Focused")),
  row("with icon", h(G.Button, null, h(I.Plus), "Add Node"), h(G.Button, { variant: "outline", pending: true }, h(I.RefreshCw), "Refresh"), h(G.Button, { variant: "ghost", size: "icon-sm", "aria-label": "Delete" }, h(I.Trash2)))
));
`,
  },
  {
    name: "RefreshButton",
    group: "Actions",
    source: "src/components/ui/refresh-button.tsx",
    exports: ["RefreshButton"],
    height: 170,
    summary: "An outline icon button that re-fetches a view and spins for at least three seconds, so a fast refresh still reads as done.",
    guide: `
## Use it for
The manual refresh of a list or panel whose data also updates on its own. It is a background refresh: it never hides the content or reports a load to the reveal gate.

## Rules
- Place it in the page header actions or a panel header, after the filters.
- Pass an async \`onClick\`; the button stays disabled and spinning until both the request and \`minDurationMs\` (3000 by default) finish.

## The consumer provides
\`onClick\` (may return a promise), \`disabled\`, optional \`minDurationMs\`.
`,
    preview: () => `
function Demo() {
  var ref = React.useRef(null);
  React.useEffect(function () {
    var click = function () { var b = ref.current && ref.current.querySelector("button"); if (b) b.click(); };
    click();
    var t = setInterval(click, 4000);
    return function () { clearInterval(t); };
  }, []);
  return stage(
    row("resting", h(G.RefreshButton, { onClick: function () {} })),
    row("refreshing", h("span", { ref: ref }, h(G.RefreshButton, { onClick: function () { return new Promise(function (r) { setTimeout(r, 800); }); } }))),
    row("disabled", h(G.RefreshButton, { onClick: function () {}, disabled: true }))
  );
}
mount(h(Demo));
`,
  },
  {
    name: "CopyButton",
    group: "Actions",
    source: "src/components/common/CopyButton.tsx",
    exports: ["CopyButton"],
    height: 180,
    summary: "A square icon button on a muted fill that copies a value, swaps its icon to a check for two seconds and confirms with a toast.",
    guide: `
## Use it for
Copying IDs, tokens, URLs, commands and PEM blocks. It usually sits at the right edge of a field (\`CopyValueField\`, \`CopyCodeBlock\`), separated by a left border in \`color-input\`.

## Rules
- Always pass a \`label\`: it becomes "Copy <label>" for the accessible name and tooltip.
- The toast says "Copied" or "Failed to copy"; do not add another confirmation.
- A \`Toaster\` must be mounted once in the app (it is, in the layout).

## The consumer provides
\`value\`, \`label\`, optional \`className\` (for the field's border) and \`iconClassName\` (h-3.5 w-3.5 inside fields).
`,
    preview: () => `
mount(stage(
  row("resting", h(G.CopyButton, { value: "opf_node_7f3a9c", label: "node ID" })),
  row("hover", h(G.CopyButton, { value: "opf_node_7f3a9c", label: "node ID", className: "bg-muted text-foreground" })),
  row("in a field", h("div", { className: "w-80" }, h(G.CopyValueField, { label: "Node ID", showLabel: false, value: "opf_node_7f3a9c", valueClassName: "font-mono" }))),
  h(G.Toaster, { key: "t" })
));
`,
  },
  {
    name: "DownloadButton",
    group: "Actions",
    source: "src/components/common/DownloadButton.tsx",
    exports: ["DownloadButton"],
    height: 140,
    summary: "Saves a PEM value as a file; it sits in an input group next to a CopyButton and confirms with a check and a toast.",
    guide: `
## Use it for
Certificates, keys and CA bundles shown in a field: the value can be copied or saved as \`.pem\`.

## Rules
- Put it after the CopyButton in the same bordered group; it brings its own left border.
- Name the file after the resource (\`node-7f3a9c.crt.pem\`).

## The consumer provides
\`value\`, \`label\` ("Download <label>"), \`filename\`.
`,
    preview: () => `
var PEM = "-----BEGIN CERTIFICATE-----\\nMIIBszCCAVmgAwIBAgIUQk9...\\n-----END CERTIFICATE-----";
mount(stage(
  row("group", h("div", { className: "flex w-96 min-w-0 border border-input bg-background" },
    h("div", { className: "flex h-9 min-w-0 flex-1 items-center px-3 font-mono text-sm" }, h("span", { className: "truncate" }, "-----BEGIN CERTIFICATE----- MIIBszCCAVmgAwIBAgIUQk9")),
    h(G.CopyButton, { value: PEM, label: "certificate", className: "border-l border-input", iconClassName: "h-3.5 w-3.5" }),
    h(G.DownloadButton, { value: PEM, label: "certificate", filename: "opfield-root-ca.pem" })
  )),
  h(G.Toaster, { key: "t" })
));
`,
  },
  {
    name: "PageBackButton",
    group: "Actions",
    source: "src/components/common/PageBackButton.tsx",
    exports: ["PageBackButton"],
    height: 130,
    summary: "The ghost icon button before a detail page title that returns to where the user came from.",
    guide: `
## Use it for
The \`leading\` slot of \`PageHeader\` on detail pages. It follows the return target in the router state (set by the list that linked here) and falls back to its \`onClick\`.

## Rules
- Keep the default label "Back" unless the destination is not the previous page ("Back to Work Session" is what \`LiteModeBackButton\` uses in AI lite mode).
- Renders inside a router.

## The consumer provides
\`onClick\` fallback, optional \`label\`.
`,
    preview: () => `
mount(h(G.MemoryRouter, null, stage(
  h(G.PageHeader, {
    leading: h(G.PageBackButton, { onClick: function () {} }),
    title: "api.example.com",
    description: "Proxy route",
    badges: h(G.Badge, { variant: "success" }, "Online")
  })
)));
`,
  },
  {
    name: "ChoiceCard",
    group: "Actions",
    source: "src/components/common/ChoiceCard.tsx",
    exports: ["ChoiceCard"],
    height: 330,
    summary: "A full-width outline button that presents one choice: an icon, a title, a one-line description and an optional trailing badge or arrow.",
    guide: `
## Use it for
The setup checklist, the setup wizards and dialogs that ask the user to pick one path ("Add a passkey" or "Authenticator app"; "OAuth" or "Personal access token"). Actions in forms stay \`Button\`s.

## Rules
- Title in \`text-sm font-medium\`, description one line in \`text-xs\` muted; the trailing slot holds a status \`Badge\` ("Done") or an arrow.
- A choice that starts an action passes \`pending\`: its icon turns into a spinner and the card disables itself.

## The consumer provides
\`icon\` (a lucide component), \`title\`, \`description\`, \`trailing\`, \`pending\`, \`onClick\` and other button props.
`,
    preview: () => `
mount(stage(h("div", { className: "w-[28rem] space-y-2" },
  h(G.ChoiceCard, { icon: I.Shield, title: "Add a passkey", description: "Use this device, a password manager, or a security key.", trailing: h(G.Badge, { variant: "success" }, "Done") }),
  h(G.ChoiceCard, { icon: I.Settings, title: "Authenticator app", description: "Scan a QR code with any compatible TOTP app.", trailing: h(I.ArrowRight, { className: "text-muted-foreground" }) }),
  h(G.ChoiceCard, { icon: I.Globe, title: "OAuth", description: "Authorize your GitHub account without copying a token into Opfield.", pending: true }),
  h(G.ChoiceCard, { icon: I.Copy, title: "Personal access token", description: "Connect GitHub.com or a GitHub Enterprise instance with a PAT.", disabled: true })
)));
`,
  },
  {
    name: "Input",
    group: "Forms",
    source: "src/components/ui/input.tsx",
    exports: ["Input"],
    height: 330,
    summary: "The single-line text field: 36px high, a 1px color-input border, square, with an inset 1px focus ring.",
    guide: `
## Use it for
Names, hosts, ports, search boxes and every free-text value. Numbers that must stay valid use \`NumericInput\`; pick lists use \`Select\` or \`Combobox\`.

## Rules
- Label every field: a \`<label>\` in \`text-sm font-medium\` above it with \`space-y-1.5\`, and a hint below in \`text-xs text-muted-foreground\`.
- Placeholders show the shape of a value ("api.example.com"), never the label.
- Search fields put a 16px \`Search\` icon inside at \`left-3\` and pad the input with \`pl-9\` (see \`SearchFilterBar\`).
- Embedded in a group (a field with buttons), drop the border and keep the inset ring: \`rounded-none border-0 focus-visible:ring-inset\`.

## The consumer provides
Everything an \`<input>\` takes; \`className\` for width and grouping.
`,
    preview: (f) => `
var FOCUS = ${json(f.focus)};
function field(label, input, hint) {
  return h("div", { className: "w-72 space-y-1.5" }, h("label", { className: "text-sm font-medium" }, label), input, hint ? h("p", { className: "text-xs text-muted-foreground" }, hint) : null);
}
mount(stage(
  h("div", { className: "grid grid-cols-2 gap-4" },
    field("Domain", h(G.Input, { placeholder: "api.example.com" }), "Placeholder"),
    field("Domain", h(G.Input, { defaultValue: "api.example.com" }), "Filled"),
    field("Domain", h(G.Input, { defaultValue: "api.example.com", className: FOCUS }), "Focus (ring shown)"),
    field("Domain", h(G.Input, { defaultValue: "api.example.com", disabled: true }), "Disabled"),
    field("Search", h("div", { className: "relative" }, h(I.Search, { className: "absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" }), h(G.Input, { placeholder: "Search by domain name...", className: "pl-9" })), "With icon"),
    field("Backup file", h(G.Input, { type: "file" }), "File")
  )
));
`,
  },
  {
    name: "Textarea",
    group: "Forms",
    source: "src/components/ui/textarea.tsx",
    exports: ["Textarea"],
    height: 250,
    summary: "The multi-line text field, 80px minimum, with the same border, fill and inset focus ring as Input.",
    guide: `
## Use it for
Descriptions, notes and pasted blocks that are not code. Config, templates and JSON use \`CodeEditor\`; PEM values shown read-only use \`CopyCodeBlock\`.

## Rules
- The resize grip is hidden product-wide; size it with \`className\` (\`min-h-32\`) instead.

## The consumer provides
Everything a \`<textarea>\` takes.
`,
    preview: (f) => `
var FOCUS = ${json(f.focus)};
mount(stage(h("div", { className: "grid grid-cols-3 gap-4" },
  h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Description"), h(G.Textarea, { placeholder: "What this route serves" })),
  h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Focused"), h(G.Textarea, { defaultValue: "Public API for the billing service.", className: FOCUS })),
  h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Disabled"), h(G.Textarea, { defaultValue: "Managed by the system.", disabled: true }))
)));
`,
  },
  {
    name: "NumericInput",
    group: "Forms",
    source: "src/components/ui/numeric-input.tsx",
    exports: ["NumericInput"],
    height: 200,
    summary: "A number field that lets the user clear it while typing and marks an empty or out-of-range value with a destructive border.",
    guide: `
## Use it for
Ports, counts, timeouts and sizes where the saved value must be a valid integer.

## Rules
- Pass \`min\` and \`max\`: the field shows the destructive border (\`border-destructive\`) while the raw text is empty or outside them, and \`aria-invalid\` is set.
- Keep the last valid number in your state (the first \`onChange\` argument) and disable Save while the raw value is invalid.

## The consumer provides
\`value\`, \`onChange(value, raw)\`, \`min\`, \`max\`, and any input props.
`,
    preview: () => `
function Field(props) {
  var s = React.useState(props.value);
  return h("div", { className: "w-44 space-y-1.5" }, h("label", { className: "text-sm font-medium" }, props.label), h(G.NumericInput, { value: s[0], onChange: function (v) { s[1](v); }, min: 1, max: 65535, disabled: props.disabled }), h("p", { className: "text-xs text-muted-foreground" }, props.hint));
}
function Empty() {
  var ref = React.useRef(null);
  React.useEffect(function () {
    var input = ref.current && ref.current.querySelector("input");
    if (!input) return;
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, []);
  return h("div", { ref: ref }, h(Field, { label: "Port", value: 8080, hint: "Empty: invalid" }));
}
mount(stage(row(null,
  h(Field, { label: "Port", value: 8080, hint: "Valid, 1 to 65535" }),
  h(Field, { label: "Port", value: 70000, hint: "Out of range" }),
  h(Empty),
  h(Field, { label: "Port", value: 443, hint: "Disabled", disabled: true })
)));
`,
  },
  {
    name: "Select",
    group: "Forms",
    source: "src/components/ui/select.tsx",
    exports: ["Select", "SelectTrigger", "SelectValue", "SelectContent", "SelectItem", "SelectGroup", "SelectLabel", "SelectSeparator"],
    height: 520,
    width: 760,
    summary: "The pick-one control: a 36px trigger like Input and a square popover list with a check on the chosen item and optional descriptions.",
    guide: `
## Use it for
Choosing one of a short, known list (types, filters, nodes). Long or searchable lists use \`Combobox\`.

## Rules
- The list opens below the trigger at the trigger's width; overflowing lists show fading scroll controls.
- An empty list shows a disabled "No options available" item on its own: do not add another empty message.
- Items may carry a \`description\` line in \`text-xs\` muted text.
- Filters in list pages sit in a fixed width wrapper (\`w-40\`).

## The consumer provides
\`value\` / \`onValueChange\` on \`Select\`; \`SelectTrigger\` with \`SelectValue placeholder\`; \`SelectContent\` with \`SelectItem\`s (and \`SelectGroup\`, \`SelectLabel\`, \`SelectSeparator\`).
`,
    preview: () => `
function S(props) {
  var ref = React.useRef(null);
  React.useEffect(function () {
    if (!props.open || !ref.current) return;
    var t = setTimeout(function () { ref.current.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); }, 50);
    return function () { clearTimeout(t); };
  }, []);
  return h(G.Select, { defaultValue: props.value, disabled: props.disabled },
    h(G.SelectTrigger, { ref: ref, className: "w-56" }, h(G.SelectValue, { placeholder: "Select a node" })),
    h(G.SelectContent, null,
      h(G.SelectGroup, null,
        h(G.SelectLabel, null, "Nodes"),
        h(G.SelectItem, { value: "edge-1", description: "Nginx · 10.0.1.1" }, "edge-1"),
        h(G.SelectItem, { value: "edge-2", description: "Nginx · 10.0.1.2" }, "edge-2"),
        h(G.SelectItem, { value: "docker-1", description: "Docker · offline", disabled: true }, "docker-1")
      ),
      h(G.SelectSeparator),
      h(G.SelectItem, { value: "all" }, "All nodes")
    )
  );
}
mount(stage(
  row("with value", h(S, { value: "edge-1" })),
  row("placeholder", h(S, {})),
  row("disabled", h(S, { value: "edge-2", disabled: true })),
  row("open", h(S, { value: "edge-1", open: true }))
));
`,
  },
  {
    name: "Combobox",
    group: "Forms",
    source: "src/components/common/Combobox.tsx",
    exports: ["Combobox"],
    height: 420,
    width: 760,
    summary: "A searchable select: an Input that filters a popover list by label, keywords and value, with groups, free text and a multiple mode.",
    guide: `
## Use it for
Long or open lists: images, domains, users, time zones. \`freeText\` accepts a value that is not in the list; \`multiple\` picks several and shows "N selected".

## Rules
- Keyboard: arrows move, Enter picks, Escape closes; the list never scrolls the dialog around it.
- Keep \`emptyMessage\` short ("No results found.").

## The consumer provides
\`value\`, \`options\` (\`{ value, label, keywords?, group?, disabled? }\`), \`onValueChange\`, placeholders, \`ariaLabel\`; \`multiple\` with an array value.
`,
    preview: () => `
var OPTIONS = [
  { value: "nginx:1.27", label: "nginx:1.27", group: "Registry" },
  { value: "postgres:17", label: "postgres:17", group: "Registry" },
  { value: "redis:8", label: "redis:8", group: "Registry" },
  { value: "opfield/api:rc.10", label: "opfield/api:rc.10", group: "Local builds" },
  { value: "opfield/worker:rc.10", label: "opfield/worker:rc.10", group: "Local builds", disabled: true }
];
function C(props) {
  var s = React.useState(props.value || "");
  return h("div", { className: "w-64" }, h(G.Combobox, { value: s[0], onValueChange: s[1], options: OPTIONS, placeholder: "Select an image", searchPlaceholder: "Search images...", ariaLabel: "Image", disabled: props.disabled }));
}
function Multi() {
  var s = React.useState(["nginx:1.27", "redis:8"]);
  return h("div", { className: "w-64" }, h(G.Combobox, { multiple: true, value: s[0], onValueChange: s[1], options: OPTIONS, ariaLabel: "Images" }));
}
function Open() {
  var ref = React.useRef(null);
  React.useEffect(function () { var input = ref.current && ref.current.querySelector("input"); if (input) { input.focus(); input.click(); } }, []);
  return h("div", { ref: ref }, h(C, { value: "postgres:17" }));
}
mount(stage(
  row("selected", h(C, { value: "nginx:1.27" })),
  row("multiple", h(Multi)),
  row("disabled", h(C, { value: "redis:8", disabled: true })),
  row("open", h(Open))
));
`,
  },
  {
    name: "Switch",
    group: "Forms",
    source: "src/components/ui/switch.tsx",
    exports: ["Switch"],
    height: 120,
    summary: "A square on/off toggle, 36 by 20px: ink when on, a faint fill when off.",
    guide: `
## Use it for
Settings that apply at once or on Save: enable a feature, a check, a rule. As a standalone option with a title use \`SwitchCard\`; in a settings panel row use \`SettingsControlRow\`.

## Rules
- Always pass \`ariaLabel\`; the switch has no visible text of its own.
- It is a \`button\` with \`aria-pressed\`, not a checkbox.
- It has no focus style of its own; keep it inside rows that show focus.

## The consumer provides
\`checked\`, \`onChange(next)\`, \`disabled\`, \`ariaLabel\`.
`,
    preview: () => `
function S(props) { var s = React.useState(props.checked); return h(G.Switch, { checked: s[0], onChange: s[1], disabled: props.disabled, ariaLabel: props.label }); }
mount(stage(row(null,
  h("span", { className: "text-sm" }, "On"), h(S, { checked: true, label: "On" }),
  h("span", { className: "text-sm" }, "Off"), h(S, { checked: false, label: "Off" }),
  h("span", { className: "text-sm" }, "Disabled on"), h(S, { checked: true, disabled: true, label: "Disabled on" }),
  h("span", { className: "text-sm" }, "Disabled off"), h(S, { checked: false, disabled: true, label: "Disabled off" })
)));
`,
  },
  {
    name: "SwitchCard",
    group: "Forms",
    source: "src/components/common/SwitchCard.tsx",
    exports: ["SwitchCard"],
    height: 250,
    summary: "A bordered on/off option: the Switch and its title on the first line, the description below, on a transparent ground.",
    guide: `
## Use it for
A live on/off state inside a dialog or form ("Proxied", "Force HTTPS"). An option that is included or not reads better as \`CheckboxCard\`. Rows of a multi-row settings panel use \`SettingsControlRow\`.

## Rules
- The control sits on the left, next to its title; the description runs below across the full width.
- A disabled \`fieldset\` around it disables it too.

## The consumer provides
\`label\`, optional \`description\`, \`checked\`, \`onCheckedChange(next)\`, \`disabled\`.
`,
    preview: () => `
function T(props) { var s = React.useState(props.checked); return h(G.SwitchCard, { label: props.label, description: props.description, checked: s[0], onCheckedChange: s[1], disabled: props.disabled }); }
mount(stage(h("div", { className: "w-[28rem] space-y-3" },
  h(T, { label: "Force HTTPS", description: "Redirect plain HTTP requests to HTTPS.", checked: true }),
  h(T, { label: "Health check", description: "Probe the upstream every 30 seconds.", checked: false }),
  h(T, { label: "Managed by template", description: "Locked while the template controls it.", checked: true, disabled: true })
)));
`,
  },
  {
    name: "CheckboxCard",
    group: "Forms",
    source: "src/components/common/CheckboxCard.tsx",
    exports: ["CheckboxCard"],
    height: 250,
    summary: "A bordered checkbox option: the box and its title on the first line, the description below, on a transparent ground.",
    guide: `
## Use it for
Choosing which options apply, often several at once (certificate key usages, allowed SAN types).

## Rules
- The box sits on the left, next to its title; the description runs below across the full width.
- A disabled \`fieldset\` around it disables it too.

## The consumer provides
\`label\`, optional \`description\`, \`checked\`, \`onCheckedChange(next)\`, \`disabled\`.
`,
    preview: () => `
function C(props) { var s = React.useState(props.checked); return h(G.CheckboxCard, { label: props.label, description: props.description, checked: s[0], onCheckedChange: s[1], disabled: props.disabled }); }
mount(stage(h("div", { className: "w-[28rem] space-y-2" },
  h(C, { label: "Digital Signature", description: "Verify digital signatures. Required for TLS and most uses.", checked: true }),
  h(C, { label: "Key Encipherment", description: "Encrypt symmetric keys during an RSA TLS handshake.", checked: true }),
  h(C, { label: "Data Encipherment", description: "Encrypt data directly. Rarely needed.", checked: false })
)));
`,
  },
  {
    name: "Slider",
    group: "Forms",
    source: "src/components/ui/slider.tsx",
    exports: ["Slider"],
    height: 240,
    summary: "A single-value range control: a 6px muted track, an ink range and a square thumb, with full keyboard support.",
    guide: `
## Use it for
Values where the position matters more than the digits (zoom, thresholds). Pair it with the number when the exact value matters.

## Rules
- Pass \`ariaLabel\`. Arrows step, Page Up/Down step by ten, Home/End jump to the ends.
- It shows no focus indicator of its own (\`outline-none\`, no ring): keyboard users cannot see focus.

## The consumer provides
\`value\`, \`onValueChange\`, \`min\`, \`max\`, \`step\`, \`ariaLabel\`, \`disabled\`.
`,
    preview: () => `
function S(props) {
  var s = React.useState(props.value);
  return h("div", { className: "w-80 space-y-1" }, h("div", { className: "flex justify-between text-sm" }, h("span", { className: "font-medium" }, props.label), h("span", { className: "text-foreground" }, s[0] + "%")), h(G.Slider, { value: s[0], onValueChange: s[1], ariaLabel: props.label, disabled: props.disabled, step: 5 }));
}
mount(stage(
  h(S, { label: "Alert threshold", value: 25 }),
  h(S, { label: "Disk warning", value: 80 }),
  h(S, { label: "Disabled", value: 50, disabled: true })
));
`,
  },
  {
    name: "EditableStringList",
    group: "Forms",
    source: "src/components/common/EditableStringList.tsx",
    exports: ["EditableStringList"],
    height: 220,
    summary: "A bordered list of text rows with add and remove buttons, for editing a list of strings in place.",
    guide: `
## Use it for
Short lists of values: domains, CIDR ranges, allowed origins. Enter on the last filled row adds a new one.

## The consumer provides
\`values\`, \`onChange(values)\`, \`placeholder\`, \`itemLabel\` (for "Add <item>" and "Remove <item> N").
`,
    preview: () => `
function L() { var s = React.useState(["api.example.com", "www.example.com"]); return h("div", { className: "w-96" }, h(G.EditableStringList, { values: s[0], onChange: s[1], placeholder: "example.com", itemLabel: "Domain" })); }
function E() { var s = React.useState([]); return h("div", { className: "w-96" }, h(G.EditableStringList, { values: s[0], onChange: s[1], placeholder: "10.0.0.0/8", itemLabel: "Range" })); }
mount(stage(row("two values", h(L)), row("empty", h(E))));
`,
  },
  {
    name: "ManagedResourceFields",
    group: "Forms",
    source: "src/components/common/ManagedResourceFields.tsx",
    exports: ["ManagedResourceFields"],
    height: 440,
    summary: "The four sizing fields of a managed database or storage cluster (storage, CPU, memory, swap), each with the capacity left on the node.",
    guide: `
## Use it for
Create and resize dialogs of managed databases and managed storage.

## The consumer provides
\`idPrefix\`, \`values\` (strings as typed), \`capacity\` (what the node has free), \`onChange(key, value)\`, \`minimumMemoryMb\`, optional \`minimumStorageGb\` and \`memoryHint\`.
`,
    preview: () => `
function M() {
  var s = React.useState({ storageSizeGb: "20", cpuCores: "1", memoryMb: "1024", swapMb: "0" });
  return h("div", { className: "w-80" }, h(G.ManagedResourceFields, { idPrefix: "db", values: s[0], capacity: { storageSizeGb: 412, cpuCores: 8, memoryMb: 15872, swapMb: 2048 }, minimumMemoryMb: 256, onChange: function (k, v) { var next = Object.assign({}, s[0]); next[k] = v; s[1](next); } }));
}
mount(stage(h(M)));
`,
  },
  {
    name: "CreateFolderSelect",
    group: "Forms",
    source: "src/components/common/CreateFolderSelect.tsx",
    exports: ["CreateFolderSelect"],
    height: 240,
    summary: "The destination picker of a create dialog: the root and the folders the user may create in, in tree order, indented by depth.",
    guide: `
## Use it for
Every create dialog of a foldered resource (routes, containers, databases). Build the choices with \`getCreateFolderChoices(scopes, createScope, folders)\` so the list follows the same grant rules as the backend.

## Rules
- While the folder tree loads it reports the load to the dialog (\`useContentLoading\`), so the dialog opens complete.
- It keeps the selection valid when grants or the tree change.

## The consumer provides
\`choices\`, \`value\` ("" is the root), \`onChange\`, \`loading\`, \`disabled\`, \`id\`, \`ariaLabel\`.
`,
    preview: () => `
var CHOICES = { allowRoot: true, defaultFolderId: "", folders: [
  { id: "f1", name: "Production", depth: 0 },
  { id: "f2", name: "Billing", depth: 1 },
  { id: "f3", name: "Staging", depth: 0 }
] };
function F(props) { var s = React.useState(props.value); return h("div", { className: "w-64" }, h(G.CreateFolderSelect, { choices: props.choices || CHOICES, value: s[0], onChange: s[1], loading: props.loading })); }
mount(stage(
  row("root", h(F, { value: "" })),
  row("folder", h(F, { value: "f2" })),
  row("loading", h(F, { value: "", loading: true })),
  row("none allowed", h(F, { value: "", choices: { allowRoot: false, defaultFolderId: "", folders: [] } }))
));
`,
  },
  {
    name: "CodeEditor",
    group: "Forms",
    source: "src/components/ui/code-editor.tsx",
    exports: ["CodeEditor"],
    height: 330,
    width: 760,
    summary: "The CodeMirror editor for nginx templates, env files, JSON, SQL, YAML and XML, with line numbers, error lines and the product's highlight colours.",
    guide: `
## Use it for
Configuration and templates: nginx server blocks with Handlebars variables, Compose and env files, JSON payloads, SQL. Plain notes use \`Textarea\`.

## Rules
- Pass \`errorLines\` (1-based) or \`errorRanges\` from validation; they are tinted in place.
- Read-only generated documents set \`readOnly\` and \`preserveScrollOnChange\`.
- Syntax colours are raw hues (keywords, strings, variables): syntax highlighting is the one place raw colours stay.

## The consumer provides
\`value\`, \`onChange\`, \`language\`, sizing (\`minHeight\` or \`height\`), \`readOnly\`, error lines.
`,
    preview: () => `
var NGINX = [
  "server {",
  "    listen 443 ssl;",
  "    server_name {{domain}};",
  "    location / {",
  "        proxy_pass http://{{upstream}};",
  "        proxy_set_header Host $host;",
  "    }",
  "}"
].join("\\n");
function E() { var s = React.useState(NGINX); return h(G.CodeEditor, { value: s[0], onChange: s[1], language: "nginx", minHeight: "220px", errorLines: [5] }); }
mount(stage(h(E)));
`,
  },
  {
    name: "SettingsControlRow",
    group: "Forms",
    source: "src/components/common/SettingsControlRow.tsx",
    exports: ["SettingsControlRow", "SettingsInlineControl", "SettingsHelpTitle"],
    height: 330,
    width: 760,
    summary: "A settings row: title, optional help tooltip and description on the left, the control on the right, divided from the next row by a border.",
    guide: `
## Use it for
Settings pages and panels: one row per setting, inside a \`PanelShell\`. A row with \`onClick\` becomes a button (hover fill, inset focus ring) that toggles its control.

## Rules
- Put long explanations in \`help\` (a question-mark tooltip), keep \`description\` to one line.
- Labelled inputs inside a row use \`SettingsInlineControl\`.

## The consumer provides
\`title\`, \`description\`, \`help\`, the control as children, optional \`onClick\`.
`,
    preview: () => `
function R() {
  var a = React.useState(true), b = React.useState("30");
  return h(G.TooltipProvider, null, h(G.PanelShell, { title: "Health checks", description: "How Opfield probes upstreams", className: "w-[40rem]" },
    h(G.SettingsControlRow, { title: "Enabled", description: "Probe every route with a health check path.", onClick: function () { a[1](!a[0]); } }, h(G.Switch, { checked: a[0], onChange: a[1], ariaLabel: "Enabled" })),
    h(G.SettingsControlRow, { title: "Interval", help: "How often each upstream is probed. Shorter intervals find outages sooner and cost more requests.", description: "Seconds between probes." },
      h(G.Select, { value: b[0], onValueChange: b[1] }, h(G.SelectTrigger, null, h(G.SelectValue)), h(G.SelectContent, null, h(G.SelectItem, { value: "10" }, "10 seconds"), h(G.SelectItem, { value: "30" }, "30 seconds"), h(G.SelectItem, { value: "60" }, "60 seconds")))),
    h(G.SettingsControlRow, { title: "Alert address" }, h(G.SettingsInlineControl, { label: "Email" }, h(G.Input, { defaultValue: "ops@example.com" })))
  ));
}
mount(stage(h(R)));
`,
  },
  {
    name: "CopyValueField",
    group: "Forms",
    source: "src/components/common/CopyValueField.tsx",
    exports: ["CopyValueField"],
    height: 250,
    summary: "A read-only value in an input-like box with a CopyButton at the right, and an optional label above.",
    guide: `
## Use it for
IDs, URLs, tokens and endpoints the user copies but does not edit. Multi-line values use \`CopyCodeBlock\`.

## Rules
- Monospace values (tokens, IDs) pass \`valueClassName="font-mono"\`.
- Long values truncate with an ellipsis and a full-value title.

## The consumer provides
\`label\`, \`value\`, optional \`copyValue\`, \`showLabel\`, \`copyable\`, \`actions\` (for example a DownloadButton).
`,
    preview: () => `
mount(stage(h("div", { className: "w-96 space-y-4" },
  h(G.CopyValueField, { label: "Enrollment URL", value: "https://opfield.example.com/enroll/7f3a9c" }),
  h(G.CopyValueField, { label: "API token", value: "opf_4be1a0f2c9d84d6e9a7f1b3c5d7e9f01", valueClassName: "font-mono" }),
  h(G.CopyValueField, { label: "Not copyable", value: "Managed by the system", copyable: false })
)));
`,
  },
  {
    name: "CopyCodeBlock",
    group: "Forms",
    source: "src/components/common/CopyCodeBlock.tsx",
    exports: ["CopyCodeBlock"],
    height: 200,
    summary: "A labelled, horizontally scrolling code block with a copy column at the right: for commands and PEM values.",
    guide: `
## Use it for
Install commands, enrollment one-liners and certificates the user copies whole.

## The consumer provides
\`label\`, \`value\`, optional \`copyValue\` and \`codeClassName\` (\`font-mono\`).
`,
    preview: () => `
mount(stage(h("div", { className: "w-[36rem]" }, h(G.CopyCodeBlock, { label: "Install command", codeClassName: "font-mono", value: "curl -fsSL https://opfield.example.com/install.sh | sudo sh -s -- \\\\\\n  --token opf_enroll_7f3a9c --version 2.10.0" }))));
`,
  },
  {
    name: "ScopeSearchFilter",
    group: "Forms",
    source: "src/components/common/ScopeSearchFilter.tsx",
    exports: ["ScopeSearchFilter"],
    height: 150,
    summary: "The search strip above a permission list: a borderless search field and a filter menu for all, selected or unselected scopes.",
    guide: `
## Use it for
The top of scope and permission pickers (tokens, OAuth apps, roles).

## The consumer provides
\`search\`, \`onSearchChange\`, \`filter\`, \`onFilterChange\`, \`placeholder\`, \`disabled\`.
`,
    preview: () => `
function S() { var s = React.useState(""), f = React.useState("all"); return h("div", { className: "w-[28rem] border border-border bg-card" }, h(G.ScopeSearchFilter, { search: s[0], onSearchChange: s[1], filter: f[0], onFilterChange: f[1] }), h("p", { className: "p-3 text-sm text-muted-foreground" }, "nodes:read, nodes:write, routes:read…")); }
mount(stage(h(S)));
`,
  },
  {
    name: "SearchFilterBar",
    group: "Forms",
    source: "src/components/common/SearchFilterBar.tsx",
    exports: ["SearchFilterBar"],
    height: 270,
    width: 760,
    summary: "The list-page search: a search field with an icon and a Filters button that opens a bordered panel of filter selects.",
    guide: `
## Use it for
Above every list and table page. \`inlineFilters\` puts the filters beside the search when there are one or two.

## Rules
- Enter submits server-side searches (\`onSearchSubmit\`).
- Filters are \`Select\`s in \`w-40\` wrappers.

## The consumer provides
\`search\`, \`onSearchChange\`, \`onSearchSubmit\`, \`hasActiveFilters\`, \`onReset\`, \`filters\`, \`inlineFilters\`, \`initialFiltersOpen\`.
`,
    preview: () => `
function filters() {
  return [
    h("div", { key: "a", className: "w-40" }, h(G.Select, { defaultValue: "all" }, h(G.SelectTrigger, null, h(G.SelectValue)), h(G.SelectContent, null, h(G.SelectItem, { value: "all" }, "All types"), h(G.SelectItem, { value: "proxy" }, "Proxy")))),
    h("div", { key: "b", className: "w-40" }, h(G.Select, { defaultValue: "online" }, h(G.SelectTrigger, null, h(G.SelectValue)), h(G.SelectContent, null, h(G.SelectItem, { value: "all" }, "All health"), h(G.SelectItem, { value: "online" }, "Online"))))
  ];
}
function B(props) { var s = React.useState(""); return h(G.SearchFilterBar, { search: s[0], onSearchChange: s[1], hasActiveFilters: false, onReset: function () {}, placeholder: "Search by domain name...", filters: filters(), initialFiltersOpen: props.open, inlineFilters: props.inline }); }
mount(stage(h(B, { open: true }), h(B, { inline: true })));
`,
  },
];
