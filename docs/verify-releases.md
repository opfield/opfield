# Verifying Releases

Every Opfield release can be checked in three independent ways:

| Layer | What it covers | Who checks it |
| --- | --- | --- |
| Signed update manifests (Ed25519) | The image digest or binary checksum of each release, its version and the commit it was built from | Opfield and its daemons, automatically, before every install and update |
| Image signatures (Sigstore, keyless) | Every image Opfield publishes, signed by the GitHub Actions workflow that built or mirrored it and recorded in the public Rekor transparency log | Anyone, with `cosign` |
| SBOMs (SPDX JSON) | The packages inside each image and release binary | Anyone: release assets, and signed attestations on each image |

The manifests are the trust root installations rely on. Image signatures and SBOMs let you check the same artifacts
without Opfield's own tooling.

## Image signatures

Opfield images are signed with [cosign](https://docs.sigstore.dev/cosign/) keyless signing: there is no long-lived
signing key. Each signature carries a short-lived certificate for the identity of the workflow run that produced it,
and is recorded in the Rekor transparency log. Use cosign 3.0 or later.

Release images are signed by the Release workflow for the release tag:

```bash
cosign verify ghcr.io/opfield/opfield:v2.12.0 \
  --certificate-identity https://github.com/opfield/opfield/.github/workflows/release.yml@refs/tags/v2.12.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify ghcr.io/opfield/opfield/relay:v2.12.0-relay \
  --certificate-identity https://github.com/opfield/opfield/.github/workflows/release.yml@refs/tags/v2.12.0-relay \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

`…/secure-link-connector:vX.Y.Z-relay` is signed the same way as the relay.

Images built on `main` and pinned by digest are signed by the Image workflow: the backup runner, the patched
SeaweedFS (`…/seaweedfs-gateway`) and the mirrored third-party images (PostgreSQL, Redis, Valkey, ClickHouse, the
Docker registry and others, listed in `config/third-party-images.json`). Accept any workflow of the repository:

```bash
cosign verify ghcr.io/opfield/opfield/backup-runner:v2.12.0 \
  --certificate-identity-regexp '^https://github\.com/opfield/opfield/\.github/workflows/(image|release)\.yml@refs/(heads/main|tags/v.+)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A signature on a mirrored third-party image means that Opfield's workflow copied exactly that upstream digest. It
does not mean Opfield built the image.

The inference core is released from its own repository:

```bash
cosign verify ghcr.io/opfield/inference-core:v2.60.0-opfield.1 \
  --certificate-identity-regexp '^https://github\.com/opfield/inference-core/\.github/workflows/inference-release\.yml@refs/tags/v.+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Releases are also published with the same digests under `ghcr.io/the-square-labs/gateway` and
`ghcr.io/the-square-labs/inference-core`, the repositories earlier versions use. Those copies carry their own
signatures from the same workflows, so the commands above work with either repository name.

To verify the exact digest a release names, use `repository@sha256:<digest>` instead of a tag. The digest is the
`imageRef` in the release's signed manifest, for example `gateway-image.update.json` (see below).

## SBOMs

Each release lists an SPDX JSON SBOM made with [syft](https://github.com/anchore/syft) for every image and binary it
publishes:

| Release | SBOM assets |
| --- | --- |
| Opfield `vX.Y.Z` | `opfield-vX.Y.Z.spdx.json`, `backup-runner-vX.Y.Z-linux-amd64.spdx.json`, `backup-runner-vX.Y.Z-linux-arm64.spdx.json` |
| Relay `vX.Y.Z-relay` | `relay-vX.Y.Z-relay.spdx.json`, `secure-link-connector-vX.Y.Z-relay.spdx.json`, `relay-supervisor-linux-<arch>.spdx.json`, `relay-worker-linux-<arch>.spdx.json` |
| Daemons (`-nginx`, `-docker`, `-monitoring`, `-watchdog`) | `<daemon>-linux-<arch>.spdx.json` |
| Inference core | `inference-core-<tag>-linux-amd64.spdx.json`, `inference-core-<tag>-linux-arm64.spdx.json` |

The same SBOMs are attached to the images as signed in-toto attestations (predicate type `spdxjson`). For a
multi-architecture image the attestation is on each platform image, so look up the platform digest first:

```bash
docker buildx imagetools inspect ghcr.io/opfield/opfield/backup-runner:v2.12.0

cosign verify-attestation --type spdxjson \
  --certificate-identity-regexp '^https://github\.com/opfield/opfield/\.github/workflows/(image|release)\.yml@refs/(heads/main|tags/v.+)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/opfield/opfield/backup-runner@sha256:<linux/amd64 digest> |
  jq -r '.payload' | base64 -d | jq '.predicate.packages | length'
```

The Opfield and relay images are single-platform, so their tag works directly with `cosign verify-attestation`.

## Signed update manifests

Opfield and its daemons install an update only after verifying an Ed25519-signed manifest against the public key
compiled into them, `config/update-trust/update-signing-public-key.pem` (DER SHA-256
`bb0dc295405fdcf2ffe7dfb98381079abeae98c5c938d168e70b00965b3697ad`). The inference core has its own key,
`config/update-trust/opencodex-signing-public-key.pem` (DER SHA-256
`312dc780ca21719cd9f3585c0f63de9f9e36d6b33af710e5d0c28939fd7e741f`). Check a key's fingerprint with:

```bash
openssl pkey -pubin -in update-signing-public-key.pem -outform DER | sha256sum
```

Each release carries its manifests as `*.update.json` assets (`gateway-image.update.json`, `relay-image.update.json`,
`<daemon>-linux-<arch>.update.json`; `opencodex-image.update.json` for the inference core). A manifest is a JSON
envelope whose `payload` and `signature` are unpadded base64url. To check one by hand (OpenSSL 3.0 or later):

```bash
python3 - gateway-image.update.json <<'PY'
import base64, json, sys
envelope = json.load(open(sys.argv[1]))
decode = lambda value: base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
open('payload.json', 'wb').write(decode(envelope['payload']))
open('payload.sig', 'wb').write(decode(envelope['signature']))
PY
openssl pkeyutl -verify -pubin -inkey update-signing-public-key.pem -rawin -in payload.json -sigfile payload.sig
jq . payload.json
```

`Signature Verified Successfully` confirms the payload. Its `image` and `digest` (or `sha256` for a binary) name the
exact artifact, and `gitCommitSha` the commit it was built from.

## Release notes

Each release's notes are the message of its annotated Git tag, published on the
[GitHub release](https://github.com/opfield/opfield/releases) for that tag. See [CHANGELOG.md](../CHANGELOG.md).

## For maintainers

Image signing and SBOMs run when the repository variable `SIGN_IMAGES` is `true` (in this repository and in the
inference core repository). The workflows need no secret for them: they use the run's GitHub OIDC token
(`id-token: write`). Turn it on once the repositories publish from the opfield organization, so that the signing
identity matches the commands above. With it on, the first Image run signs the builds that already exist (backup
runner, SeaweedFS, third-party mirrors); later runs skip digests that are already signed. The Ed25519 manifest signing
is separate and unchanged (`UPDATE_SIGNING_PRIVATE_KEY_PEM_B64`, see [Update Signing Operations](operations.md#update-signing-operations)).
