# New Opfield instance setup

Use this reference when the user has no usable Opfield control plane, receives `SETUP_REQUIRED`, or needs the first Nodes required for the selected workload. Installation, browser onboarding, Node enrollment, MCP OAuth, and application deployment are separate boundaries; complete each before claiming the next is ready.

## Choose the starting point

- No Opfield installation: install the control plane, then complete the browser wizard.
- Stack installed but normal APIs return `423 SETUP_REQUIRED`: use the installer-provided URL and one-time setup code. Do not reinstall.
- Wizard complete but no suitable Nodes: enroll only the roles required by the workload.
- Instance and Nodes ready but MCP unavailable: continue with [MCP connection](connection.md).

When MCP is already connected, use `read_opfield_documentation` for the current installation and Node requirements. Before MCP exists, use the checked-out Opfield installation documentation and UI-generated enrollment commands as the source of truth.

## Install the control plane

The supported release installer is:

```bash
curl -fsSL https://get.opfield.dev | bash
```

Run it only on an isolated Linux VM or dedicated trusted host meeting the current requirements. Native HTTPS on port `3000` is the default. Choose plaintext HTTP only deliberately behind a trusted TLS terminator. Use `--dry-run` when the goal is to verify the signed release and rendered flow without installation.

Installation is an explicit infrastructure mutation. Do not run it merely because shell access exists.

The installer prints a URL, System CA fingerprint, and one-time setup code. Treat the code as a credential. Let the user enter it in the browser or use an authorized interactive browser session without repeating it in chat, logs, repository files, memory, or the final response.

## Complete onboarding

The browser wizard configures the canonical public URL, daemon enrollment targets, sign-in methods, first administrator, structured logging, and optional AI Workspace and Inference. Detected addresses are suggestions; choose addresses reachable by future Nodes. A reverse-proxied browser URL does not automatically make the proxy a valid daemon gRPC target.

Finish the wizard before Node enrollment or MCP login. Until completion, ordinary product and authentication APIs remain locked with `423 SETUP_REQUIRED`.

## Enroll only required roles

Use the authenticated UI or guided finalization flow and the generated one-time enrollment command. Never reconstruct Node IDs, tokens, targets, or fingerprints.

- `nginx` / Ingress: Domains, TLS, Routes, and Pages publication.
- `docker`: Containers, Deployments, images, volumes, networks, and Compose Projects.
- `builder`: isolated Git builds and artifact scanning. Keep it separate from unrelated workloads and control-plane credentials.
- `storage`: managed PostgreSQL, key-value stores, ClickHouse, managed SeaweedFS object storage, and bounded backup jobs. The legacy `databases` role is database-only; use `storage` for new capacity.
- `monitoring`: monitoring capabilities when required.
- `relay`: outbound connectivity topology when required by the installation.

Wait until Opfield reports each Node online and capability-compatible. Report control plane, onboarding, Nodes, Builds, MCP, application resource, Route, DNS, and TLS readiness separately.

For later enrollment, daemon updates, service addresses, and Node repair, use the `managing-nodes` skill.
