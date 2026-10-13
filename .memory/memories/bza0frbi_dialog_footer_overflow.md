---
{
  "id": "bza0frbi",
  "file_name": "bza0frbi_dialog_footer_overflow",
  "tags": [
    "dialog",
    "frontend",
    "layout",
    "overflow"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1791490930841,
  "updated_at": 1791490930841
}
---
`components/ui/dialog.tsx` DialogContent sorts its children into header/body/footer slots by `type.displayName` ("DialogHeader"/"DialogFooter"). A wrapper component around DialogFooter (e.g. `AccessDialogFooter`) is NOT recognized unless it sets `displayName = "DialogFooter"`; it then lands in the body, the body gets `grid gap-4` (2+ children), and grid items' `min-width: auto` let the widest non-wrapping text (truncate rows) widen the track past the dialog — `truncate`/`min-w-0` on the rows does nothing. Seen as F-5 in v2.11.4-rc.6 (user dialog content 755 px in 512 px, Save Changes off-dialog). Fixed by the displayName and by making the multi-child body `grid grid-cols-1` (minmax(0,1fr)). jsdom tests can only assert classes/slot placement; real widths need a browser (vite dev server + Playwright measuring getBoundingClientRect/scrollWidth reproduced the stand numbers exactly).
