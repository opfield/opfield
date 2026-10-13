# Opfield MCP connection

Use this reference only when Opfield remote MCP is missing, unauthenticated, or connected to the wrong instance. If Opfield itself is not installed, still requires first-run setup, or has no Node suitable for the workload, read [New instance setup](instance-setup.md) first.

## Endpoint

Opfield exposes one Streamable HTTP MCP endpoint:

```text
https://<opfield-host>/api/mcp
```

Normalize a base URL by removing a trailing slash before adding `/api/mcp`. Prefer HTTPS. Do not infer a production hostname from a repository name, email domain, or previous task.

## Administrator prerequisites

An administrator enables MCP once, in Opfield settings under **OAuth and MCP access**:

1. Turn on **Enable MCP server**.
2. Keep **Extended MCP compatibility** on for ordinary clients; every scoped tool is then listed up front. Turn it off only for clients whose context cannot hold the full catalog; those clients activate toolsets with `discover_tools` (see [MCP toolsets](mcp-toolsets.md)).
3. Give the connecting user `mcp:use` plus the resource scopes the agent may use.

## Codex

Inspect existing configuration first:

```bash
codex mcp list
codex mcp get opfield
```

If no Opfield server exists:

```bash
codex mcp add opfield --url https://opfield.example.com/api/mcp
codex mcp login opfield
codex mcp list
```

An existing configuration may use another name. If it points elsewhere, report the mismatch before replacing it. Use a distinct name such as `opfield-staging` when the user needs several installations.

## Claude Code

```bash
claude mcp add --transport http opfield --scope user https://opfield.example.com/api/mcp
claude mcp login opfield
claude mcp get opfield
```

Use project scope only when the repository should share the server definition; every developer still signs in with their own Opfield account.

## Authentication and scopes

Opfield uses OAuth Authorization Code with PKCE and dynamic client registration. Let the user complete browser login and consent. Never ask them to paste the resulting token.

During consent the user can narrow the grant: **Restrict...** per scope, or **Limit selected scopes to folder...** for one folder across every selected scope of that resource type. High-risk scopes need explicit approval and start unticked, for example `admin:*`, `settings:opfield:edit`, `nodes:manage`, `nodes:console`, `nodes:files:*`, Docker console, file, export, secret, mount, and migrate scopes, `proxy:raw:write`, `proxy:unrestricted`, `ssl:cert:issue`, `pki:ca:export`, `storage:credentials:reveal`, `storage:iam`, `storage:bind`, `databases:query:*`, `databases:credentials:reveal`, `databases:backups:restore`, and connector `:use` or `:repo:write` scopes. Never assume one was granted; call the tool and read the 403.

A grant is bounded by the user's **current** permissions. Narrowing the user's group or removing `mcp:use` takes effect immediately, even mid-session. Scope shapes and restrictions are explained in the `access-control` skill.

## Token types

| Prefix | Credential | Accepted by |
| --- | --- | --- |
| `opfo_` | OAuth access token bound to one resource | MCP only when issued for the MCP resource; REST when issued for the Opfield API |
| `opf_` | API token | REST only |
| `opfl_` | Logging ingest token | Log ingestion only |
| `opfi_` | Opfield Inference token | Inference data plane only |

Opfield MCP accepts only `opfo_` tokens issued for the MCP resource. `opf_`, `opfl_`, and `opfi_` tokens, browser cookies, and OAuth tokens for another resource are rejected there. If a tool is absent, distinguish an undiscovered toolset from a missing scope, entitlement, disabled MCP server, unavailable subsystem, or incompatible client.

## Verify the connection

After setup, refresh MCP tools or start a new session if the host cannot hot-load the connection. Then run a read-only smoke test before any change:

1. list Nodes or resources the connection can see;
2. confirm that one action the user should not have is denied;
3. when the user has audit access, confirm the audit log attributes the calls to them and their OAuth client.

Do not create a plugin-owned proxy or store credentials in the skill directory. Connection troubleshooting: [API and MCP](https://docs.opfield.dev/en/integrations/api-and-mcp/#mcp-connection-troubleshooting).
