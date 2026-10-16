-- A finished build no longer says its rollout is still running: `progress.rollout.phase` of a succeeded, failed,
-- cancelled or superseded build becomes "finished" (earlier releases left "accepted" or "executing" behind).
UPDATE "docker_builds"
SET "progress" = jsonb_set("progress", '{rollout,phase}', '"finished"'::jsonb)
WHERE "status" IN ('succeeded', 'failed', 'cancelled', 'superseded')
  AND jsonb_typeof("progress" -> 'rollout') = 'object'
  AND "progress" -> 'rollout' ->> 'phase' IN ('accepted', 'executing');
