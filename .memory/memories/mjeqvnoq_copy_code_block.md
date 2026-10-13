---
{
  "id": "mjeqvnoq",
  "file_name": "mjeqvnoq_copy_code_block",
  "tags": [
    "copy-code-block",
    "frontend",
    "inference",
    "opfield",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.84,
  "created_at": 1786048440116,
  "updated_at": 1791852060815
}
---
`CopyCodeBlock` must retain `overflow-hidden` on its bordered grid container so its scrollable code pane and right-side copy action remain visually contained by the outer border. The copy action pane keeps its own `border-l border-input`; do not add stacking that can visually cover the divider. In the inference onboarding default-model row, explicitly override SettingsControlRow's desktop intrinsic control width with `sm:w-full sm:min-w-0 sm:max-w-[20rem]` so a Select remains within the dialog/panel rather than expanding with its content. Verify these UI layout changes with frontend Biome, production build, and git diff --check.
