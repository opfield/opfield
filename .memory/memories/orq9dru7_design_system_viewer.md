---
{
  "id": "orq9dru7",
  "file_name": "orq9dru7_design_system_viewer",
  "tags": [
    "design-system",
    "iframe",
    "opfield",
    "packaging",
    "viewer"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1781542039200,
  "updated_at": 1791851809164
}
---
Status (verified 2026-10-01): the design-system viewer exists only on the unmerged branch `codex/design-system-viewer` (2026-06-17); main has no `packages/design-system` or viewer. The iframe lessons below stay useful for any in-app preview tool.

Opfield design-system-viewer runtime and packaging contract (branch-only):
- The @wiolett/design-system package exposes built public subpaths: ., ./registry, and ./styles.css. The Viewer dev/test/build aliases these imports to packages/design-system/src/* so a clean checkout does not depend on ignored dist artifacts.
- Registry documentation should be split into typed contracts/helpers/per-component files; avoid creating files that exceed the project size gate.
- The trusted local srcDoc iframe must not use sandbox; same-document access is required. Sandboxed srcDoc caused the in-app browser to crash.
- iframe.contentDocument may initially be an incomplete about:blank/jsdom document. Ensure html, head, body, and #preview-root exist before cloning styles, applying the theme, or mounting content.
- Mount a separate React root with createRoot inside the iframe; do not portal the preview tree from the parent.
- Defer unmounting of the iframe document when replacing documents to avoid unmount-during-render warnings.
- Dialog and Tooltip previews should initialize from registry props, then transition to local state and Radix handlers. Accessibility bridges for Dialog title/description may mirror hidden nodes into the ownerDocument only when the ownerDocument differs.
- Large docs such as Table/DataTable should opt into explicit responsive DOM styles (e.g., width: calc(100vw - 4rem), maxWidth: 1400); do not constrain every PreviewFrame globally.
- Validate library/viewer linting, typechecking, builds, and focused iframe interaction checks. Include a timestamp-scoped browser smoke test so stale console messages are not misread as fresh failures.
