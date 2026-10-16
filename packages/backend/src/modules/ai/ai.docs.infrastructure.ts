export const INFRASTRUCTURE_DOCS: Record<string, string> = {
  storage: `# Storage and database backups
Use Storage for external AWS S3, R2, MinIO-compatible, FTP, FTPS or SFTP connections and managed object storage. Managed storage runs on Storage nodes alongside managed databases. New managed clusters run single-node SeaweedFS with an S3 API only (no FTP/SFTP listeners, at least 512 MiB memory) and need a node daemon that advertises SeaweedFS support; existing MinIO clusters are legacy (engine "minio"): they stay manageable but cannot be created, and an operation that needs a MinIO image the node no longer has fails with an explicit engine-image error. Managed storage is private through authenticated relay by default; a public S3 listener requires explicit publication. External SFTP connections require a pinned host-key fingerprint.
Use list_storage_connections, get_storage_connection, manage_storage_connection, manage_storage_objects and manage_managed_storage for authorized storage operations. For managed storage, call catalog then create, poll get until ready, and use list_bindings/create_binding/delete_binding for private bucket-scoped workload links; create_binding creates the link's buckets that do not exist yet, because the link key cannot. For a TLS cluster, \`ca_certificate\` returns the public Storage CA certificate (PEM and SHA-256 fingerprint) that S3 clients must trust; it needs only storage:view. Use list_access_keys/create_access_key/remove_access_key for scoped IAM keys: key creation requires storage:iam and returns its generated secret exactly once, while list actions never return key or root secrets. Link create/delete requires storage:bind (storage:iam includes it) and permission to change the target workload; issuing access keys stays storage:iam. Only when the user explicitly asks, \`reveal_credentials\` on manage_storage_connection (saved connection secret) or manage_managed_storage (cluster root keys) returns credentials; it requires storage:credentials:reveal and is refused while impersonating. manage_storage_connection also reads \`health_history\` and \`monitoring\` metrics with storage:view.
Use a database's Backups tab to choose an existing bucket, prefix, Storage executor, schedule/time zone, retention and resource limits. Native PostgreSQL, key-value store and ClickHouse backups automatically use the immutable runner bundled with the Opfield release; BACKUP_RUNNER_IMAGE is an optional operator override. ClickHouse file-protocol destinations additionally need server-reachable S3 staging. Restore creates a new managed database by default and refuses a nonempty target. A key-value backup restores only into the engine it was taken from: a backup of a store that runs Redis restores into a store that runs Redis or into a new store (which then runs the backup's Redis version), a backup of a store that runs Valkey only into Valkey; a mismatch fails before the target is touched. External key-value restore requires the target to reach the executor at its service address (or an address the node reports) for temporary replication, and a target on the backup's release line or newer. Key-value backups need a user allowed to run REPLCONF and SYNC.
Object paths are S3 bucket/key/prefix paths, not arbitrary node filesystem paths. The existing \`manage_storage_objects\` actions are \`list_buckets\`, \`list_objects\`, \`head\`, \`create_bucket\`, \`delete_bucket\`, \`create_prefix\`, \`delete_objects\`, \`presign\` (GET by default; PUT needs storage:objects:write), and \`read_object\`, which returns a small object as base64 (default 256 KiB, at most 1 MiB; over MCP, download larger objects with \`download_storage_object\`; private managed storage refuses presign unless its S3 endpoint is published, and then the URL points at the published endpoint); do not claim other object mutations. Managed storage capacity is configured by its requested storage size and exposed in the safe managed view; runtime disk used/free/total metrics come from the managed storage image and may be unknown until a fresh node report exists. Do not promise host-path access or equate host free space with the managed capacity.
To move data between two S3 connections (managed or external, for example from a legacy MinIO cluster to a new SeaweedFS cluster), use the server-side copy on \`manage_storage_connection\`: \`copy_data_start\` with \`config\` \`{sourceStorageId, destinationStorageId, buckets, mode, dryRun}\` and optional \`createBuckets\`, \`executorNodeId\` and \`limits\` (\`timeoutSeconds\` up to 7 days, default 1 day; \`cpuCores\`; \`memoryMb\`; \`transfers\`). \`buckets\` is \`"all"\` or a list of names; each bucket keeps its name on the destination. \`mode: "copy"\` (default) adds and overwrites objects and never deletes; \`mode: "sync"\` also deletes destination objects the source does not have, so use it only for the final pass and only after the user agrees. \`dryRun: true\` writes nothing and reports what differs. The backup runner on a Storage node streams the objects with rclone, reaching private managed storage through per-job relay routes (no published ports, no recreated containers), then runs \`rclone check\`. Missing destination buckets are created when the caller holds \`storage:objects:admin\` on the destination (or pass \`createBuckets: false\` to require existing buckets). Starting needs \`storage:objects:read\` and \`storage:credentials:use\` on the source, \`storage:objects:write\` and \`storage:credentials:use\` on the destination and \`nodes:backups:execute\` on the executor; the executor is chosen automatically among online Storage nodes whose daemon supports storage copy. Credentials never leave Opfield and the executor. Poll \`copy_data_status\` with \`config.jobId\` until \`status\` is \`completed\`, \`failed\` or \`cancelled\`, reporting \`progress\` (bytes, objects, current bucket) meanwhile. A finished job has a \`report\`: per bucket and in \`totals\`, source and destination object counts and bytes, \`missing\`, \`differing\` and (for sync) \`extra\` counts with sample keys, and \`clean\`, which is true only when everything matched. Only a completed job with \`report.clean: true\` proves the copy; otherwise start the same copy again: reruns transfer only what changed. Swapping source and destination copies the other way (rollback). \`copy_data_list\` lists jobs (optional \`config.storageId\` and \`config.status: "active"\`); \`copy_data_cancel\` stops a job with \`config.jobId\`. Only one active job may write a storage, and no job may read a storage another job is writing.
The MCP-only \`download_storage_object\` tool takes \`storageId\`, \`bucket\` and \`key\` (storage:objects:read) and returns a one-time download URL, valid 15 minutes and single use, with a ready \`curl -fsS -o\` command that streams the object through Opfield; a missing object is refused with STORAGE_NOT_FOUND.
The MCP-only \`upload_storage_object\` tool supports \`begin\`, \`chunk\`, \`status\`, \`finalize\`, and \`abort\`. Every call includes \`storageId\`; \`begin\` also supplies \`bucket\`, \`key\`, exact \`declaredSizeBytes\`, lowercase \`sha256\`, and optional \`contentType\`; non-begin calls use the returned \`uploadId\`, and \`chunk\` supplies \`offset\` and \`contentBase64\`. Decoded chunks are capped at 1 MiB. Opfield checks ordered offsets, exact total size, and the complete SHA-256, spools privately under the configured Pages storage directory \`object-uploads\`, and streams the verified spool to the provider without holding the whole object in RAM.
Every upload call rechecks same-user ownership and the resource-scoped \`storage:objects:write\` grant. Sessions expire after one hour and do not survive an Opfield process restart; orphan spools older than two hours are cleaned. Successful finalization overwrites an existing key. If finalization has an ambiguous failure, inspect the destination first and do not automatically retry it. Active sessions and reserved bytes remain bounded by the configured upload limits. Terminal receipts are independently bounded to the 32 most recently used per user and 256 globally; an evicted receipt returns not found, so inspect the object rather than blindly uploading it again.
Never claim a queued or running job completed. Inspect the run state and verified artifact manifest. Retention and cancellation retain cleanup ownership; storage referenced by retained backup history cannot be deleted. Retention keeps the newest completed backups of a policy and runs after every run, failed ones included. Files a failed or cancelled run left (its runner was killed) are removed by Opfield every 15 minutes, only from directories named by that run's id; the run then shows artifactsDeletedAt and the audit log has database.backup.unfinished_files_removed.
Deleting a database keeps its backup history and files (no retention applies to them; they stay until removed, as the only way to restore it). \`manage_database_backups\` \`list_orphaned_runs\` lists the runs of deleted databases (\`databaseConnectionName\` is the name the database had); \`restore_orphaned\` with \`runId\` and the restore \`config\` restores a completed one into a new managed database (engine and version of the backup) or an empty connection; \`cancel_orphaned\` and \`delete_orphaned_run\` work like cancel and delete_run. They take no databaseId and need the unscoped databases:backups:* scope.
Migrating a legacy MinIO cluster to SeaweedFS: read topic \`storage-migration\` first. It uses the cutover actions of manage_managed_storage (\`move_binding\`, \`import_access_keys\`, \`freeze_writes\`, \`unfreeze_writes\`, \`rehome_backup_history\`), \`copy_data_*\` and \`manage_additional_secure_link retarget\`.`,
  'storage-migration': `# Migrating legacy MinIO managed storage to SeaweedFS
Only on explicit user request. The migration is done with tools, step by step; there is no migration button. Report each step's result, ask before the cutover (it starts a write window) and before retiring the old cluster.
Ids: \`manage_managed_storage\` takes managed storage ids (\`managedStorageId\`, \`targetStorageId\`, \`config.sourceStorageId\`: the \`id\` from \`list\`/\`get\`). \`copy_data_*\` on \`manage_storage_connection\`, \`manage_storage_objects\` and backup policies take storage connection ids (\`objectStorageConnectionId\` from \`get\`). Never mix them.

## Rules
- Never \`restart\`, \`update\` or \`retry\` the MinIO cluster, and never change its publication. Each recreates its container, and the MinIO image may be gone from the node and cannot be downloaded again (\`MANAGED_STORAGE_ENGINE_IMAGE_UNAVAILABLE\`). If the MinIO cluster is not running, Opfield cannot copy its data: stop and tell the user.
- SeaweedFS serves S3 only: no FTP and no SFTP. If the source has \`ftpEnabled\` or \`sftpEnabled\`, stop and explain that those clients need another path first.
- Never repeat root credentials or key secrets in chat. \`import_access_keys\` and \`move_binding\` keep secrets server-side.
- Never claim a copy finished before \`copy_data_status\` shows \`completed\`. Only the final sync after \`freeze_writes\` must end with \`report.clean: true\`; do not switch anything over before it does.

## Preflight (read only; then present the plan and ask to proceed)
1. \`manage_managed_storage get\` the source: \`status: "ready"\`, \`engine: "minio"\`; note \`nodeId\`, \`publishS3\`, \`publishedPort\`, \`relayEnabled\`, \`tlsEnabled\`, \`sftpEnabled\`, \`ftpEnabled\`, \`writesFrozenAt\` and \`objectStorageConnectionId\`.
2. Inventory: \`manage_storage_objects list_buckets\`; used bytes from \`manage_storage_connection monitoring\`; \`list_access_keys\` (keys with \`expiresAt\` will get new ids); \`list_bindings\`; Additional Secure Links with \`upstreamKind: "managed_storage"\` and this \`managedStorageId\` (\`manage_additional_secure_link list\` per Route); backup policies and history whose destination or staging is the source connection (\`manage_database_backups list_policies\` and \`list_runs\` per database).
3. Target node and size: at least 1.2 times the used bytes, and on the same node enough free disk for both copies. Its daemon must support SeaweedFS (\`STORAGE_ENGINE_UNAVAILABLE\` means update the node daemon first). \`freeze_writes\` needs a current daemon on the MinIO node too; updating a daemon does not recreate the MinIO container.

## Build the target
1. \`catalog\`, then \`create\` a SeaweedFS cluster (at least 512 MiB memory). To keep clients that use the root credentials working, pass the source root keys from \`reveal_credentials\` as \`config.accessKey\`/\`config.secretKey\` (only if the user wants that; never print them). Keep the default private relay. Publish S3 only if the source is published: on the same node use a temporary port (the source still holds its port), on another node the same port. Poll \`get\` until \`ready\`.
2. Buckets: \`copy_data_start\` creates missing buckets when allowed (\`createBuckets\`), or use \`manage_storage_objects create_bucket\`. Every bucket a workload link uses must exist on the target before \`move_binding\`. Bucket versioning, lifecycle rules and bucket policies are not copied; tell the user.

## Bulk copy (online; clients keep writing to MinIO)
\`manage_storage_connection copy_data_start\` with \`config\` \`{sourceStorageId: <source connection>, destinationStorageId: <target connection>, buckets: "all", mode: "copy"}\` returns the job; poll \`copy_data_status\` with \`config: {jobId: <the id returned by copy_data_start>}\` until \`completed\`, \`failed\` or \`cancelled\`. Clients still write during these passes, so the report may show differences; run the copy again until only a few recent objects differ (reruns copy only what changed). A clean report is required only for the final sync.

## Cutover (tell the user the write window starts; reads keep working)
1. Backups first: move every backup policy that writes to the source (destination or staging) to the target connection with \`manage_database_backups update_policy\` (full policy, same bucket and prefix), or pause it (\`enabled: false\`) if the user prefers. Then check with \`list_runs\` that no backup or restore run using the source is queued or running; wait for it or cancel it. \`freeze_writes\` refuses while such runs are active.
2. \`freeze_writes\` on the source: every access key and workload-link key Opfield issued becomes read-only, keys issued later too; the root credentials keep writing, so the copy still works. Opfield itself stops writing there: uploads, deletes and bucket changes through Opfield (object browser, storage tools, MCP uploads) fail with \`STORAGE_WRITES_FROZEN\`, and backup or restore runs that would write there are refused and recorded as failed with that reason; copy jobs keep working. In the result, \`unmanagedKeys\` lists keys Opfield did not issue: they still write, as do clients that use the root credentials, so ask the user to stop them. When \`unmanagedKeys\` is \`null\` the storage server could not be listed: say that unmanaged keys are unknown, never that there are none. \`backupPoliciesStillUsingStorage\` above 0 means step 1 is incomplete. On \`MANAGED_STORAGE_FREEZE_INCOMPLETE\` retry; \`get\` shows \`writesFrozenAt\`.
3. Final pass: \`copy_data_start\` with \`mode: "sync"\` (it also deletes target objects the source does not have) and wait for \`report.clean: true\`: counts and bytes equal, nothing missing or differing. If it is not clean, run the sync again; do not continue.
4. \`import_access_keys\` \`{config: {sourceStorageId, targetStorageId}}\`: operator keys keep their id and secret, so external clients only change the endpoint (or nothing, see step 8). Tell the user which keys are in \`needsNewId\` (expiring, or an id SeaweedFS does not accept) and create replacements with \`create_access_key\` (same access, buckets and expiry) only if they ask; a new secret is shown once.
5. \`move_binding\` for each link \`{managedStorageId: <source>, bindingId, targetStorageId}\`. The workload is not recreated: it keeps its alias, variables and key; only the private route (and, when TLS differs, the connector) changes. It refuses with \`MANAGED_STORAGE_BINDING_BUCKETS_MISSING\` when a bucket of the link is missing on the target. Then check the workload is running and its logs are clean. A failed move is normally rolled back and the link stays on the source; when the error says the link could not be switched back, it now uses the target and is marked failed: tell the user, check the workload, and offer to delete and recreate the link.
6. Additional Secure Links: \`manage_additional_secure_link retarget\` \`{routeId, bindingId, upstreamKind: "managed_storage", managedStorageId: <target>}\`. The link keeps its id and name, so Route configs that use it keep working; the Route config is applied again when the scheme changes, and if the target does not answer or the config cannot be applied, the old cluster is restored.
7. Backup check: \`run\` one backup of each moved policy and wait for it to complete; re-enable paused policies after moving them.
8. Published endpoint: clients that use the source host:port get it back only after the source is deleted (retire), then \`update\` the target \`publishedPort\`. Until then they can use the target's temporary port.
9. Tell the user to re-grant resource-scoped \`storage:*\` permissions and folder placement on the new connection.

## Rollback (before retire)
1. Backups first, as for the cutover: move the backup policies that now write to the target back to the source connection with \`update_policy\` (or pause them), and wait for or cancel backup and restore runs that use the target. \`freeze_writes\` on the target refuses while such runs are active.
2. \`freeze_writes\` the target, so nothing more changes there.
3. Copy back what was written after the cutover: \`copy_data_start\` from the target to the source with \`mode: "sync"\` (the frozen source still accepts the copy), repeated until \`report.clean: true\`.
4. \`move_binding\` every link back to the source and \`retarget\` the Secure Links back.
5. Backups made on the target during the failed cutover: once their files are back on the source (step 3 copies them), \`rehome_backup_history\` \`{managedStorageId: <target>, targetStorageId: <source>}\` points them at the source; \`blocked\` runs stay on the target.
6. \`unfreeze_writes\` the source. Legacy MinIO operator keys created before Opfield attached a policy to each key had no inline policy and inherited the root user's full access; after a freeze and unfreeze they have the Opfield read-write policy (read and write on their buckets, no admin or bucket creation). Tell the user; a client that needs more must use the root credentials or a new key.

## Retire (only after the user confirms the applications are healthy)
1. Backup history on the source: \`rehome_backup_history\` \`{managedStorageId: <source>, targetStorageId}\` (try \`config.dryRun: true\` first) points finished runs at the target once every artifact is found there with its manifest size. It refuses while backup runs are active and never changes policies; runs in \`blocked\` stay on the source (copy their files again, or ask the user). Alternatively keep the MinIO cluster while its history is needed. Deleting it with \`config.backupHistory: "forget"\` makes those backups unrestorable, and the files in the cluster are deleted with it.
2. \`delete\` the source; it is refused while Secure Links, backup policies or backup history still use it. Then move the published port if needed and \`remove_access_key\` any temporary keys. If the migration is abandoned instead and the source is unfrozen, the legacy key policy change described under Rollback step 6 applies.`,

  docker: `# Docker Container Management

## Overview
Opfield provides Portainer-like Docker container management through a daemon running on Docker hosts. Docker tools still require a nodeId, while container permissions can be granted for the whole node or narrowed to one standalone container or blue/green deployment.

Docker tools take only nodes of type \`docker\` (\`list_nodes({ type: "docker" })\`; each node's \`usedFor\` names its tools). Storage, databases and builder nodes run restricted docker-daemon profiles and report \`capabilities.daemonType: "docker"\`, but they are not Docker nodes: Docker tools refuse them with \`NOT_DOCKER\` and name the Docker nodes you can use. Pass the full node UUID from \`list_nodes\`, not a name or a shortened id. \`list_docker_containers\`, \`list_docker_deployments\`, \`list_docker_images\`, \`list_docker_volumes\` and \`list_docker_networks\` list across every Docker node you can see when \`nodeId\` is omitted (rows carry \`nodeId\` and \`nodeName\`); use that instead of calling them on every node.

## Change Managed Objects Through Opfield, Not The Node Console
Containers, deployments, Compose projects, volumes and networks Opfield manages change only through the Docker tools. Agents (remote MCP and the assistant) get MANAGED_RESOURCE_CONSOLE_FORBIDDEN from \`execute_node_console_command\` (and \`ssh_execute_command\`) for \`docker\`/\`podman\`/\`nerdctl\` rm, run/create under a managed name or on its ports or volumes, stop, start, kill, restart, pause, rename, update, network connect/disconnect/rm, volume rm, prune and \`docker compose\` up/down/rm/restart/stop/pull on a managed project, also inside \`sh -c\`, chains, sudo, env prefixes or \`-H\`/\`--context\`. Use manage_docker_container (recreate, live_update), update_docker_container_image, remove/stop/start/restart/kill/rename_docker_container, manage_docker_deployment and the deployment tools, manage_docker_compose, manage_docker_volume or manage_docker_network instead. Read-only commands (docker ps, inspect, logs, stats, images) stay allowed. A container someone removed, recreated or renamed outside Opfield shows up as "changed outside Opfield" in the audit log and raises the built-in alert "Container changed outside Opfield" (on by default); it has a new access identity, and a Git-source build refuses it with an error that says so: remove it with remove_docker_container so the next build creates it from the source's configuration, or recreate it in Opfield.

## Git Source Builds And Push-To-Deploy
- Git push-to-deploy, source mutation and automation, new build admission, and optional external Docker-client access to the internal registry require Business or Enterprise. The private internal registry itself remains available and operational on every plan. Let operators configure Repository mode fully, but explain that **Create and build** is the enforcement point when the current plan is below Business. After downgrade, existing source and build history remains readable and source bindings or Build Secrets may be removed, but edits, polling, webhooks, and new builds remain blocked.
- A Git source is attached directly to an existing container, blue/green deployment, or Compose Project; there is no separate application entity. Repository mode in the Docker or Compose create dialog can reserve the resource and queue its first build.
- Attaching a source to an existing container, deployment or Compose Project is all it takes: the next successful build deploys into it (a container keeps its settings and gets the build's image; a deployment gets a blue/green release; a Compose Project a new revision). Attaching a source, or changing its connector, repository or branch, with \`autoBuild\` queues the build of the branch head at once. When it cannot be queued (no Build Worker, every worker paused) the save still succeeds, \`state\` and \`lastPollError\` say why, and the next poll queues it.
- When \`deployedCommitSha\` is null, or the target does not run the commit you expect, read \`state\` and \`latestBuild\` from \`manage_docker_source\` \`get\` before anything else (\`latestBuilds\` lists every service build of a Compose commit). A container its first build has not created yet answers the same in \`manage_docker_source\` \`pending\`, and \`list_docker_builds\` with \`nodeId\` and \`containerName\` lists its builds. A failed build says why in \`errorCode\` and \`errorMessage\`. \`BUILD_ARTIFACT_POLICY_REJECTED\` means the vulnerability policy blocked the image: the message lists the blocking counts and top findings and names the fix (update the packages, or set \`policy.vulnerabilityScope\` to \`application\`, \`fixable_application\` or \`fixable_all\`, or raise \`vulnerabilityThreshold\`). Fix the cause and build again (\`build\`, or \`manage_docker_build\` \`retry\`).
- A service container of a Compose project and a slot container of a blue/green deployment take no Git source of their own: \`create\` and \`upsert\` refuse them with 409 SOURCE_TARGET_OWNED, naming the Compose Project or deployment. Attach the source to that owner instead (\`targetType: "compose"\` with \`composeProjectId\`, or \`targetType: "deployment"\` with \`deploymentId\`). A source attached to such a container earlier stays as it is, but its builds never recreate the container: the rollout fails with SOURCE_TARGET_OWNED (the artifact is still built) and the container is left untouched. \`get\` reports it in \`invalidTarget\` and \`state\` with the same advice: remove it and attach one to the owner.
- Never replace a source-managed workload by hand: do not recreate its container from the node console or Docker CLI, and do not pull a build artifact into it by digest. Opfield then no longer manages what runs, and the next build replaces it again.
- A container created from a Git source can get environment variables and secrets before its first build: \`manage_docker_source\` \`create\` with \`env\`/\`secrets\`, or later \`manage_docker_container_config\` (\`update_env\`, secret operations) by its containerName. The first build creates and starts the container with them. Removing the container, or the Git source of one not yet built, deletes them.
- A build never starts a target that was stopped on request: the container's image, the deployment's release or the Compose Project's revision is replaced and runs on the next start; the build succeeds with \`progress.rolloutNote\`. Only the first build of a container created from a Git source creates and starts it.
- Use \`list_docker_builds\` to inspect visible build status, exact commit, Build Worker, immutable artifact digest, and policy result.
- Use \`manage_docker_source\` with \`get\`, \`create\`, \`upsert\`, \`remove\`, \`resolve\`, \`sync\`, \`build\`, \`rollback\`, source-secret operations, or repository discovery for containers, deployments, and Compose Projects. Use \`admission\` before promising a new build; it reports whether the internal registry and a dedicated Build Worker runtime are ready.
- \`sync\` is the console's **Sync now** (Pages: \`manage_pages\` \`source_sync\`): one poll iteration for this source right away, also when automatic builds are off. It records the branch head as the desired commit and queues the automatic build only when the source builds automatically and the head changed or has no build yet; it returns \`{ source, changed, build }\`. It needs the build scope (docker:containers:manage, docker:compose:manage or pages:deploy) but no integrations:<provider>:use. Within about 10 seconds of the previous check it returns the current state without asking the Git provider; a provider failure answers 502 SOURCE_SYNC_FAILED, and 503 BUILD_WORKERS_PAUSED ("All Build Workers are paused for new builds") or NO_BUILD_WORKER_AVAILABLE when no Build Worker takes the build. Creating a resource from a source while every Build Worker is paused still queues its first build (claimed once a worker is unlocked) and answers \`firstBuildWaiting\`. \`resolve\` refreshes the desired commit without building (sync without building); \`build\` always builds the current head.
- To undo a deploy on a Git-source container, use \`manage_docker_source\` \`rollback\` (Console: **Roll back** in the Delivery status panel of the container's Source tab; \`POST /api/docker/nodes/{nodeId}/containers/{containerName}/source/rollback\`, docker:containers:manage). Without \`buildId\` it goes back to the build the container ran before; \`get\` names it in \`rollbackBuild\` (null when none is kept). The internal registry keeps per container only the running build and one previous build, so a rollback goes back one build; for older code push a revert commit. The container is recreated from that image digest with its current settings, env and secrets and must become ready, or it is returned to its previous image (\`SOURCE_ROLLBACK_FAILED\`). The rollback's commit becomes \`deployedCommitSha\` and the replaced build stays kept, so \`rollback\` again returns to it; the container stays on the rollback until a new commit on the branch, or a manual \`build\`, is built and deployed. It is refused with \`SOURCE_BUILD_IN_PROGRESS\` while a build of the source is queued, building or deploying. \`manage_docker_build\` \`retry\` does not rerun a succeeded build, and \`build\` with an older \`commitSha\` is refused with \`SOURCE_COMMIT_STALE\`: both name rollback. Deployments roll back with \`rollback_docker_deployment\`, Compose Projects by applying an earlier revision.
- Use \`manage_docker_build\` for one visible build's status, incremental logs, cancellation, or retry. Use \`find_resource({ types: ["docker_build"] })\` or \`list_docker_builds\` with node, worker, provider, branch, status, or search filters for history.
- Repository and integration IDs must come from an enabled allowlisted GitLab, GitHub, or generic Git connector. Opfield resolves the configured branch to an exact commit SHA and deduplicates ordinary builds by source binding plus commit.
- Automatic deployment never runs a mutable Git-derived tag. An approved artifact is stored in the internal registry and addressed by digest; standalone containers recreate from that digest, deployments use the existing health-checked blue/green path, and Compose waits for every service build in the parent batch before creating one digest-pinned immutable revision. Manual Compose revisions remain image-only; repository Compose files support the bounded single-node build subset of context, dockerfile, and args. The internal registry keeps two builds per container (the one running and one for rollback, which \`manage_docker_source\` \`rollback\` deploys): when a build finishes, older builds of its source are deleted and their layers are garbage-collected shortly after.
- Build admission fails closed when the registry is read-only or in maintenance, or when no online worker advertises the BuildKit execution, dedicated-runtime, and enforced-resource-profile capabilities. Image-based deployment remains available separately.
- The current Build Worker profile accepts one runc job at a time, requires a separate worker host or outer unprivileged container as its security boundary, enforces the installed CPU/RAM/disk profile, and clears BuildKit/containerd state between jobs. Internet egress is the default installer profile while metadata, private/control-plane destinations, and the Opfield gRPC endpoint are blocked; an offline profile is also available.
- The source \`policy\` decides which scanned findings block a deployment (Business and Enterprise). \`vulnerabilityThreshold\` is the lowest blocking severity (\`critical\` default, \`high\`, \`medium\`, \`low\`; \`none\` reports only; \`disabled\` skips scanning and SBOM). \`vulnerabilityScope\` picks the findings that count: \`all\` (default), \`application\` (OS packages deb, rpm, apk and alpm are report-only), \`fixable_application\` (only findings with a released fix, OS packages report-only), \`fixable_all\` (only findings with a released fix, in any package). A scan from a Build Worker too old to report the counts a scope needs gives the policy result \`error\`; rebuild after updating the worker. Pass both keys inside \`policy\` (\`{ "policy": { "vulnerabilityScope": "fixable_application" } }\`); unknown or misplaced keys are refused. \`manage_docker_source\` \`upsert\` of an existing source changes only the fields you pass: omitted fields and policy keys keep their saved values, and the answer is the saved source including \`policy\`, so check it there.
- Build Secrets are encrypted, source-scoped, write-only values exposed only through explicit BuildKit secret mounts. Never suggest passing secrets as build arguments or copying them into the build context.
- Internal registry operation requires no public domain and is not itself a paid module. Optional Business+ external Docker-client access is configured under Settings > Features and uses an explicit nginx node, domain, TLS certificate, and repository/action-scoped token. Entitlement loss disables the external binding, and every public registry token request rechecks Business.
- Writing a Dockerfile for a Git source: no \`VOLUME\` (an image volume is an anonymous volume Opfield does not manage, and an Opfield volume on the same path fails with "Duplicate mount point"; mount Opfield volumes instead); configuration and secrets from container env and secrets, never baked in; build-time secrets only through \`RUN --mount=type=secret,id=<name>\`; listen on 0.0.0.0 on one fixed port, \`EXPOSE\` it and use it as the route's container port (Opfield sets no PORT variable); a cheap health endpoint (blue/green Deployments probe \`health.path\`; Availability copies use the image \`HEALTHCHECK\`, or a TCP connect without one); exec-form \`CMD\` that stops on SIGTERM within the stop timeout; logs to stdout/stderr; non-root \`USER\`; multi-stage, pinned, slim images and a \`.dockerignore\`. A build gets 2 CPUs, 4 GiB of memory and 20 GiB of disk and stops at the builder timeout (30 minutes by default). There is no pre-deploy command: run migrations at start, idempotent and under a lock, compatible with the release still serving. The deploying-workloads skill reference dockerfile-for-opfield.md (opfield://skills/deploying-workloads/references/dockerfile-for-opfield.md) has an example and the full list.

## Granular Access
- Every standalone container has an Opfield-managed stable access identity; every blue/green deployment uses its stable deployment ID.
- A node-level \`docker:containers:*\` grant covers every container and deployment on that node. A child-level grant covers only the selected container or deployment.
- Child grants are enforced consistently by the UI, REST routes, WebSockets, proxy Docker upstream resolution, AI tools, and MCP tools. Lists omit inaccessible resources.
- Recreating or updating an existing container preserves its stable access identity and grants even though the Docker runtime ID changes.
- Migrating a container or deployment to another node moves its child grants to the target node during metadata cutover.
- Explicitly deleting a container or deployment removes its child grants. A later resource with the same name does not inherit them.

## Container Lifecycle
- **Create**: Deploy from image with ports, volumes, env, networks, restart policy
- **Start/Stop/Restart/Kill**: Lifecycle management (transitions tracked as tasks)
- **Recreate**: Stop + remove + create with new config (preserves name, secrets auto-injected)
- **Duplicate**: Clone a container with a new name (its own secrets are copied too; database and storage link variables are not, so link the copy separately)
- **Remove**: Delete container (must be stopped first)

Before creating a container, list images on the selected node. If the requested image is absent, pull it and wait for the pull task to complete before calling create; do not use a failed create as an image-existence probe. Public Docker Hub images are pulled directly without a saved registry or \`registryId\`.

## Recreated Containers and Stale IDs
Docker container IDs are volatile. Recreate, image update, webhook rollout, or config changes can remove the old
container and create a new one with the same semantic workload/name. If a Docker tool returns "No such container",
do not conclude the workload is deleted. Use \`find_resource\` with the last known container name, nodeId, image, or
other stable hint to locate the recreated container and continue with its new ID.

## Environment Variables & Secrets
- Regular env vars: stored in container config, visible to all users with view access
- Secrets: encrypted at rest in Opfield DB, injected as env vars on container start/recreate. Only users with docker:containers:secrets scope can view decrypted values; docker:containers:environment lists the keys. Secrets are keyed by container name so they survive recreates.

## Image Updates & Webhooks
- **Manual image tag change**: in container Settings, the Image Tag field allows changing the version. Changing the tag and clicking Recreate will pull the new image and recreate the container.
- **Webhook updates**: each container can have a webhook URL enabled (Settings → Webhook section). CI pipelines POST to the webhook URL to trigger automatic pull + recreate. URL format: \`POST /api/webhooks/docker/<token>\` with optional body \`{"tag":"v1.2.3"}\`. No auth header needed — the token in the URL is the auth.
- **Auto-cleanup**: webhook config supports automatic cleanup of old image versions after updates, with configurable retention count.
- Webhook configuration requires the \`docker:containers:webhooks\` scope.
- Use \`update_docker_container_image\` tool to change a container's image tag programmatically (pulls + recreates).
- Image-changing recreate pulls and fully applies the requested image on the target node before stopping the existing container. Pull failure leaves the existing container running.
- Pulls are target-node registry downloads, not direct image copies from another Docker node. A registry-backed migration may likewise reuse the registry reference instead of streaming image bytes between nodes.

## Blue/Green Deployments
- Deployments are Opfield-managed blue/green services with a stable deployment ID, active slot, inactive slot, router, routes, health checks, and release history.
- Managed deployment containers are protected. Do not start, stop, restart, kill, remove, rename, or update the underlying slot container directly.
- Use \`list_docker_deployments\` and \`get_docker_deployment\` to find the deployment ID, active slot, routes, and health.
- Use \`start_docker_deployment\`, \`stop_docker_deployment\`, \`restart_docker_deployment\`, \`kill_docker_deployment\`, \`deploy_docker_deployment\`, \`switch_docker_deployment_slot\`, \`rollback_docker_deployment\`, and \`stop_docker_deployment_slot\` for deployment-safe lifecycle operations.
- To roll out a new image or tag for a deployment, use \`deploy_docker_deployment\` instead of \`update_docker_container_image\`.
- \`deploy_docker_deployment\` \`env\` sets variables over the saved environment and \`removeEnv\` removes keys; the other saved variables stay and the result becomes the saved environment.

## Settings
- **Runtime (live-update)**: restart policy, memory limit, CPU shares, PID limit — applied without recreation
- **Requires recreate**: port mappings, volume mounts, entrypoint, command, stop grace period, working dir, hostname, labels, image tag
- **Stop grace period**: container-level Docker stop timeout in seconds (0-300). Stop/restart tools use this configured value when no explicit timeout is supplied, falling back to 20 seconds.

## Isolation Profiles
- **Default** uses Docker \`runc\` for standard compatibility and GPU/device support.
- **Secure** uses gVisor \`runsc\` for a stronger host-isolation boundary. It is not a virtual machine or a promise of universal Linux syscall compatibility.
- Secure can be selected only when the target node reports a healthy Secure Runtime state. Creation fails closed while setup is unknown, installing, unhealthy, or unsupported; direct the administrator to **Node Details > Secure Runtime Setup**, or use \`manage_docker_runtime\` (\`preflight\` checks the node, \`install\` installs gVisor and restarts Docker on that node; needs nodes:manage on the node) when the user asked for it.
- Secure Runtime needs no KVM. It supports compatible Linux amd64/arm64 hosts with a local, restartable Docker Engine. Compatible LXC guests can work when nested Docker and the required host capabilities are available; do not claim universal LXC support.
- Secure workloads cannot attach GPUs or devices, use host bind mounts, migrate between nodes, or export as \`.gwca\` archives. Changing profile recreates the workload.
- Every newly created Opfield workload in either profile is non-privileged, adds no Linux capabilities, and receives \`no-new-privileges\`.

## Images, Volumes, Networks
- Images: list, pull from registries, remove, prune unused
- Old images: each container or blue/green deployment keeps the image it runs plus older ones up to its image cleanup setting (manage_docker_container image_cleanup_get/upsert; on by default, retentionCount 2 = running + one rollback; with cleanup off all its images stay). The setting of a deployment or an Availability copy is its workload's on every node. Older images go 2 minutes after a change (a Git-source build deploy, an update, a recreate, a webhook, a Compose apply), so a rollout that pulled one again keeps it. Unused images nothing runs or names (a removed container's image, an earlier Compose tag, a superseded engine or tool, builds of a deleted source, dangling images) go once unused for 12 hours; images a deployment, Compose revision, Availability policy, rollback release or pull under way names, and the builds the internal registry keeps, always stay. Housekeeping Docker Images (on by default) runs this on every Docker node; prune_docker_images on one node. Database and storage nodes remove their own unused engine images after 24 hours unused, keeping the newest of each. The internal registry deletes the builds of removed sources (12 hours after maintenance first finds them), removes upload leftovers of failed pushes after a day, and refuses new builds and pushes while the disk under it is 90% full or more (local storage only).
- Volumes: \`manage_docker_volume\` creates Opfield-managed local volumes with no custom driver: \`storageKind: "regular"\` (default) or \`storageKind: "disk-image"\` with \`capacityBytes\` (at least 256 MiB). Disk-image volumes require a compatible node and Personal-or-higher licensing. \`operation: "resize"\` grows a disk-image volume (never shrinks) and \`operation: "adopt"\` brings an eligible legacy local volume under Opfield management without copying data. New or changed mounts can reference only Opfield-managed local volumes; never propose a host bind path.
- Existing legacy mounts remain unchanged during ordinary updates. A legacy volume can be adopted (in the UI or with \`manage_docker_volume\` \`operation: "adopt"\`) only when it uses the local driver, local scope, and no driver options. Orphaned unmanaged volumes are hidden.
- Networks: \`list_docker_networks\` lists them; \`manage_docker_network\` creates, deletes, connects, and disconnects containers.

## Compose Boundaries
- Community and paid plans discover existing Compose projects from canonical Docker labels and expose read-only inventory, status, monitoring, and logs. Adoption always requires a complete user-supplied single-file YAML document; Opfield never reads host Compose files or trusts label paths.
- Personal and higher can deploy and manage single-node image-only Compose Projects with immutable revisions, explicit Pull & Apply, lifecycle operations, folders, logs, masked secrets, operation history, drift reporting, ordinary non-Swarm CPU/memory/PID limits, managed database links, and Route/Secure Link targeting by project/service identity.
- Use \`manage_docker_compose\` for project list/get/validate/create/adopt/delete, revision list/get/create/delete, operation history and lifecycle starts, and masked-secret lifecycle. It is available to AI Workspace and remote MCP with the same Compose resource scopes and Personal-or-higher mutation entitlement as REST. Use \`find_resource({ types: ["docker_compose_project"] })\` when only a name is known.
- For manual YAML validation and revisions, always reject \`build\` even when an image is also present. Repository-backed Compose is the only supported build path and accepts only the bounded context/dockerfile/args subset. Also reject host bind mounts, privileged/device access, swarm/PaaS features, and direct mutations of project-owned child containers, named volumes, or non-external networks.
- Images and external/shared volumes or networks remain global. Compose-managed resources cannot use Opfield cross-node migration.
- Workload Availability (HA) is available on Business and Enterprise for mount-free Containers, Deployments, and whole Compose Projects: 2–32 replicas or one serving placement with failover across independent Docker nodes, without Swarm or an overlay. It does not provide HA for Opfield itself, nginx, registry storage, or shared volumes. Metric autoscaling and multiple instances on the same node remain in development.

## Inventory Availability
- Opfield keeps sanitized container, deployment, image, volume, and network inventory snapshots. Read views can show the last synchronized state while a Docker node is offline or refreshing.
- Treat snapshot availability metadata as authoritative. Do not attempt mutations against unavailable resources; explain that the node must reconnect before Opfield can change them.

## Cross-Node Migrations
- Opfield can migrate a standalone container or a blue/green deployment to another Docker node, including referenced images, named-volume data, capacity preflight, verification, proxy cutover, cancellation, and cleanup recovery.
- Secure Runtime workloads and GPU-attached workloads are not eligible for cross-node migration in the current version.
- Migration requires \`docker:containers:migrate\` plus the source-resource permissions needed to inspect protected configuration, secrets, and mounts.
- Use \`manage_docker_migration\` to preflight first, start with the returned fingerprint, inspect progress, cancel before cutover, or retry cleanup. Never start without a blocker-free current preflight.
- Container archive export requires \`docker:containers:export\` plus file and environment access for the source container. Secret values are included only when the caller also has \`docker:containers:secrets\`. Secure Runtime workloads and containers with host bind mounts cannot be exported. Import rejects host bind mounts and accepts existing volume selections only from safe Opfield-managed local volumes.
- Remote MCP clients move archives with the MCP-only \`download_docker_archive\` and \`upload_docker_container_archive\` tools. With a shell, use operation \`link\`: it runs the same checks as \`begin\` and returns a one-time URL (15 minutes, single use) with a ready command, \`curl -fsS -o <file> <url>\` to stream an export from the node or \`curl -T container.gwca <url>\` to import a \`.gwca\` archive (the curl response is the new stopped container). Using a link repeats the permission checks with the caller's current grants; an interrupted transfer imports nothing and leaves an incomplete download file that must be deleted. The link is a credential: never repeat it in chat. Without a shell, the base64 begin/chunk workflow carries at most 1 MiB per call.

## Registries & Templates
- Registries: add private Docker registries with encrypted credentials, global or node-specific, with \`manage_docker_registry\` (topic docker-registries).
- Templates: save container configurations as reusable templates for quick deployment

## Tasks
Long-running operations (stop, restart, kill, recreate, update, image pulls, webhook actions) create tasks visible on the Tasks page. Tasks track progress and completion status: \`manage_docker_task\` \`list\` and \`get\` read them (callers with node-scoped docker:tasks see the tasks of their nodes). Migrations have their own tool, \`manage_docker_migration\`.

## Console & Files
- Console: interactive terminal (exec) into running containers via xterm.js WebSocket
- Assistant console command: \`execute_docker_container_console_command({ nodeId, containerId, command: ["sh","-lc","..."], user? })\` runs one command in a container when ordinary Docker tools do not cover the needed inspection or repair. It requires \`docker:containers:console\`, is destructive, is available to MCP only when that OAuth scope is explicitly granted, and blocks catastrophic patterns such as \`rm -rf /\`.
- Before using container console, resolve the current container through get_current_context or find_resource. Container IDs can change after recreate, so re-check by name when a command reports "No such container".
- File browser: navigate/read container files with \`docker:containers:files:read\`; create/edit/move/delete/upload requires \`docker:containers:files:write\`.

## Key Notes
- Most Docker tools require a nodeId parameter. If the user names a container/image/volume/network, use find_resource first; it returns nodeId with the match. Use list_nodes with type="docker" only when you specifically need to choose or inspect Docker nodes.
- Container IDs change after recreate/update — the frontend handles navigation to new IDs
- Transition states (stopping, restarting, recreating, deploying, switching, etc.) block concurrent operations on the same container or deployment`,

  availability: `# Docker Workload Availability

Availability places a standalone Container, a blue/green Deployment, or a whole Compose Project on several independent Docker nodes. It is a Business and Enterprise feature. A policy attaches to the existing workload and from then on owns placements, routing membership, and cleanup; there is no new resource type. One tool covers it: \`manage_docker_availability({ operation, ... })\`, gated by \`docker:availability:manage\` (folder grants resolve through the workload's folder; the scope implies \`docker:containers:view\`).

## Modes
- \`replicated\`: 2 to 32 serving placements, at most one per node (\`desiredReplicaCount\`). Replica count is manual; there is no metric autoscaling.
- \`failover\`: exactly one serving placement; after a loss a standby or replacement on another node takes over.
- Priority mode (\`priorityMode: true\` with an ordered \`nodePriority\`) serves from the first available nodes and fails back to a higher-priority node once it has stayed healthy for \`failbackDelaySeconds\` (default 300).

## Prerequisites
- At least two online compatible Docker nodes with capacity for the placements plus temporary rollout placements.
- No mounts of any kind (named, external, read-only, or host bind; the whole Compose project is checked). Persistent state must live outside the workload, for example in a managed database binding or a managed storage link.
- Every placement gets the workload's managed database bindings and managed storage links on its own node. A workload with a storage link runs only on Docker nodes whose daemon hosts storage links (\`managed_storage_link_v1\`); preflight lists other nodes as incompatible (\`AVAILABILITY_STORAGE_LINK_CAPABILITY_UNAVAILABLE\`) and refuses when one of them was selected or too few nodes remain.
- Images are pinned by digest in the internal registry and pre-pulled on standby nodes.

## Workflow
1. \`preflight\` with \`resource: { type, nodeId, containerName | deploymentId | composeProjectId }\`, \`mode\`, and optional \`desiredReplicaCount\`, \`nodeSelectionMode\`, \`selectedNodeIds\`; resolve every incompatibility it reports.
2. \`enable\` with the same shape plus optional \`rolloutPolicy\`, \`offlineReplacementGraceSeconds\`, and \`partitionMode\`. The running workload becomes the first placement where it runs, without an outage or a second copy beside it.
3. Poll \`get\` / \`get_by_resource\` and \`list_operations\` until the serving count is reached, then verify real traffic through the Route.
4. \`update\` changes mode, replicas, node selection, rollout policy, grace, \`partitionMode\`, or priority mode; \`retry_operation\` retries a failed operation.
5. \`disable\` needs \`survivingPlacementId\` and the exact typed \`confirmation\` the tool or Console shows; the survivor keeps running as the plain workload. Never guess either value.
Stop stops every copy and keeps the placements; Start starts the copies that served last. None of these deletes the original workload.

## Replica health
- Every serving copy is judged by its Docker state (missing, stopped or paused container, restart loop, failing Docker \`HEALTHCHECK\`) and, where the workload has one, by an HTTP health check: the health check of a Route that serves it, or a deployment's own health check (its startup grace and success threshold apply). The copy's Docker node runs the HTTP check against the copy at the check's interval.
- A copy failing its HTTP check twice in a row leaves its routes only while the policy keeps serving without it: Replicated while another copy serves and passes, Failover in lease mode when a prepared standby can take over. Otherwise it keeps serving, the placement and the policy show \`AVAILABILITY_PLACEMENT_HTTP_UNHEALTHY\`, and the policy is \`degraded\`. In lease mode its slot is released (a standby takes over, or the copy restarts on its node); outside lease mode a replacement starts on a free node, and a Failover copy keeps its routes until the replacement serves. It returns once the check passes twice in a row.
- HTTP checks need the 2.11 Docker daemon (\`availability_http_health_v1\`) and a running Opfield; while Opfield is down only the Docker state counts. A copy stopped for its Docker state is started again after about 20 seconds, the wait doubling up to 5 minutes while it keeps failing.

## Data-plane failover (lease mode)
- A policy switches to lease mode by itself once every candidate Docker node, ingress Nginx node, carrying relay and witness has run \`availability_lease_v2\` (with its lease watchdog) for 2 minutes without a restart; until then \`lease.reason\` is \`participants_settling\`. There is no switch to turn it off.
- In lease mode nodes and relays hold a lease per serving slot. A holder that cannot renew stops its own copy, and the next candidate takes over within about 45 seconds even while Opfield is down. Takeovers are audited as \`docker.availability.lease_failover\`, planned moves as \`lease_handoff\`, and a slot retaken by the same node as \`lease_reacquired\`.
- \`partitionMode\`: \`strict\` (default) never runs two copies of a slot; \`available\` keeps serving on both sides of a split and may briefly run two copies. Never use \`available\` for singletons such as queue consumers or cron jobs.
- Voters are the candidate nodes (one per physical host) plus witnesses so the count is odd and at least 3. \`lease.voterMargin.margin\` of 0 or less means losing one more voter disables autonomous failover. Every node of a lease-mode policy must reach every relay.
- The lease watchdog (\`opfield-lease-watchdog\` on each Docker node; a node installed before 2.12.1 runs it as \`gateway-lease-watchdog\` until the watchdog updates itself) stops a lease-mode copy past its deadline even when the Docker daemon or dockerd hangs. The node installer installs it, and a root Docker daemon with systemd or OpenRC installs it itself. A node without it is listed in \`lease.excludedNodes\` with \`watchdog_missing\`; re-run the node installer there. Other reasons are \`offline\`, \`daemon_outdated\`, and \`identity_pending\`; an excluded node never changes the policy's mode.
- A planned move (failback, drain, \`nodePriority\` change) in lease mode is a handoff with a short gap, usually 5 to 15 seconds; in failover mode with \`strict\` requests fail for that time.
- Daemon and relay updates of lease participants run one after another; a waiting node shows \`metadata.updatePhase: waiting_for_lease_peers\`. Ingress (nginx) nodes restart after the other nodes whose updates are under way (same phase, \`updateWaitingFor\` entries with reason \`ingress_last\`). Before that, a daemon update waits for the long tasks of its node (\`waiting_for_tasks\`, at most 30 minutes). \`now: true\` waits for neither the tasks nor the lease peers.

## Limits
Availability protects the workload, not Opfield itself, nginx, the database engine, registry storage, or shared volumes. Compose Availability replicates the whole project per placement; it does not spread individual services across nodes. Published host ports are served only on the original node: copies on other nodes publish none and are reached through Routes, Container Links or Advanced Secure Links (preflight warns with \`AVAILABILITY_HOST_PORTS_NOT_REPLICATED\`).`,

  databases: `# Databases

## Overview
Opfield supports two database resource models:
- **External connections** store operator-supplied connection details and are operated directly by the backend.
- **Managed instances** run curated Postgres, key-value store (works with Redis clients), or ClickHouse images on a Storage node (or a compatible legacy database node). They are private by default and use daemon-managed storage.

Managed database instances are not generic Docker workloads. Storage nodes run Opfield-managed databases, object storage and bounded backup jobs. Legacy database nodes remain database-only.

## Managed Instance Access
- A managed instance has no published host port by default. Application bindings use the private connector and authenticated Opfield tunnel; do not substitute direct TCP for a binding.
- The tunnel terminates in Opfield's separate long-lived relay container. Ordinary app-only updates keep established binding traffic running; a red relay warning is a critical operator state after bounded automatic recovery fails, not a reason to publish a replacement port.
- A TCP endpoint is an independent, explicit publication option for infrastructure outside Opfield. It requires engine authentication and may not be tunnel-encrypted unless the database engine is configured with TLS. Opfield does not change host firewalls automatically.
- Each application binding gets a separate engine identity. Its URI and optional host/port/database/user/password environment values are injected into the selected application; do not reveal, log, or copy those values unless an explicit secret-reveal flow permits it.
- Assistant and MCP flows use \`manage_managed_database\` for catalog/list/get/create/update/retry/delete, restart/pause/unpause, move_to_valkey, PostgreSQL extensions (extensions, enable_extension, disable_extension, update_extension), certificate rotation, workload binding lifecycle, and availability (one database on several storage nodes: availability_preflight, make_available, availability, availability_events, update_availability, add_member, reorder_members, remove_member, rebuild_member, make_primary, disable_availability; \`manage_managed_storage\` has the same actions for SeaweedFS storage). Before turning availability on, run the preflight and tell the user the mode, the witnesses and the loss window it reports; make_primary with acceptDataLoss only after the user accepted the estimated loss. reorder_members (memberIds: every member once, the preferred first) sets the failover order the availability view lists: which copy takes over first and, with priorityMode, the server the primary moves back to after the failback delay; it never moves the primary by itself. On a database or storage on several servers, update (settings or version), restart, pause, unpause and delete act on every server: copies first, the primary hands over to an updated copy without loss when it needs a restart, a pause keeps the primary's role (no failover), and delete turns availability off first; a database's TLS on/off is refused while availability is on (409 AVAILABILITY_TLS_CHANGE). Read the catalog before create, keep instances private unless the user explicitly requests publication, poll get until ready, then create a standalone-container, deployment, or Compose-service binding. One database can have separate bindings for multiple services; each binding receives a distinct engine identity. \`logs\` returns recent container log lines.
- Guarded credential operations run only when the user explicitly asks: \`reveal_credentials\` and \`rotate_credentials\` return the direct-access principal of a published instance (\`databases:credentials:reveal\`; rotation also \`databases:edit\`), and \`reveal_binding_credentials\` returns one binding's credentials (also requires the target workload's binding scopes). All three are refused while impersonating. Opfield never returns the internal owner account; outside these explicit requests never reveal owner or binding credentials.
- The Operations Console exposes per-binding link runtime telemetry on the overview of linked standalone containers, deployments, and Compose projects, including active streams, throughput, setup latency, completion health, and admission rejects. The runtime of an Availability link is the sum of its placements. The protected REST route is \`GET /api/databases/managed/{id}/bindings/{bindingId}/runtime\` and requires view access to both the managed database and target workload; \`manage_managed_database\` \`get_binding_runtime\` reads the same telemetry with the same checks. A managed storage link has the same runtime: \`GET /api/managed-storage/{id}/bindings/{bindingId}/runtime\` and \`manage_managed_storage\` \`get_binding_runtime\` (storage:view and view access to the workload).
- A database link carries as many concurrent connections as its database accepts (PostgreSQL \`max_connections\`, 100 by default and set with \`manage_managed_database\` update \`postgresConfig.maxConnections\`, 20 to 10000, which recreates the container; key-value store \`maxclients\`; 4096 for ClickHouse), shared by every container it serves and by both slots of a deployment during a rollout (Availability gives each placement its own link); all links of the database share the database limit too. A storage link has no fixed limit: relay admission bounds it by load and shares it fairly between routes. Idle pooled connections of both stay open. A connection over the capacity is accepted and closed at once (\`Connection terminated unexpectedly\`, \`ECONNRESET\`); the node logs \`managed link connection rejected\` with \`reason=link_limit\` in its node logs, and the link runtime counts it in \`throttledTotal\`. In the runtime, \`activeStreams\` is the link's open connections as the node counts them, \`openedTotal\` and the byte counters what the link carried through the node whichever relays carried it, and \`connections\` gives the limit, the node's refusals and \`lastRejectionReason\` (null while the node's Docker daemon predates it). The relay-only counters (\`failedTotal\`, \`setupLatencyP95Ms\`, \`averageDurationMs\`, \`lastActivityAt\`) sum every relay that holds the link's routes; \`relayCountersComplete\` false means one of them did not answer (an older relay daemon, a timeout) and those counters are partial. A growing \`throttledTotal\` means the workload's pools are too large for the link, not that the link is broken.

- Container links (\`manage_container_link\`, REST \`/api/docker/container-links\`) connect two workloads privately: the consumer reaches one port of the target as \`alias:port\` on its own internal link network through the shared secure-link connector, relayed across nodes and direct on one node. Operations: \`list\` (a workload's outgoing or incoming links), \`create\`, \`get_runtime\`, \`delete\`. Creating needs \`docker:containers:edit\` on the consumer (\`docker:compose:manage\` for a Compose service; \`docker:containers:environment\` when it sets variables) and \`docker:containers:link\` on the target (\`docker:compose:manage\` for a Compose service); creating needs the current plan, while reading and deleting keep working on existing links. Statuses: ready, pending, waiting (the target does not run), update_required (a Docker daemon lacks \`secure_link_egress_v1\`), error.

## Providers
- **Postgres**: schema/table explorer, paginated row browser, row insert/update/delete for PK-backed tables, SQL console, monitoring.
- **Key-value stores** (\`type: "redis"\`, managed or any saved Redis-protocol server): key browser, type-aware viewer/editor for common types (string, hash, list, set, zset), Redis command console, monitoring. Engines, Move to Valkey and backup rules: topic \`redis\`.
- **ClickHouse and provider-neutral SQL**: \`manage_postgres_data\` \`sql_*\` operations use the same SQL explorer as the UI (namespaces, objects, table metadata, rows, console); the query scope follows the statement intent. Managed Postgres extensions are listed with query read and enabled/disabled with query admin (\`list_extensions\`, \`enable_extension\`, \`disable_extension\`).

## Credentials
- Connection credentials and managed owner credentials are encrypted at rest in the Opfield database using the same envelope-encryption primitive used for Docker secrets and PKI keys.
- Raw credentials are hidden by default. Revealing an explicitly requested credential requires the \`databases:credentials:reveal\` scope. Binding-injected credentials remain hidden by default.
- Team members can operate databases through Opfield without being given the raw hosting credentials.

## Permissions
- \`databases:view\`, \`databases:create\`, \`databases:edit\`, \`databases:delete\` govern both external connections and managed instances.
- \`databases:bind\` links and unlinks workloads (containers, deployments, Compose services) without the right to change the database; \`databases:edit\` includes it. The target workload's own binding scopes are still required.
- \`databases:query:read\`, \`databases:query:write\`, \`databases:query:admin\`; a query grant also lets the caller view that database, in REST and in AI/MCP tools alike.
- \`databases:credentials:reveal\`
- Backups: \`databases:backups:view\` (policies and history), \`databases:backups:manage\` (policies, removing runs), \`databases:backups:run\` (start and cancel runs), \`databases:backups:restore\` (OAuth manual-approval); runs also need \`storage:credentials:use\` on the destination storage and \`nodes:backups:execute\` on the executor Storage node.
- Most database scopes are resource-scopable by database ID, so access can be limited per saved connection.

## Monitoring
- Opfield stores short rolling metric history for database sparklines and persists health-history entries for health bars. Managed lifecycle and health notifications contain only the database ID, display name, engine, and safe status; never credentials, connection URIs, generated aliases, or daemon errors.
- Postgres metrics include latency and active connection utilization.
- Key-value store metrics include latency and memory utilization.

## Audit
- Connection CRUD, connection tests, credential reveals, data mutations, and console executions are audit logged.
- Query text and command text are sanitized and truncated in the audit log to avoid leaking secrets.`,

  pages: `# Pages

Pages serves immutable static Deployments owned by a Page Project. Use \`find_resource({ types: ["page_project"] })\` and \`manage_pages\` for profile, project, deployment, Tag, deploy-token, migration, pinning, retention, runtime-config, Git-source, Build Secret, and source-build operations.

## Agent recipe: publish HTML and share a link
1. Pick or create a Project (\`manage_pages\` \`project_list\` / \`project_create\`). The Pages profile must be licensed and enabled.
2. Produce the site: a build folder with \`index.html\` at its root, a \`.tar.gz\` of one, or a single self-contained HTML file (it becomes \`index.html\`).
3. Upload with the MCP-only \`upload_pages_artifact\`. From a shell, call \`link\` (with \`projectId\` and optional \`tag\`, \`format\`, expiry) and run one of the returned curl commands: \`curl --data-binary @site.tar.gz <url>\` for an archive or HTML file, or \`tar czf - -C dist . | curl --data-binary @- <url>\` to pack and stream a folder. The link is valid for 15 minutes and works once; the curl response is the finalized Deployment with its links, and an interrupted or rejected transfer leaves nothing behind (create a new link to retry). Without a shell, \`begin\` with the exact byte size and lowercase SHA-256 of the bytes you send (add \`format: "html"\` for a single HTML file; it is detected from content when omitted), ordered \`chunk\` calls of at most 1 MiB decoded base64 each at the returned upload ID and current offset, then \`finalize\`; \`cancel\` stops an unfinished upload and deletes its Deployment.
4. The finalize result carries \`links.preview\` (the immutable Deployment preview URL). With \`tag\` set at \`link\` or \`begin\`, \`links.tag\` is the stable Tag preview URL \`https://<project hash>-<tag>.<Pages domain>\`, which follows the Tag to every later Deployment; \`links.latest\` is the same for the system \`latest\` Tag. A link still being published after about 15 seconds is returned with \`status: "pending"\`; re-check with \`deployment_links\` or \`tag_list\` instead of guessing. \`status: "unavailable"\` carries a \`reason\` (previews_disabled, profile_disabled, label_too_long, access_unsupported, ...).
5. Share the Tag URL for a link that stays stable across uploads; share the Deployment URL for an exact immutable version.

## Options
- Expiry: \`expiresAt\` (ISO 8601, 5 minutes to 1 year ahead) or \`expiresInHours\` (1-8760) at \`link\`, \`begin\` or \`finalize\`, also on the REST deploy API. Maintenance deletes an expired Deployment with its previews and files and clears Tags that pointed at it (their Tag preview goes away). Pinned Deployments, and Deployments a custom-domain Route still serves, are not expired. A Deployment without an expiry is never expired.
- Access list: \`project_update\` with \`accessListId\` protects every preview host of the Project (Deployment and Tag previews) with the list's IP rules and basic authentication, exactly like a route. It needs pages:edit and acl:view on the list, and a Pages node daemon that supports preview access lists; \`accessListId: null\` removes it.
- Rotate links: \`project_rotate_preview_hash\` gives the Project a new hash and new Deployment slugs, revokes every old preview link at once, republishes the new ones, and is audit logged. Use it when a preview link leaked.
- Missing paths: with SPA fallback on, a missing app path (no file extension in its last segment) serves \`index.html\`, while a missing file path such as \`/app.js\` stays a 404 (the \`404.html\` below); otherwise a Project fallback URL redirects (302) to it; otherwise, when the Deployment has a top-level \`404.html\`, that file is served with status 404 (Routes, additional Routes, Tag and Deployment previews alike), and without one Opfield's generic 404 page answers.
- Tag names are lowercase DNS labels; new Tags are at most 50 characters so \`<hash>-<tag>\` stays one DNS label. Older longer Tags keep working but report \`label_too_long\` for their preview link.

## Limits
- Uploads obey the Opfield file-upload size limit and the Project storage quota and retention limit. Upload links take the whole artifact in one request; MCP chunks carry at most 1 MiB decoded data; REST chunks at most 8 MiB. Archives are validated: no links or special files, bounded file count and expanded size, and an \`index.html\` (or \`index.htm\`) at the root.
- An unfinished upload expires 30 minutes after its last chunk. Until then \`cancel\` (by upload ID, for the uploader) or \`manage_pages\` \`deployment_delete\` (with pages:deployments:manage) removes it at once.

## Workflow
- A Project is placed on one Pages-capable node and can be migrated with \`project_migrate\`.
- Authentication for \`upload_pages_artifact\` comes from the MCP OAuth connection; never pass a token or Authorization value as a tool argument. An upload link is itself a one-time credential: use it right away and do not repeat it in chat. The embedded AI Workspace does not expose this binary-transfer tool.
- On Business and Enterprise, \`manage_pages\` can list source repositories, discover package.json, attach or remove a Git source, manage source-scoped Build Secrets, and queue builds. Use \`list_docker_builds\` and \`manage_docker_build\` for the resulting Build Worker jobs, logs, cancellation, and retry.
- \`manage_pages\` operates deployment metadata, source configuration, builds, and publication, not local archive bytes. The REST resumable deploy API remains available to ordinary API clients.
- Deploy tokens can be listed, created, and revoked with \`manage_pages\`. A newly created raw token is returned once; do not repeat it in later chat messages, notifications, or logs.
- Deployments are immutable. Mutable Tags point at ready Deployments. Ingress Routes and Additional Routes target a Tag, never an immutable Deployment.
- Runtime configuration is a JSON object exposed as \`window.runtime.config\`. Save a default config or a Tag override; deleting a Tag also removes its override and its Tag preview. Deployment previews serve the default configuration; a Tag preview serves the Tag's override when it has one, like the Tag's Routes.
- Disabling Pages stops immutable preview publication but existing Tag routes and stored content continue to work.

## Permissions
- \`pages:deploy\` uploads (MCP and REST); \`pages:view\` reads Projects, Deployments, Tags and links; \`pages:edit\` changes Project settings, the access list and rotates links; \`pages:tags:manage\` moves and deletes Tags; \`pages:deployments:manage\` pins and deletes Deployments. All are resource-scopable per Project and follow Project folders. Profile changes require \`pages:settings:*\`.
- Never bypass the Pages entitlement or daemon capability checks.`,

  postgres: `# Postgres in Opfield

## Explorer
- Schemas and tables are discovered from \`information_schema\`.
- Row editing in the visual explorer requires a primary key. Tables or views without a PK are browse-only in the explorer.
- Explorer pages are paginated; use the SQL console for advanced filtering or bulk operations.

## SQL Console
- One or more SQL statements can be executed per request.
- Read, write, and admin statements are separated by permissions: \`databases:query:read\`, \`databases:query:write\`, and \`databases:query:admin\`, each granted broadly or for the target saved connection (a query grant implies viewing that connection).

## Monitoring
- Health is based on connectivity and latency.
- Metrics include \`latency_ms\`, \`active_connections\`, \`max_connections\`, \`active_connections_pct\`, and \`database_size_bytes\`.`,

  redis: `# Key-value stores in Opfield

Key-value stores work with Redis clients. The API, tools and saved connections keep the type \`redis\`; managed views also report \`engine\` (\`valkey\` or \`redis\`).

## Engines
- New managed key-value stores run Valkey 9.1.2 with the JSON, Bloom and Search modules. The catalog lists only Valkey versions for \`redis\`; a create with an older Redis version gets the current Valkey version.
- Stores created before 2.12 keep running Redis (\`engine: "redis"\`) until the user runs Move to Valkey. Nothing moves them automatically.

## Move to Valkey
- \`manage_managed_database\` \`move_to_valkey\` (REST \`POST /api/databases/managed/{id}/move-to-valkey\`, \`databases:edit\`) runs only on the user's request, on a running store that still runs Redis, on a node whose daemon supports Valkey.
- The store is \`updating\` while it runs. Every key is copied into Valkey on the same node; writes pause while the keys are copied, reads keep working. The Redis data stays on the node until the key counts match.
- If anything fails, the store goes back to Redis. A store holding keys that cannot be copied (Bloom or cuckoo filters, time series, vector sets, search indexes) is refused before anything changes: the store stays ready on Redis and \`lastError\` names the key types.
- Check first with \`move_to_valkey_check\` (REST \`GET\` on the same path): \`keys\`, \`usedMemoryBytes\`, \`estimatedPauseSeconds\` (expected write pause), \`blockers\` (data Valkey cannot take over; the move is refused while there are any) and \`pendingStreamEntries\`. Stream consumer groups move with their last delivered ID, but their pending entries do not: with pending entries the move needs \`acceptPendingStreamLoss: true\`, set only after the user accepted the loss.
- Refusals: \`MANAGED_DATABASE_ALREADY_VALKEY\`, \`MANAGED_DATABASE_NOT_RUNNING\`, \`MANAGED_DATABASE_DAEMON_UPDATE_REQUIRED\` (update the node daemon first), \`MANAGED_DATABASE_OPERATION_PENDING\`.

## PostgreSQL extensions
- Managed PostgreSQL offers a curated list of extensions (pgvector, PostGIS, pg_cron, pg_partman, pg_stat_statements, pgaudit and the useful contrib ones); nothing outside the list can be turned on. \`manage_managed_database\` \`extensions\` (REST \`GET /api/databases/managed/{id}/extensions\`, \`databases:view\`) lists them with \`category\`, \`description\`, \`status\` (enabled, update_available, available, needs_bundle, needs_image_update, unavailable = not in this version), \`availableVersion\`, \`installedVersion\`, \`bundleSizeBytes\`, \`restartToEnable\` and \`restartToDisable\`.
- \`enable_extension\`, \`disable_extension\` and \`update_extension\` with \`extension\` (REST \`POST\`, \`DELETE\` and \`POST .../update\` on \`/api/databases/managed/{id}/extensions/{name}\`, \`databases:edit\`) run CREATE EXTENSION ... CASCADE, DROP EXTENSION (never CASCADE: \`EXTENSION_HAS_DEPENDENTS\` lists what depends on it) and ALTER EXTENSION ... UPDATE as the control role in the application database, on the primary of a database on several servers. The application role can use the extension's objects afterwards. Each change is audited.
- Extensions that need a preload library (pg_stat_statements, pg_cron, pgaudit, pg_hint_plan, pg_stat_kcache, pg_qualstats, pg_show_plans) restart the database when they are enabled or disabled (a rolling update copies-first on several servers). Large extensions (PostGIS, pgRouting) are downloaded into the database volume on every server first and count against its storage: \`EXTENSION_NEEDS_STORAGE\` means grow the storage. While \`pending\` is set the change continues on its own; \`lastError\` keeps a change that failed. Tell the user about a restart or a download before changing.
- Extensions outside PostgreSQL contrib need Opfield's PostgreSQL image (\`needs_image_update\`): \`update\` with \`imageUpdate: true\` moves the database from the official image of its version to Opfield's image of the same version (data kept, one restart; \`imageUpdateAvailable\` tells whether one is published). \`daemonUpdateRequired\` (or \`MANAGED_DATABASE_DAEMON_UPDATE_REQUIRED\`) means the node daemon must be updated first.

## Backups
- A backup restores only into the engine it was taken from. A Redis backup restores into a store that runs Redis or into a new store, which then runs the backup's Redis version. A Valkey backup restores only into Valkey. A mismatch fails before the target is touched.

## Explorer
- Keys are discovered with \`SCAN\`, not \`KEYS\`, so the browser can safely handle large keyspaces.
- Visual editing supports string, hash, list, set, and zset.
- Tool: \`manage_redis_data\` on a saved connection (type redis): \`scan_keys\`, \`get_key\`, \`set_key\`, \`delete_key\`, \`expire_key\`, \`execute_command\`.
- Streams are browse-only in the visual explorer; use the command console for advanced stream operations.

## Command Console
- One or more Redis commands can be executed per request.
- Read, write, and admin commands are permission-gated by \`databases:query:read\`, \`databases:query:write\`, and \`databases:query:admin\`, each granted broadly or for the target saved connection (a query grant implies viewing that connection).

## Monitoring
- Health is based on connectivity and latency.
- Metrics include \`latency_ms\`, \`used_memory_bytes\`, \`maxmemory_bytes\`, \`memory_pct\`, \`connected_clients\`, and \`instantaneous_ops_per_sec\`.`,

  logging: `# External Logging

Opfield can ingest structured logs from external services into ClickHouse-backed logging environments.

Before creating environments or schemas, call \`manage_logging_backend\` with \`get\`. If logging is disabled on an empty Opfield, ask whether to provision Opfield-managed local ClickHouse or use an existing external ClickHouse, then apply the chosen backend before continuing.

Per-environment retention TTL is complemented by optional Housekeeping caps for total rows and approximate disk size. ClickHouse also has an internal-log safety budget and health guard. Enable ClickHouse Internals in Housekeeping to allow cleanup of supported system tables, and only do so for an instance dedicated to Opfield. Users with housekeeping access see storage pressure on the Dashboard.

## Resource Types
Use manage_logging with singular resource names:
- Environments: { resource: "environment", operation: "list"|"get"|"create"|"update"|"delete" }
- Schemas: { resource: "schema", operation: "list"|"get"|"create"|"update"|"delete" }
- Ingest tokens: { resource: "token", operation: "list"|"create"|"delete", environmentId }
- Logs: { resource: "logs", operation: "search", environmentId, payload }
- Facets: { resource: "facets", operation: "facets", environmentId, payload }
- Metadata: { resource: "metadata", operation: "metadata", environmentId }

## Important Tool Argument Rules
- Canonical tool resources are singular: "environment", "schema", "token". Do not copy plural REST nouns like "schemas" unless you have to; use the singular canonical form.
- Create/update/search bodies go in payload, not at the top level.
- Use find_resource({ query, types: ["logging_environment"] }) or find_resource({ query, types: ["logging_schema"] }) when the user names an environment/schema and you need its ID.

## Schema Payload
\`\`\`json
{
  "resource": "schema",
  "operation": "create",
  "payload": {
    "name": "Application Logs",
    "slug": "application-logs",
    "description": "Structured application events",
    "schemaMode": "loose",
    "fieldSchema": [
      { "key": "service", "location": "label", "type": "string", "required": true },
      { "key": "durationMs", "location": "field", "type": "number", "required": false }
    ]
  }
}
\`\`\`

schemaMode:
- loose: accept unknown labels/fields
- strip: drop unknown labels/fields
- reject: reject events with unknown labels/fields

fieldSchema entries:
- key: safe key matching letters/numbers/underscore/dot/dash rules
- location: "label" or "field"
- type: labels must be "string"; fields can be "string", "number", "boolean", "datetime", or "json"
- required: whether every event must include the key

## Environment Payload
\`\`\`json
{
  "resource": "environment",
  "operation": "create",
  "payload": {
    "name": "Production",
    "slug": "production",
    "enabled": true,
    "schemaId": null,
    "schemaMode": "reject",
    "retentionDays": 30,
    "fieldSchema": []
  }
}
\`\`\`

## Searching Logs
\`\`\`json
{
  "resource": "logs",
  "operation": "search",
  "environmentId": "<logging environment UUID>",
  "payload": {
    "query": "error",
    "limit": 100,
    "services": ["opfield-backend"],
    "sources": ["codex-smoke"]
  }
}
\`\`\`

## Ingest Tokens
- Create tokens with { resource: "token", operation: "create", environmentId, payload: { name, expiresAt? } }.
- The raw token is shown only once. Do not expose it unless the user explicitly needs to configure an ingest client.`,
};
