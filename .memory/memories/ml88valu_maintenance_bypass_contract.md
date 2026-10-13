---
{
  "id": "ml88valu",
  "file_name": "ml88valu_maintenance_bypass_contract",
  "tags": [
    "frontend",
    "maintenance",
    "nginx",
    "proxy",
    "security-contract"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786611160900,
  "updated_at": 1791851744903
}
---
Managed proxy maintenance bypass exposes a session-level boolean at GET /_gateway/maintenance-access/status while the capability-backed maintenance guard is active. Nginx derives {"active":true|false} from its existing secure_link validation, returns no-store JSON, and never exposes or forwards the HttpOnly bypass cookies. This signal proves only that the current browser has a valid host-bound bypass session; it does not identify an Opfield user and must not be treated as application authentication. In legacy maintenance mode without daemon capability, the status endpoint is intentionally absent.
