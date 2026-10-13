# Update Trust Anchor

`update-signing-public-key.pem` is the canonical repo-wide update signing public key used by both Gateway backend and daemons.

The daemon Go package needs a package-local generated copy for `go:embed`. The package-local backend Dockerfile also needs a context-local copy for standalone package builds. Run `scripts/sync-update-trust-anchor.sh` after rotating this key; daemon build, test, lint, and CI paths run that sync automatically.

`opencodex-signing-public-key.pem` is the independent trust anchor for signed
image manifests of the managed inference core, opfield-inference (built from OpenCodex). Its private key exists only in the
protected OpenCodex release pipeline.
