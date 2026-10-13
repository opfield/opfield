---
{
  "id": "j6oni2tm",
  "file_name": "j6oni2tm_gateway_compose_boundary",
  "tags": [
    "architecture",
    "compose",
    "docker",
    "documentation",
    "licensing",
    "opfield",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1787483483982,
  "updated_at": 1791851691865
}
---
# Opfield Docker Compose Projects: status and original design boundary

Status (verified in main on 2026-10-01): first-class Compose Projects are implemented and shipped, so the 2026-08-24 rule "describe Compose lifecycle as planned/in development" is obsolete.
- Backend: `packages/backend/src/modules/docker/compose/*` (discovery, dispatcher, node dispatcher, policy, managed bindings, routes/docs) and schema `docker-compose.ts` with `management_state` external | managed (default external).
- Scopes: `docker:compose:view/create/manage/delete`. Managed Compose is licence-gated as feature `compose-applications` (Personal plan and up as of 2026-10-01; the original plan said Business). Pages is also a Personal-and-up feature.
- The Compose host services are Community contracts implemented by the private core (see the edition-contract rule: new host methods need `config/editions/extraction.json`).
- Compose now supports Git-source builds (`ComposeGitBuildSpec`), which supersedes the original "reject `build` because Opfield has no build workers" rule; Opfield has Docker build workers today.

Original accepted boundary (plan `.workflow/plans/08-24-26-first-class-compose-projects`, 2026-08-24). Treat these as design intent and check `compose-policy.ts` before relying on any single rule:
- Compose Projects are a Docker resource; do not introduce or depend on an Apps model.
- External projects are discovered from Docker labels, read-only, and visible with Compose view RBAC. Adoption requires a complete single Compose YAML supplied by the user; Opfield does not read host compose paths, and the project stays external until the first apply succeeds.
- Reuse Docker folders and the existing shell/list/detail/editor/log/task patterns, with one reusable Compose logs view.
- Compose-owned containers, named volumes and non-external networks are hidden from global standalone lists, and direct mutations are blocked server-side. Images and external/shared resources remain global.
- The daemon owns Compose execution through a typed Opfield protocol; the backend never runs Compose and no host `docker compose` CLI is assumed.
- Originally rejected: multi-file/override/include/extends, `env_file`, file configs/secrets, profiles/develop/replicas/scale, host binds, `docker.sock`, privileged/devices, host network/pid/ipc.
- Revisions are immutable, drafts are not persisted, ordinary apply does not force-pull present mutable tags (Pull & Apply is separate), Down preserves named volumes, reapplying an older revision is configuration rollback only, and drift is shown, never auto-reconciled.
