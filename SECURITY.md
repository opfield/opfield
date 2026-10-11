# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Opfield, please report it privately.

**Do not open a public issue, pull request, or discussion.**

Email [support@opfield.dev](mailto:support@opfield.dev) with "Security" in the subject and:

- a description of the vulnerability and its potential impact;
- the affected Opfield version (and daemon, relay, or inference core version, if relevant);
- steps to reproduce or a proof of concept;
- a suggested fix, if you have one.

Please do not access, change, or delete data that is not yours, and do not test against installations you do not
operate.

## What to Expect

- **Acknowledgement** within 72 hours.
- **Initial assessment** (confirmed or not, and severity) within 7 days.
- **Status updates** at least every 7 days until the issue is resolved.
- **Fix**: we aim to release a fix for critical and high severity issues within 30 days of confirmation, and for
  other issues in a following release.
- **Disclosure**: we agree a disclosure date with the reporter, by default when the fix is released or 90 days after
  the report, whichever comes first. We credit reporters in the release notes unless they prefer otherwise.

## Supported Versions

Security fixes are released for the latest stable minor version, as a new patch release (for example 2.12.x).
Release candidates and earlier minor versions do not receive fixes; update to the latest stable release.

Daemons, relays, and the inference core are supported in the versions released for the supported Opfield version.
Opfield shows available updates and installs them through its signed update mechanism.

## Signed Releases

Opfield and its daemons install an update only after verifying an Ed25519-signed release manifest against the public
key compiled into them. Published images are also signed with Sigstore keyless signing by the GitHub Actions workflow
that published them, and each release lists SPDX SBOMs that are attached to the images as signed attestations. See
[Verifying releases](docs/verify-releases.md) for the `cosign verify` commands and manual manifest checks.

## Scope

This policy covers the Opfield code in this repository, the commercial core, the published images and release
binaries, and the installers served from get.opfield.dev.

Some behavior is a documented trust boundary rather than a vulnerability, for example that the Opfield app container
has access to the host Docker socket; see the [security model](docs/security.md). Findings that need root access to
the Opfield host, volumetric denial of service, and social engineering are out of scope.

Third-party dependencies are tracked separately. If you find a vulnerability in a dependency, please report it
upstream and notify us so we can update.
