---
{
  "id": "c3nk8hzp",
  "file_name": "c3nk8hzp_preserve_dialog_payload",
  "tags": [
    "dialog",
    "frontend",
    "totp",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.82,
  "created_at": 1785707696750,
  "updated_at": 1791851455798
}
---
For Opfield-controlled dialogs that transition to a follow-up dialog, do not clear payload state when `open` flips to false. Retain the outgoing dialog's data until the shared CSS exit duration has elapsed (use 250 ms for mobile, 200 ms for desktop). After that delay, clear the data and open the next dialog. This prevents QR codes or secrets from disappearing during the closing animation.
