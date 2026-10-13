---
{
  "id": "bf8b2nk9",
  "file_name": "bf8b2nk9_responsive_header_actions",
  "tags": [
    "frontend",
    "header-actions",
    "responsive",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.82,
  "created_at": 1786045900381,
  "updated_at": 1791851431329
}
---
Opfield responsive header-action contract: use the shared ResponsiveHeaderActions component for page-level action groups. It must collapse to the Page actions ellipsis when the measured header width cannot retain at least 320px for the page title/content; a viewport-only breakpoint is insufficient because a desktop sidebar can reduce available content width. The component measures its header parent with ResizeObserver and keeps the command-palette registration unchanged. Verify the pure collapse threshold and a DOM case that forces a narrow header, plus frontend build and Biome.
