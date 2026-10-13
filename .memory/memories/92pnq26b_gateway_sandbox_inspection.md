---
{
  "id": "92pnq26b",
  "file_name": "92pnq26b_gateway_sandbox_inspection",
  "tags": [
    "ai-tools",
    "clone",
    "gitlab",
    "opfield",
    "production-readiness",
    "sandbox",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1783530886860,
  "updated_at": 1791851321025
}
---
Opfield AI sandbox clone inspection contract, from the 2026-07-08/09 audit (re-check the current sandbox runner before relying on the implementation details):

- `gitlab_clone_repository_to_sandbox` downloads a GitLab archive through Opfield into a no-network sandbox and extracts it under /workspace. After CLONE_READY (read via read_process_output), inspect it with `list_artifact_files`, `read_artifact` and hand it off with `send_artifact` on the returned processId, without launching a second sandbox process. These tools are AI-only and excluded from MCP (still true on 2026-10-01).
- As audited in July: the clone process ran a fixed extract-then-sleep command, `write_process_stdin` is not an exec API, every `run_process` creates a fresh workspace, and the archive has no .git metadata. So the clone supports read-only inspection only and must not be documented or planned as supporting edits, tests, builds, git diff, or multi-file tooling.
- A production-grade editable clone needs a durable workspace/session identity with bounded exec and write/patch primitives plus explicit git or archive-to-patch semantics.
- The audit also found `workspaceBytes` passed through policy but not enforced on the host bind mount; quota and expanded-archive limits must be verified with Linux Docker tests.
