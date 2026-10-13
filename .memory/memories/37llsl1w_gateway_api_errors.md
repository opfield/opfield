---
{
  "id": "37llsl1w",
  "file_name": "37llsl1w_gateway_api_errors",
  "tags": [
    "api",
    "backend",
    "docker",
    "frontend",
    "opfield"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.86,
  "created_at": 1781735767839,
  "updated_at": 1791852045071
}
---
Root cause: Some backend routes return legacy error bodies as { error: string } instead of the standard { code, message }. This caused UI to surface blank toasts during failures (e.g., Docker image pull-sync on container deploy) because ApiClientBase only reads the message field. Fix pattern: Normalize routes toward AppError / { code, message }. Make ApiClientBase resilient by falling back to the error field when message is missing or blank. Normalize Docker daemon dispatch failures by preferring a non-empty error, then detail, then a fallback message, so empty daemon responses never surface as blank UI errors. Verification steps: reproduce with invalid image refs and empty daemon responses; confirm UI shows a meaningful error; confirm ApiClientBase gracefully handles missing message; regression tests for both paths. Gotchas: ensure new error shapes are backward compatible with existing clients; update any client parsing logic and tests to prefer { code, message } while maintaining fallback paths. Durable outcomes: consistent error schemas across routes, resilient client parsing, and clear user-facing error messages during deploy failures.
