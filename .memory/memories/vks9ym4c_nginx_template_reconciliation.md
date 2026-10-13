---
{
  "id": "vks9ym4c",
  "file_name": "vks9ym4c_nginx_template_reconciliation",
  "tags": [
    "dns",
    "ipv6",
    "nginx",
    "production-validation",
    "proxy",
    "templates"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1787839113583,
  "updated_at": 1791851898681
}
---
# Opfield Nginx upstream IPv6 and template regeneration

## Upstream IPv6

- Opfield proxy hosts expose `Settings → Upstream → upstreamIpv6Enabled`, defaulting to `false`.
- For managed manual hostname upstreams with IPv6 disabled:
  - Render runtime DNS resolution through Opfield’s configured IPv4 `DNS_RESOLVERS`.
  - Include `ipv6=off`.
  - Use compact deterministic Nginx variable names (currently a `gw_up_` prefix plus 16 hex characters) so production defaults such as `variables_hash_bucket_size 64` remain valid.
  - Validate generated configs against the production Nginx version with realistic generated identifier lengths; a minimal syntax test with a shorter placeholder can miss hash-bucket failures.
  - Leave IP-literal upstreams and Secure Link upstreams unchanged.
- Enabling `upstreamIpv6Enabled` preserves native dual-stack DNS resolution.

## Template regeneration

- Changes to Nginx template content or variables must sequentially regenerate every enabled route assigned to that template.
- Isolate failures per route so one failure does not prevent processing others.
- Built-in template updates must also include enabled routes of the matching type using the default template (`nginxTemplateId IS NULL`).
- Changing a built-in template does not rewrite already-applied configurations; affected managed proxy hosts/nodes must be reapplied.
- Raw/custom templates remain explicit operator-managed escape hatches.

Related contracts kept in their own memories (not duplicated here): access-list directive injection (allow/deny/auth_basic stay in `location /` and are injected into advanced locations), Domain-to-Nginx-node affinity and Cloudflare DNS reconciliation, and node service addresses.
