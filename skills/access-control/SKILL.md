---
name: access-control
description: Administer Opfield identity and access, including users, permission groups, scopes, folder, node, and resource restrictions, API tokens, OAuth and MCP grants, and impersonation limits. Use when asked to create, block, or delete a user, change someone's permissions, design a least-privilege scope set for an integration or agent, or explain what a token or OAuth grant can and cannot do. Use after using-opfield has confirmed the Opfield MCP connection.
---

# Access Control

Start with `using-opfield` for connection, discovery, and safety rules; its connection reference explains how scopes bound an MCP session. Read `read_opfield_documentation({ topic: "permissions" })` (also `users`, `authentication`) before changing access, and check a specific scope in the [Scopes reference](https://docs.opfield.dev/en/identity/scopes-reference/) instead of guessing its name.

## Users and groups

Every user belongs to exactly one permission group. Built-in groups (`system-admin`, `admin`, `operator`, `viewer`, `guest`) cannot be modified. Custom groups hold any scope combination and nest one level: a top-level group can be a parent, a nested group cannot have children, and inherited scopes add to the member's effective scopes.

- `list_users`, `manage_user` for general administration.
- `manage_user` `send_invitation` emails a new user the one-time account invitation; it works only before their first sign-in and needs verified SMTP and the Opfield public URL. `list_users` shows `lastLoginAt` and `invitationSentAt`. The Opfield setting `generalSettings.sendInvitationOnUserCreate` (off by default) sends it on every `create_user`; if that send fails, the user is still created with `invitationSentAt: null`.
- `update_user_role(userId, groupId)` changes effective permissions immediately.
- `set_user_additional_permissions(userId, additionalScopes)` **replaces** the user's extra scopes; `[]` resets them without touching the group. Read the current `additionalScopes` first when adding one, and grant only scopes the acting administrator holds.
- `set_user_blocked` blocks or unblocks.
- `delete_user` is a soft delete: access and tokens are revoked immediately and the user disappears from operational lists, but audit and usage history remain. Only a system administrator can restore a user, and a restored user stays blocked until unblocked. Do not tell anyone the account is "gone".
- `list_groups`, `create_group`, `update_group`, `delete_group` need `admin:groups`.

Authentication itself (OIDC, passwords, email one-time codes, passkeys, MFA, a user's sessions) is browser-bound; see `read_opfield_documentation({ topic: "authentication" })`.

## How scopes apply

A scope is `domain:resource:action[:qualifier]`:

- **Broad** (`proxy:view`): every resource of that type.
- **Resource-scoped** (`proxy:view:<hostId>`): exactly that resource.
- **Folder or Node restricted** (`<scope>:folder/<folderId>`, `<scope>:node/<nodeId>`): the folder or Node, its subfolders, and everything placed there now or later.

A folder grant covers the folder's subfolders, and an agent holding only folder or Node grants works inside them: lists return that subset (an empty list is not a denial), `list_resource_folders` shows every folder it holds any grant on with `access.actions` and `access.canCreate`, and creation needs `folderId` (and `nodeId` where the tool takes one) because a create without a destination targets the root.

Each scope family has one view scope that its action scopes imply (`proxy:edit` satisfies `proxy:view`). Creation scopes are the exception: `*:create*` names a destination and implies no view, so `proxy:create:folder/F` does not list what is in `F`. Folder-tree scopes (`*:folders:manage`) grant folder visibility and changes, not item visibility; moving an item still needs the item's own edit or manage scope. Scopes that look symmetric often are not; check the reference.

## Check what a principal can reach

If you can't see or do something at the root, check `get_my_access`; folder-limited access is normal, so work inside the granted folders. It (also `opfield://access` over MCP, and `GET /api/auth/me/access` for a REST token) groups the calling principal's access by area: whether it is broad, which folders (id, name, path), Nodes, accounts and resources are granted with which actions, and where it may create (`create.atRoot`, `create.folders`, `create.nodes`). A token or OAuth grant is reported as bounded by its owner (`principal: { credential, boundedByOwner: true }`) and carries no owner identity; only browser sessions and the in-product assistant also get the user's id, name, email and group. When the connection is limited, MCP also adds a short version of this summary to its server instructions at connect time.

Use it before reporting a permission problem: a denial at the root, or a refusal that names folders or Nodes, means the access is limited, not missing. Only when it shows no grant for the action anywhere is the user missing a scope; then name the exact scope and restriction to ask an administrator for.

## Restrict access

- A group's restriction is set when its scopes are assigned.
- An API token gets a folder, Node, or resource picker per restrictable scope, limited to what its creator can reach.
- An OAuth or MCP grant shows **All resources / Restrict...** for a broadly held scope and **No resources selected** for a partially held one; **Limit selected scopes to folder...** applies one folder to every selected scope of that folder's resource type.

A token or grant's own restriction is applied first and then bounded by the owner's **current** access. Narrowing a user's group immediately narrows every token and grant they issued, even mid-session.

## Tokens, grants, and what MCP cannot do

- `manage_api_token` and `manage_oauth_authorization` are browser-session tools for the current user's own tokens and grants, and are **not exposed over MCP**. An MCP agent cannot mint an API token or approve an OAuth client. When a user asks for a token, send them to the Console; do not look for a workaround.
- API tokens and OAuth grants can hold every scope a user can, except user-account-only scopes: `ai:workspace:use`, `feat:ai:configure`, `ai:skills:manage`, `ai:sandbox:*`, `mcp:use`, `admin:users:impersonate`, and `integrations:gitlab:sandbox:clone`.
- Retired scope names from before 2.11 are still accepted for two releases and rewritten to their replacements; see [retired scope names](https://docs.opfield.dev/en/identity/scopes-reference/#retired-scope-names) before trusting a name from older examples.

## Impersonation

`admin:users:impersonate` cannot be delegated to any token or grant: impersonation replaces the caller's browser session and is identity-bound. An MCP agent can never impersonate a user. Credential-revealing tools (database and storage credential reveal, license clearing, and others) refuse to run during impersonation, even for a human operator.

## Least privilege for an agent or integration

Grant `mcp:use` to the user account, then only the resource scopes the job needs, restricted to a folder, Node, or resource where possible. Leave manual-approval scopes (console, file access, raw nginx, credential reveal, restores, `admin:*`) unticked unless the task needs them. Prefer a dedicated group for automation users over broad additional permissions.

## Verify

After a group or permission change, have the affected identity attempt one action that should now be allowed and one that should be denied, and confirm both. After creating a restricted grant, confirm a resource outside the restriction is genuinely invisible, not merely unlisted in one view.

Scopes for this area: `admin:users`, `admin:users:folders:manage`, `admin:groups`, `admin:groups:folders:manage`, `admin:users:impersonate` (browser-only, non-delegable), and the account-level `mcp:use`. `admin:users` and `admin:groups` are OAuth manual-approval scopes. Further reading: [Users and groups](https://docs.opfield.dev/en/identity/auth-users-groups/), [Tokens and OAuth](https://docs.opfield.dev/en/identity/scopes-tokens-oauth/), [Permissions](https://docs.opfield.dev/en/concepts/permissions/).
