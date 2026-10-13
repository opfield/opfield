---
{
  "id": "pz22sp0a",
  "file_name": "pz22sp0a_gateway_test_policy",
  "tags": [
    "ci",
    "light-suite",
    "policy",
    "testing",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1790812345137,
  "updated_at": 1791851844034
}
---
Opfield test policy since commit 49c72381 ("test: cut the suites down to the light suite", 2026-09-29), decided by the repository owner:

- `pnpm test` runs only the light suite (`test:light:backend`, `test:light:packages`, `test:light:go`), about 205 test files and roughly 30 s. Main CI runs it; RC release jobs only build.
- Keep-criteria for tests: authorization, authentication and credentials, update trust and licensing, data integrity and migrations, untrusted input at the edge, daemon lease/fencing and relay trust. Tests of UI shape, copy, call order or mocks are not kept or re-added.
- Frontend UI conventions are one static check, `pnpm --filter frontend lint:ui-rules`, run by the frontend lint.
- While implementing, run compile checks (`tsc --noEmit`, `go build`/`go vet` for touched packages) and targeted existing tests only; one full `pnpm test` plus typecheck right before pushing to main. Cross-system behaviour belongs in stand end-to-end runs (a heavy pre-stable E2E suite was planned but not built as of 2026-09-29).
- Many older project memories cite specific test files or "verification sequences" (for example `ai.tools.characterization.test.ts`, `notification-evaluator.service.test.ts`, `api.test.ts`, `managed_relay_dial_lock_test.go`). Most of those files were deleted by the cut. Treat such references as history: check `git ls-files` before running them, and do not recreate deleted tests unless they meet the keep-criteria.
- The gateway-commercial repository got the same cut.
