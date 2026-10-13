---
{
  "id": "02e60mqr",
  "file_name": "02e60mqr_gateway_daemon_rc",
  "tags": [
    "daemon",
    "docker",
    "github-actions",
    "opfield",
    "rc",
    "relay",
    "release"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1785765229346,
  "updated_at": 1791851095383
}
---
Opfield and daemon release conventions, verified against the repository on 2026-09-02 and re-checked against `scripts/release-tag.sh` and `.github/workflows` on 2026-10-01:

Versioning and tag classification
- scripts/release-tag.sh is authoritative.
- Opfield tags are vX.Y.Z and vX.Y.Z-rc.N.
- Component tags append the component after the complete Opfield version: `-relay`, `-nginx`, `-docker`, `-monitoring`, `-watchdog` (for example vX.Y.Z-rc.N-docker). The `-relay` tag also builds the secure-link connector.
- Do not use vX.Y.Z-<component>-rc.N. That older ordering is not accepted by the classifier.
- For a component tag, RELEASE_VERSION is the tag with the final component suffix removed. For example, v2.10.0-rc.28-docker embeds/signs v2.10.0-rc.28.
- There is no version-bump commit: versions come from the tag. Tags are annotated and the tag message is the changelog (plain `- ` bullets).

GitHub release order
- The repository remote is GitHub (`the-square-labs/gateway`); `.gitlab-ci.yml` no longer exists. Workflows: `ci.yml`, `image.yml`, `release.yml`, `npm-publish.yml`.
- Push main first and verify the local and remote SHA match.
- Wait for a successful push-triggered main CI run for the exact target SHA. Release verification rejects a tag when no successful main CI exists for that SHA.
- Push an annotated Opfield RC tag, wait for the release workflow to finish, and verify the published non-draft prerelease plus signed manifest and installer assets.
- Push only the component tags required by the changed binaries, then verify each component workflow and published assets.
- GitHub creates no push events when more than three tags arrive in one push, so the release workflow silently never starts. Push tags separately (the owner prefers one tag per push) and confirm each run appears before pushing the next.
- Do not equate a pushed tag with a completed release.

Component selection
- Backend/control-plane changes require an Opfield tag.
- Docker daemon code or its generated protobuf bindings require a Docker component tag.
- Tag a daemon only when its own code or the shared daemon packages it imports changed; mixed versions across components are fine.
- The relay is an opaque byte-level gRPC proxy for unknown services. A protobuf field added only to GatewayCommand does not by itself require a relay rebuild or relay tag when relay code and dependencies are unchanged.
- Preserve operational upgrade order backend, relay when changed, then daemons.

Release verification
- Confirm scripts/release-tag.sh classifies each candidate tag correctly.
- Run release metadata checks and the change-specific gates.
- Confirm exact remote tag peeling to the intended commit.
- Confirm GitHub Actions success and inspect the published release assets.
- Production deployment remains separate from source push and release publication.

Compatibility loaders and signed artifacts
- Preserve curl-first and wget fallback behavior for installers.
- Opfield releases must publish a valid signed gateway-image.update.json containing the immutable top-level OCI image digest. A wrong digest surfaces as Opfield update verification errors such as "Gateway update digest is invalid" / UNTRUSTED_UPDATE_ARTIFACT; the historical v2.3.0 and v2.3.1 manifests had this defect, so never target those manifests.
- Component releases must publish signed per-architecture update manifests, binaries, and checksums.
- Stable automatic-update behavior remains separate from prerelease/nightly selection.
