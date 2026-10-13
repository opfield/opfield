// Catalog: dialogs, sheets, menus, popovers, toasts.

export const overlays = [
  {
    name: "Dialog",
    group: "Overlays",
    source: "src/components/ui/dialog.tsx",
    exports: ["Dialog", "DialogContent", "DialogHeader", "DialogTitle", "DialogDescription", "DialogFooter", "DialogTrigger", "DialogClose"],
    height: 480,
    width: 820,
    summary: "The modal: a square panel on a 50% black overlay with a fixed header, a body and a footer, which waits for its data and grows once.",
    guide: `
## Use it for
Create and edit forms, confirmations and one-off tasks that keep the page behind. On phones it becomes a bottom sheet.

## Rules
- Compose it from \`DialogHeader\` (\`DialogTitle\` + \`DialogDescription\`), body children and \`DialogFooter\`; the content splits them into slots itself. Only the body scrolls: never put \`overflow-y-auto\` on a body child (it throws).
- Loading: report the dialog's fetches with \`useContentLoading\` inside its body. The dialog stays hidden until they finish and opens complete; meanwhile the opener button shows a spinner, or the screen dims with a spinner after 250 ms when there is no opener (see \`ContentLoading\`).
- Footer: Cancel (\`outline\`) first, the primary action last; the primary action passes \`pending\` while it runs, and Cancel is disabled meanwhile.
- Title in the product's casing for a resource action ("Add Node", "Remove Volume"); description one sentence.
- Width: \`sm:max-w-lg\` by default; \`sm:max-w-md\` for confirmations.

## The consumer provides
\`open\` / \`onOpenChange\` on \`Dialog\`; \`DialogContent\` with optional \`hideCloseButton\`, \`clipOverflow\`, \`unstyled\` (the command palette only).
`,
    preview: () => `
function Demo() {
  return h(G.Dialog, { open: true },
    h(G.DialogContent, null,
      h(G.DialogHeader, null, h(G.DialogTitle, null, "Add Node"), h(G.DialogDescription, null, "Enroll a server so Opfield can manage its services.")),
      h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Name"), h(G.Input, { defaultValue: "edge-3" })),
      h("div", { className: "space-y-1.5" }, h("label", { className: "text-sm font-medium" }, "Type"), h(G.Select, { defaultValue: "nginx" }, h(G.SelectTrigger, null, h(G.SelectValue)), h(G.SelectContent, null, h(G.SelectItem, { value: "nginx" }, "Nginx"), h(G.SelectItem, { value: "docker" }, "Docker")))),
      h(G.DialogFooter, null, h(G.Button, { variant: "outline", disabled: true }, "Cancel"), h(G.Button, { pending: true }, "Create"))
    )
  );
}
mount(h(Demo));
`,
  },
  {
    name: "Sheet",
    group: "Overlays",
    source: "src/components/ui/sheet.tsx",
    exports: ["Sheet", "SheetContent", "SheetHeader", "SheetTitle", "SheetDescription", "SheetFooter", "SheetTrigger", "SheetClose"],
    height: 420,
    width: 820,
    summary: "A panel that slides in from an edge over an 80% black overlay: three quarters wide, at most 384px from the side.",
    guide: `
## Use it for
The mobile navigation drawer and side panels that keep context of the page. Forms and confirmations use \`Dialog\`.

## Rules
- \`side\`: \`right\` (default) or \`left\`; top and bottom span the width.
- It slides in over 300 ms and out over 200 ms.
- Its overlay is darker than the dialog's (\`bg-black/80\` against \`bg-black/50\`).

## The consumer provides
\`open\` / \`onOpenChange\`; \`SheetContent side\` with header, body and footer.
`,
    preview: () => `
mount(h(G.Sheet, { open: true },
  h(G.SheetContent, { side: "right" },
    h(G.SheetHeader, null, h(G.SheetTitle, null, "edge-1"), h(G.SheetDescription, null, "Nginx node · 10.0.1.1")),
    h("div", { className: "mt-4 divide-y divide-border border border-border bg-card" }, h(G.DetailRow, { label: "Status", value: h(G.Badge, { variant: "success" }, "Online") }), h(G.DetailRow, { label: "Version", value: "2.10.0" }), h(G.DetailRow, { label: "Routes", value: "18" })),
    h(G.SheetFooter, { className: "mt-4" }, h(G.Button, { variant: "outline" }, "Open node"))
  )
));
`,
  },
  {
    name: "DropdownMenu",
    group: "Overlays",
    source: "src/components/ui/dropdown-menu.tsx",
    exports: ["DropdownMenu", "DropdownMenuTrigger", "DropdownMenuContent", "DropdownMenuItem", "DropdownMenuCheckboxItem", "DropdownMenuRadioGroup", "DropdownMenuRadioItem", "DropdownMenuLabel", "DropdownMenuSeparator", "DropdownMenuShortcut", "DropdownMenuGroup", "DropdownMenuSub", "DropdownMenuSubTrigger", "DropdownMenuSubContent"],
    height: 420,
    width: 760,
    summary: "A square menu of actions on the popover ground with an accent highlight, icons, shortcuts, checkbox and radio items, and submenus.",
    guide: `
## Use it for
Row actions (the ⋮ button), the header overflow of \`ResponsiveHeaderActions\`, account menus and filters with several options.

## Rules
- Destructive items read \`text-destructive\` and go last, after a separator.
- Disabled items stay visible; explain why with a \`title\`.
- Opened with the mouse, closing returns no focus ring to the trigger; opened with the keyboard, focus returns.
- Items are 48px tall on touch widths (\`py-3\`), 32px from \`md\` up.

## The consumer provides
A \`DropdownMenuTrigger asChild\` around a Button, and \`DropdownMenuContent\` with items.
`,
    preview: () => `
function Demo() {
  var c = React.useState(true), r = React.useState("name");
  return h("div", { className: "p-4" }, h(G.DropdownMenu, { open: true, modal: false },
    h(G.DropdownMenuTrigger, { asChild: true }, h(G.Button, { variant: "outline", size: "icon", "aria-label": "Route actions" }, h(I.EllipsisVertical))),
    h(G.DropdownMenuContent, { align: "start", className: "w-56" },
      h(G.DropdownMenuLabel, null, "api.example.com"),
      h(G.DropdownMenuItem, null, h(I.Pencil), "Edit", h(G.DropdownMenuShortcut, null, "E")),
      h(G.DropdownMenuItem, null, h(I.Copy), "Duplicate"),
      h(G.DropdownMenuItem, { disabled: true, title: "Requires routes:write" }, h(I.Folder), "Move to folder"),
      h(G.DropdownMenuSeparator),
      h(G.DropdownMenuCheckboxItem, { checked: c[0], onCheckedChange: c[1] }, "Show health"),
      h(G.DropdownMenuRadioGroup, { value: r[0], onValueChange: r[1] }, h(G.DropdownMenuRadioItem, { value: "name" }, "Sort by name"), h(G.DropdownMenuRadioItem, { value: "status" }, "Sort by status")),
      h(G.DropdownMenuSub, null, h(G.DropdownMenuSubTrigger, null, h(I.Settings), "Maintenance"), h(G.DropdownMenuSubContent, null, h(G.DropdownMenuItem, null, "Enable"), h(G.DropdownMenuItem, null, "Schedule"))),
      h(G.DropdownMenuSeparator),
      h(G.DropdownMenuItem, { className: "text-destructive" }, h(I.Trash2), "Delete")
    )
  ));
}
mount(h(Demo));
`,
  },
  {
    name: "Tooltip",
    group: "Overlays",
    source: "src/components/ui/tooltip.tsx",
    exports: ["TooltipProvider", "Tooltip", "TooltipTrigger", "TooltipContent"],
    height: 200,
    width: 820,
    summary: "A small bordered label on the popover ground with an arrow, for naming icon buttons and explaining a value; hidden below 768px.",
    guide: `
## Use it for
Naming icon-only buttons and giving the full value of a truncated one. Help text longer than a sentence goes in \`SettingsHelpTitle\`'s tooltip, which wraps.

## Rules
- Content is \`text-xs\`, 8px from the trigger.
- It is \`hidden md:block\`: touch-width screens never see tooltips, so nothing essential may live only in one.
- Wrap a region in one \`TooltipProvider\` (the app has one); \`delayDuration\` 200 for help icons.

## The consumer provides
\`TooltipTrigger asChild\` around the element, \`TooltipContent\` with the text and optional \`side\` / \`align\`.
`,
    preview: () => `
mount(h(G.TooltipProvider, null, h("div", { className: "flex items-end gap-24 p-4 pt-24" },
  h(G.Tooltip, { open: true }, h(G.TooltipTrigger, { asChild: true }, h(G.Button, { variant: "outline", size: "icon", "aria-label": "Refresh" }, h(I.RefreshCw))), h(G.TooltipContent, null, "Refresh")),
  h(G.Tooltip, { open: true }, h(G.TooltipTrigger, { asChild: true }, h("span", { className: "text-sm underline decoration-dotted" }, "2.10.0")), h(G.TooltipContent, { side: "top", align: "start", className: "max-w-xs whitespace-normal py-2 leading-relaxed" }, "Installed 12 Sep 2026. The node daemon updates itself within an hour of a release."))
)));
`,
  },
  {
    name: "Popover",
    group: "Overlays",
    source: "src/components/ui/popover.tsx",
    exports: ["Popover", "PopoverTrigger", "PopoverContent", "PopoverAnchor"],
    height: 260,
    summary: "A floating bordered panel on the popover ground, 16px padded, anchored to a trigger: for small forms and details in place.",
    guide: `
## Use it for
Small in-place panels: a date range, a quick filter form, details behind a value. \`Combobox\` builds on it.

## Rules
- Its enter and exit classes (\`animate-in\`, \`fade-in-0\`, \`zoom-in-95\`) come from an animation plugin the product does not load, so popovers open without motion; menus and tooltips animate through their own CSS.

## The consumer provides
\`open\` / \`onOpenChange\`, \`PopoverTrigger asChild\`, \`PopoverContent\` with \`align\` and \`sideOffset\`.
`,
    preview: () => `
mount(h("div", { className: "p-4" }, h(G.Popover, { open: true },
  h(G.PopoverTrigger, { asChild: true }, h(G.Button, { variant: "outline" }, h(I.Filter), "Time range")),
  h(G.PopoverContent, { align: "start", className: "w-72 space-y-3" },
    h("p", { className: "text-sm font-medium" }, "Show events from"),
    h("div", { className: "grid grid-cols-2 gap-2" }, h(G.Input, { defaultValue: "2026-09-19" }), h(G.Input, { defaultValue: "2026-09-26" })),
    h("div", { className: "flex justify-end gap-2" }, h(G.Button, { size: "sm", variant: "outline" }, "Reset"), h(G.Button, { size: "sm" }, "Apply"))
  )
)));
`,
  },
  {
    name: "ConfirmDialog",
    group: "Overlays",
    source: "src/components/common/ConfirmDialog.tsx",
    exports: ["ConfirmDialog", "confirm", "confirmAction", "useConfirmDialog"],
    height: 320,
    width: 820,
    summary: "The one confirmation dialog, driven by confirm() and confirmAction(): a title, the consequence, Cancel and a destructive confirm that shows pending while the action runs.",
    guide: `
## Use it for
Every irreversible or disruptive action: delete, remove, revoke, stop, restart. Mount \`<ConfirmDialog />\` once (the layout does) and call:

- \`await confirm({ title, description, confirmLabel })\` → \`true\` or \`false\`, then run the action with its own pending state; or
- \`confirmAction({ … }, action)\`: the dialog stays open with the confirm button \`pending\` until the action resolves, and cannot be dismissed meanwhile. Prefer it.

## Rules
- \`variant\` defaults to \`destructive\`; pass \`default\` for non-destructive confirmations.
- Title: the action and object ("Remove Volume", "Revoke CA"). Description: the consequence, specific ("Any data stored in this volume will be permanently lost."; "This action cannot be undone." when true). Confirm label: the verb ("Remove", "Revoke CA"), never "OK" or "Yes".
- \`locked\` hides Cancel's escape routes for flows that must be answered.

## The consumer provides
Nothing to render beyond the one mounted instance; the options object per call.
`,
    preview: () => `
function Demo() {
  React.useEffect(function () {
    var cycle = function () {
      G.confirmAction({ title: "Remove Volume", description: "Remove volume \\"pgdata\\"? Any data stored in this volume will be permanently lost.", confirmLabel: "Remove" }, function () { return new Promise(function () {}); });
      setTimeout(function () { G.useConfirmDialog.getState().setPending(true); }, 2200);
    };
    cycle();
    var t = setInterval(function () { G.useConfirmDialog.getState().close(); setTimeout(cycle, 400); }, 4600);
    return function () { clearInterval(t); };
  }, []);
  return h(G.ConfirmDialog);
}
mount(h(Demo));
`,
  },
  {
    name: "OneTimeSecretDialog",
    group: "Overlays",
    source: "src/components/common/OneTimeSecretDialog.tsx",
    exports: ["OneTimeSecretDialog"],
    height: 360,
    width: 820,
    summary: "Shows a freshly created secret once: \"<Thing> Created\", a description that says it won't be shown again, the value in a copy field, and Done.",
    guide: `
## Use it for
Every token, key or password Opfield shows once: API, deploy, inference and ingest tokens, storage access keys, node and relay enrollment tokens. The secret leaves state when the dialog finishes closing (\`onClosed\`).

## Rules
- No warning tint: the description carries the notice ("Copy it now — it won't be shown again.").
- One copy field per value (an access key ID and its secret are two fields); extra content such as a setup command goes in \`children\` above them.
- The footer holds a single Done.

## The consumer provides
\`open\`, \`onOpenChange\`, \`title\`, optional \`description\`, \`fields\` (\`{ label, value, hint? }[]\` or null), optional \`children\`, \`onClosed\`, \`className\` for a wider dialog.
`,
    preview: () => `
mount(h(G.OneTimeSecretDialog, { open: true, onOpenChange: function () {}, title: "API Token Created", fields: [{ label: "API token", value: "opf_4be1a0f2c9d84d6e9a7f1b3c5d7e9f01" }], onClosed: function () {} }));
`,
  },
  {
    name: "FolderCreateDialog",
    group: "Overlays",
    source: "src/components/common/FolderCreateDialog.tsx",
    exports: ["FolderCreateDialog", "FolderRenameDialog"],
    height: 300,
    width: 820,
    summary: "The small dialog that names a folder: Create Folder (Cancel, Create) and Rename Folder (the current name prefilled, Cancel, Save).",
    guide: `
## Use it for
Creating, and through \`FolderRenameDialog\`, renaming folders and subfolders in foldered lists (routes, containers, databases). Folders are never renamed in place in the row.

## Rules
- Enter submits; Create and Save stay disabled while the name is blank and show \`pending\` while the request runs.

## The consumer provides
\`FolderCreateDialog\`: \`open\`, \`onOpenChange\`, \`title\`, \`description\`, \`initialName\`, \`onCreate(name)\`. \`FolderRenameDialog\`: \`open\`, \`onOpenChange\`, \`folderName\`, \`onRename(name)\`. Shared foldered lists open the rename dialog from the folder row menu themselves.
`,
    preview: () => `
mount(h(G.FolderCreateDialog, { open: true, onOpenChange: function () {}, initialName: "Production", onCreate: function () { return new Promise(function () {}); } }));
`,
  },
  {
    name: "AvatarCropDialog",
    group: "Overlays",
    source: "src/components/common/AvatarCropDialog.tsx",
    exports: ["AvatarCropDialog"],
    height: 700,
    width: 820,
    summary: "Crops a picked image to a square avatar: drag to position, a zoom slider, Cancel and Upload with pending.",
    guide: `
## Use it for
The profile avatar upload. The result is a square image under 1 MB.

## The consumer provides
\`file\`, \`open\`, \`uploading\`, \`onOpenChange\`, \`onUpload(blob)\` returning whether it succeeded.
`,
    preview: () => `
var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="#1a1a1a"/><rect x="200" y="120" width="240" height="240" fill="#3b3d87"/><rect x="260" y="180" width="120" height="120" fill="#f5f5f5"/></svg>';
var file = new File([svg], "avatar.svg", { type: "image/svg+xml" });
mount(h(G.AvatarCropDialog, { file: file, open: true, uploading: false, onOpenChange: function () {}, onUpload: function () { return Promise.resolve(true); } }));
`,
  },
  {
    name: "Command",
    group: "Overlays",
    source: "src/components/ui/command.tsx",
    exports: ["Command", "CommandInput", "CommandList", "CommandEmpty", "CommandGroup", "CommandItem", "CommandSeparator", "CommandShortcut"],
    height: 400,
    summary: "The command palette's building blocks (cmdk): a search input, grouped items with an accent highlight, shortcuts and an empty message.",
    guide: `
## Use it for
The command palette (⌘K) and searchable pickers that act on selection. The app's palette lists pages, resources and the current page's header actions.

## Rules
- Group headings are \`text-xs font-medium\` muted; the selected item takes the accent fill.
- Shortcuts sit at the right in muted \`text-xs tracking-widest\`.

## The consumer provides
\`Command\` (with \`shouldFilter\`), \`CommandInput\`, \`CommandList\` with \`CommandEmpty\`, \`CommandGroup heading\` and \`CommandItem\`s.
`,
    preview: () => `
mount(stage(h("div", { className: "w-[28rem] border border-border shadow-md" }, h(G.Command, null,
  h(G.CommandInput, { placeholder: "Search pages, resources and actions..." }),
  h(G.CommandList, null,
    h(G.CommandEmpty, null, "No results found."),
    h(G.CommandGroup, { heading: "Pages" }, h(G.CommandItem, null, h(I.Globe), "Routes", h(G.CommandShortcut, null, "G R")), h(G.CommandItem, null, h(I.Server), "Nodes", h(G.CommandShortcut, null, "G N")), h(G.CommandItem, null, h(I.Database), "Databases")),
    h(G.CommandSeparator),
    h(G.CommandGroup, { heading: "Actions" }, h(G.CommandItem, null, h(I.Plus), "Add Route"), h(G.CommandItem, { disabled: true }, h(I.Trash2), "Delete selected"))
  )
))));
`,
  },
  {
    name: "Toaster",
    group: "Overlays",
    source: "src/components/ui/sonner.tsx",
    exports: ["Toaster"],
    height: 300,
    width: 820,
    summary: "Sonner toasts, always dark zinc with a close button, square, stacked at the bottom right, for the result of an action.",
    guide: `
## Use it for
The outcome of an action that did not navigate: "Folder created", "Copied", "Failed to load Docker nodes". Errors of a form stay in the form.

## Rules
- Copy: past tense for success ("Template deleted", "Provider connected"), "Failed to <verb> <object>" for errors; no trailing period, no exclamation marks.
- Toasts ignore the theme on purpose: \`#27272a\` ground, \`#fafafa\` text, \`#a1a1aa\` descriptions in both themes.
- Mount one \`Toaster\` (the layout does); call \`toast.success\`, \`toast.error\` or \`toast\` from \`sonner\`.

## The consumer provides
Toaster props from sonner (\`position\`, \`expand\`, …); \`theme\` and \`closeButton\` are fixed.
`,
    preview: () => `
function Demo() {
  React.useEffect(function () {
    G.toast("Opfield settings updated", { duration: Infinity });
    G.toast.error("Failed to load Docker nodes", { duration: Infinity, description: "edge-2 did not answer within 10 seconds." });
    G.toast.success("Folder created", { duration: Infinity });
  }, []);
  return h(G.Toaster, { expand: true });
}
mount(h(Demo));
`,
  },
];
