---
{
  "id": "0s83sww0",
  "file_name": "0s83sww0_design_system_migration",
  "tags": [
    "design-system",
    "frontend",
    "migration",
    "settings",
    "tables",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1781205744784,
  "updated_at": 1791851104351
}
---
Status (verified 2026-10-01): this contract belongs to the unmerged branch `codex/design-system-viewer` (last commit 2026-06-17). Main has no `packages/design-system`; the production frontend kit is `packages/frontend/src/components/ui` plus `components/common` (see the shared-primitives memory), and design exploration now happens on foss-design canvases. Apply the rules below only if that branch is revived.

Opfield frontend design-system migration contract (branch-only):
- Migrate explicitly scoped screens from legacy @/components/ui/*, native presentation elements, and page-level className/style overrides to @wiolett/design-system props and generic components. DS internals may use className/style; technical ref/sentinel/measurement elements may remain where no DS surface is appropriate.
- Keep application behavior, data fetching, routing, API state, and domain mappings in frontend consumers. Do not create page-specific DS components such as SettingsRow and do not move AI-assistant-specific UI into DS unless separately requested.
- On that branch, Settings, Administration (users, groups, audit log and modals), and Notifications were migrated.

Component choices:
- Use Stack/FlexLayout/GridLayout, Card/CardBody/CardContent/CardSection/CardFooter, FormRow, SurfaceGrid, BoundedStack, PageContent/PageHeader, ListRow, Field, DetailRow, KeyValueEditor, InlineCode/CodeBlock, and DS Dialog APIs.
- Table is for small non-virtualized lists with content-sized columns. DataTable owns large virtualized lists and aligned sticky headers; grid tracks use minmax(0, ...) so columns can shrink.
- CodeMirror consumers use DS CodeEditor. Multi-step wizards may keep application state, AnimatePresence, and measurement wrappers around DS surfaces.
- Add missing variants as generic additive DS props/axes and document them in a dedicated *.stories.tsx for each exported public component; do not create grouped or app-specific stories.
- Settings-specific layout/parity belongs in generic DS density/alignment/control-width props, not local CSS escape hatches. Application-specific modals and mappings remain local.

Styling:
- Do not rely on arbitrary Tailwind utilities inside the package for required surface/state colors. Prefer stable DS classes and explicit declarations.
- Keep global resets such as border-color inside the base cascade layer so frontend CSS imported after DS does not override primitive states.

Verification: DS lint/typecheck/build/build-storybook plus the touched frontend lint/typecheck/build; check exported DS components against story files; scan migrated screens for legacy imports or unapproved className/style/native elements; browser-compare the real application flow as well as Storybook because frontend CSS order can differ.
