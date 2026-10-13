---
{
  "id": "ip47mets",
  "file_name": "ip47mets_gateway_api_verification",
  "tags": [
    "design-system",
    "frontend",
    "opfield",
    "primitives",
    "viewer",
    "widgets"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1781442235588,
  "updated_at": 1791851673630
}
---
Status (verified 2026-10-01): @wiolett/design-system and its viewer exist only on the unmerged branches `codex/design-system` (2026-06-09) and `codex/design-system-viewer` (2026-06-17). Main has no `packages/design-system`; the production kit is `packages/frontend/src/components/ui` plus `components/common`. Use this contract only if that work is revived.

Opfield design-system (DS) architecture contract (branch-only):
- When work asks to populate or expand @wiolett/design-system or its viewer, prioritize the library and registry docs. Do not migrate the main frontend or AI assistant UI unless that scope is explicit.
- Use existing frontend UI as the visual source of truth; public DS APIs should expose generic components, not page/domain wrappers or accidental Radix-style subparts.

Layering:
- Primitives are low-level controls such as Button, Checkbox, Input, Textarea, Combobox, Select, Table, DataTable, Badge, Switch, Tabs, Dialog, Tooltip, ScrollArea, Sparkline, ProgressBar, IconGlyph, and real Typography primitives.
- Widgets are composed generic patterns such as RefreshButton, Header, SearchFilterBar, CodeEditor, StatCard, ScopeList, FolderTree, TerminalSurface, EntityListPanel, and EditableGrid.
- Helpers live under components/helpers; PageTransition and ConfirmDialog are helpers. ErrorBoundary remains frontend/app-shell infrastructure.
- Typography stays limited to distinct contracts: PageTitle, SectionTitle, FieldLabel, BodyText, Caption, Overline, MonoText, and CodeText. Do not add aliases without a distinct semantic/style contract.

Key component boundaries:
- ScopeList is a generic grouped checklist; Opfield resource mappings stay in frontend consumers. Its own search input follows the AdminGroups selector geometry, not SearchFilterBar.
- Combobox owns generic input/suggestion behavior; consumers own domain data and APIs.
- FolderTree owns generic folders/items/renderItem/dnd data; consumers own resource rows and persistence.
- Command palette stays in the frontend because it depends on app routing/auth/stores/API/AI.
- TerminalSurface owns xterm presentation/resize/input APIs; consumers own WebSockets, reconnect, auth, and BroadcastChannel.
- CodeEditor is a widget with exported CodeMirror presets plus pluggable highlighting/extensions; keep frontend-like editor/gutter geometry.
- StatCard is a widget composed from metric primitives.
- Table is for small native lists; DataTable owns its virtualized grid/scroll container.

Public style contracts:
- Button has no size prop and defaults to 36px height; icon-only width may use className.
- Badge is uppercase with borderless color variants.
- Checkbox is one Radix-backed primitive; Textarea is non-resizable by default.
- Registry docs expose behavior through props/controls and cover layouts, primitives, typography, widgets, and helpers.

Verification: lint, typecheck, test and build both @wiolett/design-system and design-system-viewer, then git diff --check and browser-smoke visible/interactive viewer changes; run frontend checks only when the main frontend is touched.
