---
{
  "id": "nuc3c3hq",
  "file_name": "nuc3c3hq_gateway_sandbox_artifact",
  "tags": [
    "artifacts",
    "opfield",
    "sandbox-runner",
    "security",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1783275561542,
  "updated_at": 1791851801883
}
---
In the Opfield repository, sandbox artifact read/write/download paths must avoid path-based open/write/chown after validation because the shared workspace can be raced with symlinks. The hardened pattern is fd-relative traversal from the trusted workspace root through /proc/self/fd, opening parent directories with O_DIRECTORY | O_NOFOLLOW and final artifact files with O_NOFOLLOW. If secure fd-relative artifact open is unavailable, artifact I/O should fail closed rather than falling back to path-based file access. Verification sequence used: `rtk corepack pnpm --filter backend lint`, `rtk corepack pnpm --filter backend typecheck`, `rtk corepack pnpm --filter backend test -- src/sandbox-runner/artifact-path.test.ts src/sandbox-runner/network.test.ts`, and `rtk git diff --check`.
