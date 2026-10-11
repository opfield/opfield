# Plans And Licensing

[Back to README](../README.md)

Opfield is offered in four product plans: Community, Personal, Business, and Enterprise. Plans apply to one Opfield installation. Paid plans do not add per-node, per-user, or per-permission-group charges.

The plan limits and feature availability below define the product access granted by each plan.

Opfield source is available under the [PolyForm Perimeter License 1.0.1](../LICENSE.md). It permits use, modification, and redistribution for noncompeting purposes, including ordinary internal business use. A Personal, Business, or Enterprise key unlocks the corresponding paid-plan features and limits for one official Opfield installation under the [Opfield Paid Key Terms 1.2](../COMMERCIAL-LICENSE.md).

An ordinary paid key does not waive Perimeter's restriction on providing a product marketed as a substitute for Opfield. Competing hosted/SaaS, OEM, white-label, and resale offerings require a separate written agreement with the Licensor. Key expiration follows the plan-specific technical grace period, after which the same installation may keep operating paid-plan resources configured before expiration; renewal is required to create new paid-plan resources or expand into additional paid-only features. Revocation for breach, fraud, chargeback, or refund ends paid-plan access immediately, without grace, and under the Paid Key Terms also ends the right to continue operating paid-plan resources. Opfield itself never stops or deletes running workloads because of a license change; see [Grace periods and entitlement loss](#grace-periods-and-entitlement-loss).

Every official release includes the [Product Continuity Grant](../CONTINUITY-GRANT.md): if Opfield stops being provided (12 months with no release and no license server, or an end-of-life notice) or the Licensor can no longer act, holders of a valid key keep a perpetual, royalty-free right to use, self-host and modify for their own use the last release, including the commercial core, and to run it without the license server. The grant itself is the authoritative text.

Entitlements schema version 5 is current. It adds storage connections, external database connections, managed object storage, AI Workspace Plan Mode, Scenarios, and AI sandboxes to every paid plan and moves GitLab integration out of Community. Version 4 kept `pages` on Personal, Business, and Enterprise, added `compose-applications` to every paid plan, and added `git-push-to-deploy` to Business and Enterprise. Opfield still accepts version 3 and version 4 grants, but they do not unlock the features added after them (managed Compose lifecycle and Git source builds for version 3, the version 5 features for both) until the license server reissues version 5 entitlements. Community grants include read-only external Compose discovery through the shared Docker feature but do not include Pages, managed Compose mutations, or GitLab integration.

## Plan Positioning

| Plan | Best fit | Scale | Support |
|---|---|---|---|
| **Community** | Internal and other noncompeting use of the core platform, including evaluation, modification, and redistribution under PolyForm Perimeter | Up to 25 managed nodes, 3 users, and 1 custom permission group | Community |
| **Personal** | Installations that need unlimited node/user/group quotas, single-node Compose deployment and lifecycle management, and current workload lifecycle features, without multi-node Workload Availability | Unlimited nodes, users, and custom permission groups | Standard |
| **Business** | Teams that need multi-node Workload Availability (HA); Git push-to-deploy for containers, deployments, Compose, and Pages; isolated Build Workers; external access to the internal registry; Secure Runtime isolation; structured logging; audit export; and guided onboarding | Unlimited | Priority |
| **Enterprise** | Organizations that need Internal PKI, SIEM export, dedicated technical ownership, or assisted migration | Unlimited | Priority + Dedicated |

## Feature Availability

| Feature | Status | Community | Personal | Business | Enterprise |
|---|---|:---:|:---:|:---:|:---:|
| Infrastructure Node Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Multi-Node Nginx Ingress Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Docker Container Management — Default Runtime (`runc`) | Ready | ✅ | ✅ | ✅ | ✅ |
| External Compose Project Discovery, Monitoring, and Logs | Ready | ✅ | ✅ | ✅ | ✅ |
| Docker ↔ Nginx Secure Links | Ready | ✅ | ✅ | ✅ | ✅ |
| Private Opfield-Managed Internal Docker Registry | Ready | ✅ | ✅ | ✅ | ✅ |
| SSL/TLS Certificate Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Domain and DNS Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Infrastructure Monitoring | Ready | ✅ | ✅ | ✅ | ✅ |
| Physical GPU Discovery, Attachment, and Monitoring | Ready | ✅ | ✅ | ✅ | ✅ |
| Alerts and Webhook Notifications | Ready | ✅ | ✅ | ✅ | ✅ |
| Authentication, OIDC, and MFA | Ready | ✅ | ✅ | ✅ | ✅ |
| Folder- and Resource-Scoped Role-Based Access Control | Ready | ✅ | ✅ | ✅ | ✅ |
| Audit Log | Ready | ✅ | ✅ | ✅ | ✅ |
| REST API, OAuth, and MCP Automation | Ready | ✅ | ✅ | ✅ | ✅ |
| General Opfield CLI | Expected in 2.13 | ✅ | ✅ | ✅ | ✅ |
| AI Workspace Chat | Ready, opt-in | ✅ | ✅ | ✅ | ✅ |
| Opfield Inference | Ready, opt-in | ✅ | ✅ | ✅ | ✅ |
| Automated Installation and Signed Updates | Ready | ✅ | ✅ | ✅ | ✅ |
| Opfield Configuration Export for Transfer to Another Instance | Ready | ✅ | ✅ | ✅ | ✅ |
| Managed Nodes | Plan limit | 25 | Unlimited | Unlimited | Unlimited |
| Users | Plan limit | 3 | Unlimited | Unlimited | Unlimited |
| Custom Permission Groups | Plan limit | 1 | Unlimited | Unlimited | Unlimited |
| Support Level | Service level | Community | Standard | Priority | Priority + Dedicated |
| External Database Connections and Explorers | Ready | — | ✅ | ✅ | ✅ |
| Storage Connections: S3, R2, MinIO and Other S3-Compatible Services, FTP, FTPS, and SFTP | Ready | — | ✅ | ✅ | ✅ |
| GitLab Integration | Ready | — | ✅ | ✅ | ✅ |
| AI Workspace Plan Mode, Scenarios, and AI Sandboxes | Ready, opt-in | — | ✅ | ✅ | ✅ |
| Container Export and Import | Ready | — | ✅ | ✅ | ✅ |
| Blue/Green Deployments | Ready | — | ✅ | ✅ | ✅ |
| Cross-Node Container and Deployment Migration | Ready | — | ✅ | ✅ | ✅ |
| Managed Single-node Compose Deployment and Lifecycle | Ready | — | ✅ | ✅ | ✅ |
| Managed Databases with Secure Links | Ready | — | ✅ | ✅ | ✅ |
| Public Status Pages | Ready, opt-in | — | ✅ | ✅ | ✅ |
| Pages | Ready | — | ✅ | ✅ | ✅ |
| Automatic GitLab Container Registry Discovery | Ready | — | ✅ | ✅ | ✅ |
| Database Backup and Restore for Managed and External Databases | Ready | — | ✅ | ✅ | ✅ |
| Managed Object Storage (SeaweedFS, Single Node) with Private Bindings and Secure Links | Ready | — | ✅ | ✅ | ✅ |
| Docker Secure Runtime (`runsc`/gVisor) | Ready | — | — | ✅ | ✅ |
| Git Repository Push-To-Deploy for Containers, Deployments, Compose, and Pages; Isolated Build Workers | Ready | — | — | ✅ | ✅ |
| External Docker-Client Access to the Internal Registry | Ready, opt-in | — | — | ✅ | ✅ |
| Multi-node Workload Availability (Container, Deployment, Compose) | Ready | — | — | ✅ | ✅ |
| Managed Databases and Storage on Several Servers (Failover, Replicated Pairs) | Ready | — | — | ✅ | ✅ |
| Ingress Groups: Routes, Pages Routes, and Domains Served by Several Nginx Nodes | Ready | — | — | ✅ | ✅ |
| Git Build Vulnerability Scanning and Admission Policy | Ready | — | — | ✅ | ✅ |
| Structured Logging | Ready, opt-in | — | — | ✅ | ✅ |
| Audit Log Export | Ready | — | — | ✅ | ✅ |
| Bastion / SSH Management Daemon | Expected in 2.14 | — | — | ✅ | ✅ |
| Broader Workload Vulnerability and Security Scanning | In development | — | — | ✅ | ✅ |
| Metric Autoscaling | In development | — | — | ✅ | ✅ |
| Multiple Instances of One Workload on One Machine | In development | — | — | ✅ | ✅ |
| Guided Onboarding and Configuration Review | Plan benefit | — | — | ✅ | ✅ |
| Internal PKI | Ready | — | — | — | ✅ |
| SIEM Audit Export | Ready, opt-in | — | — | — | ✅ |
| OIDC Group Mapping and SCIM Provisioning | In development | — | — | — | ✅ |
| Dedicated Technical Contact | Plan benefit | — | — | — | ✅ |
| Assisted Deployment and Migration | Plan benefit | — | — | — | ✅ |

`In development` and `Expected in 2.x` identify future product availability separately from plan entitlement. A checkmark on such a row means the feature is intended to be included in that plan when released. Target versions are roadmap estimates, not currently available features.

Workload Availability (HA) is available for mount-free Containers, Deployments, and whole Compose Projects on Business and Enterprise: 2–32 serving placements in Replicated mode or one serving placement with replacement in Failover mode. Once every node and relay of a workload runs 2.11, failover runs in the data plane (lease mode) and keeps working while Opfield is down; a license change never takes a policy out of lease mode (see [Data-Plane Failover](capabilities.md#data-plane-failover-lease-mode)). Ingress groups, which serve Routes, Pages Routes, and Domains from several nginx nodes, use the same Business and Enterprise entitlement; existing groups keep serving without it (see [Ingress Groups](capabilities.md#ingress-groups)). This is not HA for the Opfield control plane, registry storage, or shared volumes; metric autoscaling and same-node replicas remain in development.

Runtime enforcement applies only to features marked ready. Community limits are enforced when creating a managed node, non-deleted user, or custom permission group; existing records are never deleted by a plan change. Storage-node enrollment is available on every plan, while creating a managed database requires Personal or higher.

### Grace periods and entitlement loss

A paid plan can be lost by expiration, by a downgrade to a lower plan, by revocation, by moving the key to another installation (`replaced`), by explicit deactivation, or because Opfield cannot reach the license server. Until the matching grace period ends, everything keeps working exactly as before, including SIEM forwarding and external Docker-client access to the internal registry.

| Cause | Grace | Counted from |
|---|---|---|
| Expiration | 24 hours on Personal, 3 days on Business, 7 days on Enterprise | `expiresAt` |
| License server unreachable | 100 days, never beyond the expiration grace | The last valid signed state |
| Downgrade to a lower paid plan | The higher plan's grace: 24 hours, 3 days, or 7 days | The last signed state that still reported the higher plan |
| Revocation, replacement, explicit deactivation, invalid key | None | — |

Revocation, replacement, and deactivation receive no grace because the [Paid Key Terms](../COMMERCIAL-LICENSE.md) end paid-plan access immediately in those cases. A downgrade that follows one of them receives no downgrade grace either.

After the grace period ends, the installation uses Community entitlements for new actions and keeps a continuity entitlement for the highest paid plan it held, as proven by a stored signed license state:

- **Keeps working:** all existing workloads and the data plane (containers, deployments, Compose projects, routes, secure links, managed database and storage bindings and tunnels, relays, Pages deployments, PKI CRL downloads, structured-log ingestion); existing scheduled backups, their retention, and restores into existing databases; failover healing, start, stop, and restart of existing Availability workloads; failover, switching the primary, rebuilding copies, removing servers and turning availability off for databases and storage on several servers; scheduled syncs of existing GitLab connectors. For existing paid resources Opfield keeps viewing, logs, monitoring, connection tests, credential reveal and rotation, certificate revocation and export, and deletion.
- **Stops:** SIEM forwarding and external Docker-client access to the internal registry. SIEM keeps its configuration, delivery history, and already queued records, but new audit events are not queued while it is paused. The registry keeps its external entry point and settings, but its token endpoint issues no new tokens. Both resume on renewal without reconfiguration.
- **Blocked:** creating paid resources, changing the configuration of existing paid resources, writing data through the database and object-storage explorers (deleting rows, keys, objects, and buckets remains available), and paid-only operations such as archive import/export, migration, audit export, and Git source builds. Creations above the Community node, user, and permission-group limits are refused. These return `LICENSE_ENTITLEMENT_REQUIRED` or `LICENSE_QUOTA_EXCEEDED`.

Opfield never changes stored configuration, disables modules, or deletes managed resources because a plan changed. Renewing or reactivating a key restores full paid operations without rebuilding the existing infrastructure.

An installation keeps receiving Opfield updates after its paid plan ends. An installation that holds or held a paid activation receives the matching private core with each update, so its existing paid resources keep running under the same rules; an installation that never held a paid plan updates as Community.

The Operations Console shows plan badges on whole premium modules and uses one shared upgrade dialog for blocked actions. This UI is explanatory only; the backend independently enforces the same entitlements across REST, OAuth/MCP, AI tools, background workers, public PKI routes, and domain services. Missing features return `LICENSE_ENTITLEMENT_REQUIRED` (HTTP 403), reached plan limits return `LICENSE_QUOTA_EXCEEDED` (HTTP 409), and an internally inconsistent protected policy fails closed with a generic `SERVICE_UNAVAILABLE` response.

AI Workspace and the separate multi-provider Opfield Inference are available in every plan. Both are opt-in and use administrator-configured providers, published models, access rules, and limits. Neither is required to operate Opfield through the Operations Console, REST API, OAuth, or MCP.

AI Workspace includes guided operational Scenarios and Plan Mode. Plan Mode researches the requested outcome with read-only planning tools, validates a structured plan, and waits for explicit user confirmation before implementation. Confirmed plans expose progress controls and finish with a separate verification pass.

## Pricing

> [!IMPORTANT]
> Pricing in this document is preliminary, does not constitute an offer, and is subject to change. The current legal-use terms are defined by [LICENSE.md](../LICENSE.md) and [COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md); confirm current pricing before purchase.

| Plan | Monthly | Annual |
|---|---:|---:|
| Community | $0 | $0 |
| Personal | $29 | $290 |
| Business | $189 | $1,890 |
| Enterprise | On request | On request |

Contact [support@opfield.dev](mailto:support@opfield.dev) or [Opfield on Telegram](https://t.me/opfield) for Enterprise terms.

## Product License Verification

Opfield verifies paid product license keys against:

```text
https://license.opfield.dev
```

Releases up to 2.11 use `https://license.thesqlabs.com`, which serves the same license server and stays
available. If `license.opfield.dev` cannot be reached at all, Opfield retries the request there, so an egress
allowlist written for an older release keeps working; allow `license.opfield.dev` as well.

Registration and activation flow:

1. Every installation registers with the license server and receives an installation token. A
   Community installation remains usable while initial registration is pending.
2. During browser installation, an administrator can enter a paid key or explicitly continue with
   Community. The paid-key path requires the license server to be available.
3. Paid activation binds the key to the registered installation. A key can have only one active
   installation. It can be moved after explicit deactivation, or after the previous installation has
   been offline for more than one hour.
4. The server returns the effective plan, license metadata, expiration, activation details, and
   versioned entitlements as a signed state. Opfield stores credentials encrypted and caches the
   latest signed state.

Issuance of a paid key activates the paid-plan access described in [COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md). Activation binds that entitlement to one installation at a time. Rights independently granted by PolyForm Perimeter do not depend on key activation, while paid product features can end when the server reports an authoritative non-valid state.

Opfield sends paid heartbeats every 15 minutes and Community heartbeats every 30 minutes. If the
license server is unreachable, a previously valid paid installation uses its last signed state for a
100-day technical offline-validation grace period counted from that state's signed issue time. This
connectivity grace does not extend paid product access beyond a known expiration deadline.

After `expiresAt`, paid product entitlements remain active for 24 hours on Personal, 3 days on
Business, and 7 days on Enterprise. During this period the server and Opfield report
`expired_grace`, retain the original paid plan, expose `graceUntil`, and show an authenticated
critical Dashboard warning. Opfield evaluates the deadline locally for every protected operation;
at or after `graceUntil` it uses Community entitlements for new protected actions without waiting for another heartbeat. Existing paid resources and runtime modules remain in place and continue operating; Opfield does not reconcile ordinary expiration into service shutdown.
`revoked`, `replaced`, and `deactivated` remain immediate and receive no entitlement grace; existing
paid resources keep running afterward as described in
[Grace periods and entitlement loss](#grace-periods-and-entitlement-loss).

### Signed license states

Every license state the server returns to Opfield is signed with Ed25519. The signed payload
contains the installation ID, the request purpose (registration, heartbeat, activation,
deactivation, or release authorization), a random nonce that Opfield sends with each request, the
issue time, and the complete state: plan, paid license status, entitlements and their version,
expiration, and `graceUntil`. Opfield release builds pin the license server's public keys by key ID
and apply a state only after verifying all of the following:

- the signature is valid for a pinned key;
- the state was signed for this installation and for this request's purpose and nonce, so a
  captured response cannot be replayed or reused by another installation;
- the issue time is within 15 minutes of the local clock.

Opfield applies only the signed copy of a state, never the unsigned fields beside it. An unsigned,
forged, replayed, stale, or foreign response is rejected like an unreachable server: the last valid
signed state stays in force and the offline grace continues from its issue time. Registration and
activation fail instead of storing credentials from an unsigned response, and a private core
download is authorized only by a signed state for that request.

Opfield stores the signed states and verifies them again whenever it reads the license, so editing
the cached license in the database cannot raise the plan. A cached state without a valid signature,
such as one written by a release that predates signed states, grants only Community entitlements and
continuity for existing paid resources, and is replaced at the next successful heartbeat.

Each request names the key IDs the Opfield release pins. The license server signs with the first
key it holds from that list, which lets its signing key rotate without breaking installations that
have not updated yet: a release pins the next key before the server starts using it.

Data sent to the license server:

- Installation ID.
- Installation name.
- Opfield version.
- A locally generated registration nonce during registration.
- A random request nonce and the pinned signing key IDs with every license request.
- The installation token during heartbeats and license operations.
- The paid license key only during activation.

The installation name is derived from Opfield's persisted canonical public URL when possible, otherwise from the host name. Infrastructure configuration, managed-resource contents, logs, prompts, and model responses are not sent to the license server.

## License Statuses

| Status | Meaning |
|---|---|
| `community` | No paid product key is installed; Opfield is using Community status. |
| `valid` | The installed key is valid. After a downgrade, `graceUntil` shows when the higher plan's entitlements end. |
| `expired_grace` | The key expired, but its original paid entitlements remain active until the plan-specific `graceUntil` deadline. |
| `valid_with_warning` | The key was previously valid, but the license server is unreachable or its response was rejected, and Opfield remains within the offline grace. |
| `unreachable_grace_expired` | Opfield cannot validate the key and the offline grace period expired, or the cached state carries no valid signature. New paid-only actions are blocked, but existing configured services remain running. |
| `invalid` | The license key is not valid. |
| `expired` | The plan-specific expiration grace ended. Opfield uses Community entitlements for new protected actions while preserving existing configured services. |
| `revoked` | The license key was revoked. Community entitlements apply immediately; existing configured services remain running. |
| `replaced` | The license activation moved to another installation. Community entitlements apply immediately; existing configured services remain running. |
| `deactivated` | The paid license was explicitly detached from this installation. Community entitlements apply immediately; existing configured services remain running. |

## Storage And Security

Opfield stores a generated installation ID, an encrypted registration nonce, an encrypted
installation token, the encrypted paid key when one is installed, and the latest signed state
returned by the license server together with the signed state of the highest paid plan it held. Administrators can deactivate a paid license from **Settings > General >
License**; the server binding is released before the local key is removed.

## Legal-use boundary

Licensor-owned Opfield source is publicly available under the [PolyForm Perimeter License 1.0.1](../LICENSE.md). It permits use, modification, derivative works, and distribution for permitted purposes. The excluded purpose is providing to others a product marketed as a substitute for Opfield, regardless of whether that substitute is software, a hosted service, a port, or a free offering.

The [Opfield Paid Key Terms 1.2](../COMMERCIAL-LICENSE.md) govern plan features, limits, grace, and continuity for Personal, Business, and Enterprise keys. A key does not limit rights independently available under Perimeter, and it does not automatically authorize an OEM, white-label, resale, competing hosted, or other substitute product. Those uses require a separate written agreement with the Licensor.

The [Product Continuity Grant](../CONTINUITY-GRANT.md) defines when key holders keep a perpetual license to the last release and may run it without the license server.

Third-party components remain governed by their own licenses. Already published Opfield releases remain governed by the terms distributed with those releases.
