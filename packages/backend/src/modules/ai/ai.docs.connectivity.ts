export const CONNECTIVITY_DOCS: Record<string, string> = {
  relays: `# Relays And The Relay Pool

Every daemon connection goes through a relay: the local relay next to Opfield owns public TCP 9443, carries daemon control connections, and carries Secure Link traffic (Routes to Docker workloads, database and storage links, container links). The Relay Pool adds remote relays on other physical hosts, so traffic keeps flowing when one relay stops. Applications see one logical Secure Link and never the pool layout.

## Add a relay
- A remote relay is a node of type \`relay\`: \`create_node({ type: "relay", hostname, serviceAddresses: [<address hosts reach it on>], servicePort? })\`, then run the returned \`installCommands\` entry on the relay host (topic nodes). It appears in the pool once its supervisor enrolls. Use a separate physical host: two relays on one host do not count as redundant.
- Its worker listens on the advertised address and port (TCP 9443 unless \`servicePort\` is set). That port must be open from every participating Docker, nginx and Storage host and from Opfield. Opfield opens no firewall, does no NAT traversal and builds no overlay.
- A hosted VM with role \`relay\` (topic hosting) is the same thing ordered from a hosting account; it needs \`relayAddress\`.

## Operate the pool
\`manage_relay_pool\` (\`settings:opfield:view\` to read, \`admin:system\` to change):
- \`get\`: pool and local relay health, instances with \`policyTrust\`, certificate, \`health.lastError\`, assignments, \`witnessHosting\`, \`protected\`.
- \`rebalance\` stages a rebalance now; Opfield also rebalances by itself once the pool has been stable for 30 seconds.
- \`drain_instance\` (\`confirm: true\`) stops new sessions on a relay; \`resume_instance\` undoes it. \`force_disconnect_instance\` (\`confirm: true\`) drops every session on it.
- \`renew_certificate\` renews a remote relay certificate now (automatic renewal starts 60 days before expiry).
- \`reenroll_instance\` (\`confirm: true\`) issues a single-use token for a remote relay that is offline, locked out of policy sync or holds an expired certificate; give the user the returned \`installCommands\` entry unchanged, with its \`--version\`.
- \`local_policy_trust_status\` and \`retry_recovery\` inspect and retry automatic recovery of the local relay's policy signing trust.
- \`set_witness_hosting\` (\`allowed\`) decides whether availability witnesses of databases and storage may run on a relay; a protected relay also needs its owner's local opt-in.
- Remove a relay: drain it, then \`delete_node\` on its node once it carries nothing. An offline relay can be removed without a drain only after its last signed policy expired; until then the answer is \`409 RELAY_OFFLINE_REMOVAL_UNSAFE\` with \`details.removableAfter\`.
- Updates: \`manage_system_updates\` (topic licensing-updates), after the node daemons. Tuning such as \`relayPolicyLeaseHours\` (1 to 168, default 72): \`update_opfield_settings\` \`generalSettings.relay\`.

## Behavior to expect
- Relays admit connections on their last signed policy for the relay policy lease while Opfield is down; revocations and changes need Opfield.
- Daemons measure round trips; routes use the nearest relays first and move back to a nearer relay without cutting connections. A relay unreachable from most nodes loses its assignments within about a minute.
- A protected relay (its owner's local setting) refuses console, files and host diagnostics; console and file calls answer \`409 NODE_PROTECTED\`. Opfield cannot turn protected mode off.
- Alert rules of category \`relay_pool\` watch pool health (topic notifications).`,

  integrations: `# Integrations: GitHub, Generic Git, External SSH, Cloudflare

Connectors store an encrypted credential and are never returned with it. GitLab has its own topic (gitlab), Cloudflare DNS the cloudflare topic, hosting accounts the hosting topic.

## Inventory and administration
- \`list_integration_connectors({ provider? })\` lists GitLab, GitHub, generic Git, Cloudflare and external SSH connectors the caller may view, with id, enabled state and last sync or test status.
- \`sync_integration_connector({ provider, connectorId })\` resyncs or re-tests one connector (\`integrations:<provider>:manage\`).
- \`manage_integration_connector({ provider, operation, connectorId, ... })\`: github and git take \`update\`, \`delete\`, \`test\`, \`preview_test\`; ssh takes \`update\` (name only), \`delete\`, \`test\`, \`discover_host_key\`; gitlab and cloudflare add \`get\`, \`rotate_token\` and their own reads. \`preview_test\` and \`discover_host_key\` take no connectorId.
- Create a connector only with credentials the user gave in the current request; otherwise send the user to **Settings > Integrations** (in AI Workspace \`open_connector_setup\`). Never repeat a token.

## GitHub
- Create: \`create_github_token_connector({ name, baseUrl, token })\` for a personal access token; the OAuth Device Flow runs in the Console only.
- Read (\`integrations:github:repo:read\`): \`github_list_connectors\`, \`github_list_repositories\`, \`github_list_repository_tree\`, \`github_read_repository_file\`, \`github_list_branches\`, \`github_list_workflow_runs\`, \`github_list_actions_secrets\` (names only).
- Write (\`integrations:github:repo:write\`, each after explicit approval): \`github_create_branch({ connectorId, repositoryUrl, branch, fromRef? })\` (from a branch, tag or commit; the default branch when omitted; an existing branch is never moved), \`github_upsert_repository_file\` (one file, existing branch), \`github_delete_branch\` (never the default branch; GitHub refuses protected ones), \`github_upsert_actions_variable\`, \`github_upsert_actions_secret\`. For "make your own branch and deploy it": create the branch, commit to it, point the source at it, and delete the branch when the user is done with it. \`github_list_actions_variables\` returns values, so it needs repo:write too.

## Generic Git (HTTPS)
- Create: \`create_git_connector({ name, baseUrl, repositoryUrls, username, token })\`; only the listed repositories are reachable.
- Read (\`integrations:git:repo:read\`): \`git_list_connectors\`, \`git_list_remote_refs\`, \`git_list_repository_tree\`, \`git_read_repository_file\` (text up to 256 KiB).
- Write (\`integrations:git:repo:write\`, after explicit approval): \`git_create_branch({ connectorId, repositoryUrl, branch, fromRef? })\` pushes a new branch (from a branch or tag; the default branch when omitted; never moves an existing one), \`git_upsert_repository_file({ connectorId, repositoryUrl, path, branch, message, content })\` commits one text file to an existing branch and pushes it, \`git_delete_branch\` deletes a branch (never the remote's default branch).
- Git scopes can be limited to a connector, a GitHub owner or a repository (see SCOPES.md, Git Integration Restrictions).

## External SSH
External SSH connectors reach servers that are not Opfield nodes (use the node console tools for nodes).
1. \`manage_integration_connector({ provider: "ssh", operation: "discover_host_key", host, port?, jumpConnectorId? })\` returns the host key fingerprint. Show it to the user and have them confirm it.
2. \`create_ssh_connector({ name, host, port?, username, hostFingerprint, authMethod, ... })\` (\`integrations:ssh:manage\`): \`authMethod: "password"\` takes \`secret\`; \`"private_key"\` takes \`generatePrivateKey: true\` (the public key comes back for the user to install on the host) or \`reuseCredentialFromConnectorId\`. Private key import is disabled. \`jumpConnectorId\` routes through another SSH connector.
3. \`ssh_execute_command({ connectorId, command })\` (\`integrations:ssh:use\`) runs one POSIX shell command after the standard approval. Treat it as a host mutation that needs user intent. Opfield nodes are refused as targets; on a host that still turns out to run an Opfield Docker daemon, a command that changes its Docker objects or daemon state is refused with MANAGED_RESOURCE_CONSOLE_FORBIDDEN (topic nodes, Console).
- A hosting install on an existing VM without Guest Agent uses such a connector as \`sshConnectorId\` (topic hosting).

## Cloudflare
\`create_cloudflare_connector({ name, token, settings? })\`, \`manage_integration_connector\` \`list_zones\`, and the DNS-01 and domain workflows: topics cloudflare and domains.`,
};
