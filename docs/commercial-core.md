# Community and the commercial core

Opfield uses one common frontend and common open-source daemon builds. Premium
backend implementations are delivered as a separately signed commercial core.
Building Community does not require access to the private repository.

Community allows 25 managed nodes, 3 users, and 1 custom permission group. The
license server still issues the v3/v4 entitlement contracts to older Opfield installations;
current installations request v5 and apply only license states signed for their own
installation and request (see [Signed license states](licensing.md#signed-license-states)).
Storage connections, external database connections/explorers, and GitLab
integration require Personal or higher under the current entitlement contract. SMB
is not a supported storage connector.

The backend owns permission and license enforcement. UI checks explain a denied
operation; they are not an authorization boundary. A valid license with an absent
or invalid core is reported separately from an insufficient plan.

## License gates

Every paid gate in the host and the commercial core uses one of two checks:

- **Current plan** (`requireFeature`/`hasFeature`): creating paid resources,
  changing their configuration or data, paid-only operations, and the paid service
  features SIEM forwarding and external Docker-client registry access. It passes
  while the plan is valid and during the expiration, offline, and downgrade grace
  periods.
- **Existing runtime** (`requireFeatureForExistingRuntime`/`hasFeatureForExistingRuntime`):
  viewing, logs, monitoring, credential reveal, deletion, scheduled work, and the
  runtime of resources that already exist. It also passes after every grace period
  for the highest paid plan the installation held, as proven by a stored signed
  license state.

Router-level gates use the HTTP method: reads and deletes use the existing-runtime
check and other methods the current-plan check, with explicit exceptions for
operations on existing resources such as connection tests, restarts, certificate
revocation and export, and log search. Service-level gates classify each method,
and unknown methods require the current plan. License transitions never change
stored configuration; see [Grace periods and entitlement
loss](licensing.md#grace-periods-and-entitlement-loss).

## Activation

Activating a paid key prepares the matching core for the currently installed
Opfield version through the ordinary signed update mechanism. Opfield keeps
serving requests while preparation runs, then restarts to load the verified core.
License settings offers **Enable paid features** to retry a failed preparation.

Shared system certificates, daemon enrollment/mTLS, ordinary Docker management,
basic AI chat, and Inference remain available in Community. System CA/certificate
primitives stay shared; user PKI entrypoints require the commercial core.

## Update order

1. Verify the target public image manifest and prepare required images.
2. Validate the installation's license online with a license state signed for this
   request, obtain the exact private release, and verify its signature, file sizes,
   hashes, and host-version compatibility. An installation that holds or held a paid
   activation (valid, in grace, or after expiration, revocation, replacement, or
   deactivation) receives the matching private core so its existing paid resources
   keep running; an installation that never held a paid plan updates as Community.
   Such an installation (no key, no paid plan in its license state, no private core
   on the host) also updates as Community while the license server cannot be
   reached, since it downloads nothing private. A refusal or a state that fails
   verification still stops the update.
3. Store the prepared image/core pair under versioned local paths.
4. Let Foundation wire the prepared local core into the target configuration.
5. Replace Opfield and retain the previous image/core pair for rollback.

The target image provides this preparation bridge for older installed Opfield
versions as well as subsequent updates. Foundation never starts a private download
after Opfield has been stopped. A failed paid authorization or package validation
leaves the current process running and must not silently downgrade it to Community.

The license server must support authenticated release authorization/downloads and
have the matching signed release available before the RC is offered for updates.
Releases that verify signed license states also require the license server to sign
states with a key the release pins, so the license server is deployed with
`LICENSE_SIGNING_KEYS` before such a release is offered. The update preparation runs
in the target image and verifies the release-authorization state with the target's
pinned keys.
Public CI checks the backend source/artifact boundary without private credentials.
Private CI independently tests and signs the commercial package against the exact
host version. Publication does not deploy or update a running Opfield instance.
