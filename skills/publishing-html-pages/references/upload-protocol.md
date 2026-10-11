# Pages upload protocol

`upload_pages_artifact` is the MCP-only upload for Pages: a one-time upload link for a shell, or a resumable begin/chunk/finalize session. It needs `pages:deploy` on the Project, a Pages entitlement, and an enabled Pages profile. Authentication comes from the MCP connection: never pass a deploy token, API token, or `Authorization` value as an argument.

## Accepted artifacts

- **One HTML file.** Declare `format: "html"`, or omit `format` and let Opfield detect it (content that starts with markup after an optional BOM and whitespace). Opfield wraps it as `index.html` of a generated archive. Only that one file is served, so every stylesheet, script, and image must be inline, a data URI, or an absolute URL.
- **A `.tar.gz` archive** with `index.html` (or `index.htm`) at its root. Declare `format: "tar.gz"` or let Opfield detect the gzip magic bytes. Archives are validated: regular files and directories only (no links or special files), bounded file count and expanded size, no absolute or `..` paths.

Anything else fails with `PAGES_ARTIFACT_FORMAT_UNKNOWN`. A gzip body declared as `html` fails with `PAGES_ARTIFACT_NOT_HTML`.

## link

```json
{ "operation": "link", "projectId": "<Page Project UUID>", "tag": "weekly-report", "expiresInHours": 72 }
```

- Only `projectId` is required; `tag`, `format`, `expiresAt` or `expiresInHours`, and `source` work as for `begin`. An optional `sha256` makes Opfield reject bytes that do not match it.
- The result has `uploadUrl`, `expiresAt` (15 minutes ahead), `maxBytes` (the Opfield file-upload limit), and `commands` for an archive, a folder, and an HTML file:

```bash
curl -sS --fail-with-body -X PUT --data-binary @site.tar.gz '<uploadUrl>'
COPYFILE_DISABLE=1 tar czf - -C dist . | curl -sS --fail-with-body -X PUT --data-binary @- '<uploadUrl>'
```

- The link works once. Opfield measures and hashes the body, creates the Deployment, validates and publishes it, and the curl response is `{ "data": <the finalize result below> }`. An interrupted or rejected transfer creates nothing; an archive that fails validation leaves a failed Deployment with the reason. Either way, create a new link to retry.
- The URL is a credential for that one upload: run the command yourself and never show it to the user.

## begin

```json
{
  "operation": "begin",
  "projectId": "<Page Project UUID>",
  "declaredSizeBytes": 18234,
  "sha256": "<lowercase hex SHA-256 of the exact bytes you will send>",
  "format": "html",
  "idempotencyKey": "<stable key for this upload>",
  "tag": "weekly-report",
  "expiresInHours": 72,
  "source": { "repository": "...", "commitSha": "...", "ref": "..." }
}
```

- Only `projectId`, `declaredSizeBytes`, and `sha256` are required.
- `tag`: optional mutable Tag published after finalize. Lowercase DNS label, never `latest`, at most 50 characters for a Tag that does not exist yet.
- `expiresAt` (ISO 8601 with offset, 5 minutes to 1 year ahead) or `expiresInHours` (1 to 8760); both together fail with `PAGES_DEPLOYMENT_EXPIRY_AMBIGUOUS`.
- `source`: optional safe provenance (`provider`, `repository`, `commitSha`, `ref`, `mergeRequest`, `actor`). Never put credentials in it.
- `idempotencyKey`: repeating `begin` with the same key returns the same upload and its current offset, which makes a retry after a timeout safe. Reusing the key with a different Tag, size, or hash fails with `PAGES_IDEMPOTENCY_CONFLICT`.

The result is `{ deployment, upload: { id, offset, expiresAt } }`. An upload session expires 30 minutes after its last chunk; maintenance then fails it and frees its quota reservation.

`begin` can also fail on Project limits: `PAGES_ARTIFACT_TOO_LARGE` (the Opfield file-upload limit), `PAGES_STORAGE_QUOTA_EXCEEDED`, or `PAGES_RETENTION_PROTECTED_LIMIT` (pinned, tagged, or routed Deployments already fill `maxDeployments`). Report these; do not delete Deployments to make room without the user's approval.

## chunk

```json
{ "operation": "chunk", "uploadId": "<upload.id>", "offset": 0, "contentBase64": "<canonical base64>" }
```

- Chunks are ordered, non-empty, and at most 1 MiB decoded. The base64 must be canonical: no line breaks, correct padding.
- The result is `{ id, offset, complete }`, where `offset` is the next byte to send.
- An offset that does not match the bytes Opfield has received fails with `PAGES_UPLOAD_OFFSET_MISMATCH` and reports `expectedOffset`. Resume from that value; never restart from zero after an acknowledged chunk.

With the bundled helper, read each chunk as JSON and pass its `contentBase64` through:

```bash
python3 <skill-dir>/scripts/pages-artifact.py chunk <artifact> --offset <offset>
```

Its `nextOffset` must equal the `offset` Opfield returns.

## cancel

```json
{ "operation": "cancel", "uploadId": "<upload.id>" }
```

Stops an upload you have not finalized, removes the bytes received so far, and deletes its Deployment. Returns `{ cancelled: true, deployment }`. A finalized Deployment is removed with `manage_pages({ operation: "deployment_delete", projectId, deploymentId })` instead, which also cancels an upload still in progress (it needs `pages:deployments:manage`).

## finalize

```json
{ "operation": "finalize", "uploadId": "<upload.id>" }
```

Optionally pass `expiresInHours` or `expiresAt` here to override the value from `begin`; `expiresAt: null` clears it. Finalize validates the artifact, publishes the Deployment, moves the system `latest` Tag, publishes the requested Tag, and waits up to about 15 seconds for the preview links. It returns:

```json
{
  "deployment": { "id": "...", "status": "ready", "expiresAt": null },
  "links": {
    "preview": { "hostname": "...", "url": "https://...", "status": "ready", "reason": null },
    "tag": { "name": "weekly-report", "hostname": "...", "url": "https://...", "status": "pending", "reason": "publishing" },
    "latest": { "name": "latest", "hostname": "...", "url": "https://...", "status": "ready", "reason": null }
  }
}
```

`links.tag` is null when no Tag was requested; `links.latest` is null when `latest` does not point at this Deployment. Read the links of any Deployment later with `manage_pages({ operation: "deployment_links", projectId, deploymentId })`; `tag_list` includes each Tag's preview link.

## Link statuses

| Status | Meaning | Action |
| --- | --- | --- |
| `ready` | The host serves this content. | Verify and share. |
| `pending` (`publishing`, `not_ready`) | Publication is still in flight. `url` is already set and starts working when it finishes. | Re-read `deployment_links` or `tag_list`; do not call it published yet. |
| `unavailable` | No working link; `url` is null. | Report the `reason`. |

Common `unavailable` reasons:

- `previews_disabled`: previews are off for the Project (`project_update` `previewsEnabled`); `profile_disabled`: the Pages profile is disabled or has no wildcard certificate. Changing either is a separate, explicit request.
- `label_too_long`, `label_invalid`: the Tag name cannot form a preview hostname. Use a shorter DNS-label Tag.
- `access_unsupported`: the node cannot render the Project's Access List for previews; the Nginx daemon needs an update.
- `materialization_failed`, `deployment_unavailable`, `no_deployment`, `tag_missing`, `revoked`: the content is not being served; inspect the Deployment and Tag.

## Without the helper

When the bundled script is unavailable (for example, when this skill is read from `gateway://skills`):

- size: `wc -c < <file>`; SHA-256: `shasum -a 256 <file>` or `sha256sum <file>`;
- archive: `COPYFILE_DISABLE=1 tar -C <site-dir> -czf <out>.tar.gz .` keeps `index.html` at the root and, on macOS, skips AppleDouble files;
- chunks: base64 of each 1 MiB slice without line wrapping, for example `dd if=<file> bs=1048576 skip=<n> count=1 2>/dev/null | base64` on macOS, or `| base64 -w 0` with GNU coreutils.

## REST clients

CI systems and scripts that do not use MCP call the REST resumable deploy API with a Project deploy token instead; REST chunks may be up to 8 MiB. See [Projects, Tags, and Git builds](projects-and-git-builds.md#deploy-tokens-for-ci) for token handling.
