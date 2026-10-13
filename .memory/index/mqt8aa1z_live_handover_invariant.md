---
{
  "id": "mqt8aa1z",
  "file_name": "mqt8aa1z_live_handover_invariant",
  "tags": [
    "concurrency",
    "live-handover",
    "relayresume",
    "root-cause",
    "rsv1"
  ],
  "layer": "lite",
  "ref": "e0oqvuoo",
  "created_at": 1791495928486,
  "updated_at": 1791495928486
}
---
[→ e0oqvuoo] Live handover invariant: after Session.HandoverState the old process must not act on the peer's records or answer/begin RESUMEs until thaw/detach (Session.sealed)
