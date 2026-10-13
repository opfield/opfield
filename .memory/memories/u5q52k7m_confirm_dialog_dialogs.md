---
{
  "id": "u5q52k7m",
  "file_name": "u5q52k7m_confirm_dialog_dialogs",
  "tags": [
    "confirm-dialog",
    "dialogs",
    "frontend",
    "regression-pattern",
    "ui-contract"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.82,
  "created_at": 1785449001135,
  "updated_at": 1791851872708
}
---
Opfield frontend modal convention: the shared ConfirmDialog must render its confirmation description as a top-level DialogDescription body child outside DialogHeader. Do not add or restore an opt-in bodyDescription flag; that inverted contract caused callers without the flag to render operational/warning copy as a header subtitle. Keep short contextual subtitles, step labels, and identifiers inside DialogHeader, but move long instructions, warnings, and security disclosures into the dialog body. Regression tests can assert placement via data-dialog-body and data-dialog-header.
