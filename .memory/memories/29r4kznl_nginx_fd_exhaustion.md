---
{
  "id": "29r4kznl",
  "file_name": "29r4kznl_nginx_fd_exhaustion",
  "tags": [
    "file-descriptors",
    "incident",
    "nginx",
    "provisioning"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.88,
  "created_at": 1787844764519,
  "updated_at": 1791851124832
}
---
Opfield nginx ingress file-descriptor exhaustion hardening:

- If Nginx begins returning broad HTTP failures and logs `accept4()`, `socket()`, or `open()` with errno 24, inspect both the worker process open-file limit and `events.worker_connections`.
- The managed Opfield Nginx provisioning/template should set `worker_rlimit_nofile 65535` and `worker_connections 8192` so workers do not inherit a low service limit.
- Validate generated configuration with `nginx -t` and apply it with a graceful reload.
- Verify the new worker limits and representative proxy, configuration, and static-asset requests after reload.
- Treat direct host edits as emergency mitigation only: package or base-configuration updates can overwrite them, so the durable fix belongs in Opfield-owned provisioning/templates.
