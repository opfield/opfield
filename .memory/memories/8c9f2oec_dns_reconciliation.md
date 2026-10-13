---
{
  "id": "8c9f2oec",
  "file_name": "8c9f2oec_dns_reconciliation",
  "tags": [
    "cloudflare",
    "dns",
    "domains",
    "ingress",
    "nginx",
    "proxy-hosts"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1786646672645,
  "updated_at": 1791851285058
}
---
Opfield Domain ingress contract: a registered Domain targets one eligible Nginx node whose effective address is selected deterministically from daemon-reported publicly routable IPs; private, unreported, custom, and IANA special-purpose addresses are ineligible, while IANA globally reachable exceptions inside broader protocol ranges remain eligible. Domain names are canonicalized to lowercase, and a Domain plus exact or wildcard Proxy Host usage must share the same Nginx node; lookup must cover both base and wildcard registrations and compare legacy JSONB values case-insensitively. Existing domains backfill by unambiguous Proxy Host affinity, or the first eligible node only when unused; ambiguous/ineligible usage remains unresolved. Legacy-provider domains receive node affinity without inventing a managed DNS target and continue normal resolved-DNS evaluation. Health/startup reconciliation may backfill and repair drift to the stored target but must never silently retarget an established Domain when a node address changes. A user-confirmed node target change requires domains:edit and stores the node address plus pendingDnsTargetIp atomically; success and failure persistence must use target-aware CAS so an older run cannot clear, overwrite, or invalidate a newer intent. Transient provider failures remain retryable. Cloudflare reconciliation mutates only tracked address records, refuses every untracked A/AAAA/CNAME before mutation, uses a stable Opfield ownership comment to recover a replacement created before a database failure, and edits records with PATCH so omitted Cloudflare metadata is preserved. Node-only errors expose affected counts without Domain names. Retain the restrictive Domain-to-node FK and the pre-delete domain assignment check.
