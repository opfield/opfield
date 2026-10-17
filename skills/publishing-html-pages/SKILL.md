---
name: publishing-html-pages
description: Build an HTML report, static site, or frontend output and publish it to Opfield Pages, then hand the user a working link. Use when asked to publish, host, preview, put online, or share a link to generated HTML or static files through Opfield, including single-file uploads, stable Tag links, expiring links, access-list-protected previews, preview-link rotation, rollback, custom domains, and Git-backed Pages builds. Use after using-opfield has confirmed the Opfield MCP connection.
---

# Publishing HTML Pages

Opfield Pages serves static output as **Page Projects** that hold immutable **Deployments** and mutable **Tags**. Every upload creates a new Deployment with its own immutable preview link. A Tag is a named pointer with a stable preview link that follows it to later Deployments. Custom-domain Routes target Tags, never Deployments.

Pages serves browser-delivered static output only. An API process, worker, or server-side state belongs in a Docker workload (`deploying-workloads`) behind a Route (`ingress-and-domains`).

Start with `using-opfield` for connection, discovery, and safety rules. Before an unfamiliar Pages workflow, read `read_opfield_documentation({ topic: "pages" })`; it reflects the connected release.

## Recipe: build, upload, share

1. **Resolve the Project.** Use `find_resource({ types: ["page_project"], query })` or `manage_pages({ operation: "project_list" })` and reuse the Project that already represents this site or report stream. Create one only when none fits: check `profile_get` (Pages licensed and enabled), pick a node from `project_placement_options`, then `project_create({ name, nodeId, folderId? })`.
2. **Build the output** with the repository's own tooling, or write the report.
   - One self-contained HTML file (inline CSS and JS, images as data URIs or absolute URLs): upload it as is with `format: "html"`. Opfield stores it as `index.html`.
   - Several files: a build folder (for example `dist/`) with `index.html` at its root, or a `.tar.gz` of one.

   The bundled helper gives exact values: `python3 <skill-dir>/scripts/pages-artifact.py inspect report.html` returns size, SHA-256, detected format, and `localReferences` that a single-file upload would break (pack a directory when that list is not empty). `pages-artifact.py prepare ./dist --output <tmp>/site.tar.gz` packs a directory deterministically and refuses one without `index.html`.
3. **Decide the link before uploading:** Tag or not, expiry or not, Access List or not (sections below). The Tag and expiry are upload arguments; attach an Access List to the Project first, so the new link is never public.
4. **Upload** with the MCP-only `upload_pages_artifact`. Send only the fields the operation uses and leave every other optional field out: `""`, `0` or an empty `source` object fails validation. With a shell, call `link` with `projectId` and the optional `tag`, `format`, `expiresInHours` or `expiresAt`, and `source`, then run one of the returned `commands` right away: `archive` or `html` sends a file with `curl --data-binary @<file>`, `folder` packs and streams a build folder (`tar czf - -C dist . | curl --data-binary @- <url>`). The link works once, for 15 minutes; its curl response is the finalize result, and a failed or interrupted transfer leaves nothing behind. Without a shell, `begin` takes `projectId`, `declaredSizeBytes`, `sha256`, `format`, an `idempotencyKey`, and the same options; keep the returned `upload.id`, send `chunk` calls in order, at most 1 MiB decoded each, continuing from the `offset` each chunk returns, then call `finalize` with the `uploadId`, or `cancel` to abandon it. `begin` takes no content, and its Deployment (status `uploading`) serves nothing until `finalize` returns status `ready`; there is no separate activate or publish step. A complete minimal example, exact arguments, errors, and a fallback without the helper are in [Upload protocol](references/upload-protocol.md).
5. **Read the links.** The finalize result is `{ deployment, links }`. `links.preview` is the immutable Deployment link, `links.tag` the requested Tag (null without one), and `links.latest` the system `latest` Tag when it now points at this Deployment. Each link has `url`, `status` (`ready`, `pending`, or `unavailable`), and `reason`. Share a `ready` URL. For `pending`, re-read with `manage_pages({ operation: "deployment_links", projectId, deploymentId })` or `tag_list`. For `unavailable`, report the reason; see [link statuses](references/upload-protocol.md#link-statuses).
6. **Verify** by requesting the URL yourself: HTTP 200 and recognizable content. Behind an Access List, a 401 or 403 is the expected proof that protection applies; say that the content itself was not fetched.
7. **Tell the user** what they received (template below).

## Choose the link

| The user needs | Share | Say |
| --- | --- | --- |
| This exact version: a one-off report, review evidence, anything that must not change | `links.preview` | "This link always shows exactly this version. A new upload gets a new link." |
| One URL to bookmark or embed that shows the current version | `links.tag` from a named Tag set at `link` or `begin` | "The link stays the same. Each upload with Tag `<tag>` replaces what it shows, and a rollback moves it back." |

- Tag names are lowercase DNS labels (`a-z`, `0-9`, inner `-`), never `latest`, and at most 50 characters for a new Tag, so the host `<projectHash>-<tag>.<Pages wildcard domain>` fits one DNS label. Use the URL Opfield returns; never assemble a preview hostname yourself.
- Prefer a dedicated Tag to the `latest` link. `latest` follows every successful upload to the Project, whatever it contains.
- An immutable link lives as long as its Deployment. Retention removes old unprotected Deployments beyond the Project's `maxDeployments` (20 by default) or storage quota; a Tag, a Route, or a pin protects one. When an immutable link must outlive later uploads, pin it with `manage_pages({ operation: "deployment_pin", projectId, deploymentId, pinned: true })`.

## Expiry

Set an expiry only when the user wants the link to stop working: a review window, a temporary demo, time-boxed data. Pass `expiresInHours` (1 to 8760) or `expiresAt` (ISO 8601 with offset, 5 minutes to 1 year ahead), never both, at `link`, `begin` or `finalize`. A value at `finalize` overrides the one from `begin`, and `expiresAt: null` there clears it.

After the expiry, maintenance deletes the Deployment with its previews and files and clears every Tag still pointing at it, so that Tag's link is unavailable until the next upload to it. A pinned Deployment, or one a custom-domain Route still serves, is not expired. Report the exact expiry time; pinning is the only way to keep the Deployment after finalize.

## Protect previews

Previews are public: anyone who has the link can open it. The hostnames are random, not guessable, but they are not credentials. To restrict access, attach an Access List to the Project **before** uploading: `manage_pages({ operation: "project_update", projectId, accessListId })`. It needs `pages:edit` and `acl:view` on the list, and the Project's Nginx node must support preview access lists (otherwise `PAGES_DAEMON_UPDATE_REQUIRED`: the daemon needs an update).

- The list protects every preview of the Project, Deployment and Tag links alike, with its IP rules and basic authentication. `accessListId: null` removes it. A list without rules or users leaves previews public.
- It is Project-wide, so keep protected content in its own Project instead of protecting an unrelated one.
- Never invent, request, or relay basic-auth passwords in chat. Attach an existing list, create one with IP rules only, or let the user add basic-auth users to the list in the Opfield Console and then attach it by ID. Access List tools are in `ingress-and-domains`.

## Revoke, replace, roll back

- **A leaked or over-shared link:** `manage_pages({ operation: "project_rotate_preview_hash", projectId })` gives the Project a new preview hash and new Deployment slugs, revokes every old preview link at once, and republishes new ones. Every link already shared stops working, including Tag links, so confirm first. Afterwards read the new links with `deployment_links` or `tag_list` and share only the intended ones. Custom-domain Routes are unaffected.
- **One Deployment:** `deployment_delete` (needs `pages:deployments:manage`). Opfield refuses it with `PAGE_DEPLOYMENT_PROTECTED` while the Deployment is pinned or still serves a named Tag or Route; move or unpin those first, and only with the user's approval.
- **Roll back a Tag:** `tag_move({ projectId, tag, deploymentId })` to an earlier ready Deployment.

## What to tell the user

- the URL and its kind: a fixed version, or a stable Tag link that follows future uploads;
- who can open it: anyone with the link, or only clients allowed by Access List `<name>`;
- the expiry time, when one is set;
- how to update it (upload again with the same Tag) and how to revoke it (rotation, deletion, expiry);
- the verification result: fetched with HTTP 200, protected (401 or 403 as expected), or still `pending` with the reason.

Never include tokens, base64 payloads, or Access List passwords.

## Beyond a quick link

Git-backed builds, custom domains, Tag operations, runtime configuration, deploy tokens, retention, and Project settings: [Projects, Tags, and Git builds](references/projects-and-git-builds.md).

## Pitfalls

- The Tag is an argument of `link` or `begin`, not `finalize`. A new Tag longer than 50 characters is rejected there, before anything is uploaded; existing longer Tags keep working.
- `declaredSizeBytes` and `sha256` describe the exact bytes you send: the HTML file itself for `format: "html"`, the archive otherwise, every byte including a final newline. When the user gives a size and SHA-256, they decide which bytes are right.
- `deployment.artifactSha256` in the finalize result is the hash of the stored archive (an HTML file is packed into one), so it differs from the `sha256` you declared. That is expected; never delete or re-upload a ready Deployment because of it.
- Optional arguments you do not use are left out, not sent empty: `tag: ""`, `expiresAt: ""`, `expiresInHours: 0`, `folderId: ""` all fail validation. Leave out both expiry fields for a link that does not expire, and leave out `tag` unless you want a stable Tag link (`latest` is reserved and moves by itself).
- The preview URL is `links.preview.url` from the finalize result (or `deployment_links`), never a hostname you assemble from a node address or hash.
- With `begin`/`chunk`, every uploaded byte passes through your context as base64, which fails for anything but small files. Use `link` whenever you have a shell; the upload link is a one-time credential, so do not repeat it to the user.
- Deployments are immutable. To change a page, upload again; never expect an old Deployment link to show new content.
- Runtime configuration (`window.runtime.config`) and frontend build variables are public browser data. Never put secrets in them.
