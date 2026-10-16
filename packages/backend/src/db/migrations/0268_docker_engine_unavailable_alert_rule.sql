-- Built-in alert rule "Docker runtime unavailable" (category node, metric docker_engine_unavailable): a Docker node
-- whose engine cannot start containers (dockerd or its containerd does not answer) alerts out of the box. Its running
-- containers keep running, so the node looked online while every new start, deploy, restart and build failed (a
-- containerd crash-looping for a day raised nothing). Docker daemons of 2.12.3 and later report it. It notifies the
-- enabled webhooks the enabled node rules notify now; a fresh install has none to copy and the operator picks them.
-- Created once: an install that already has such a rule keeps its own.
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "metric", "operator", "threshold_value",
  "duration_seconds", "fire_threshold_percent", "resolve_after_seconds", "resolve_threshold_percent", "resource_ids",
  "message_template", "webhook_ids", "cooldown_seconds", "is_builtin"
)
SELECT
  'Docker runtime unavailable', true, 'threshold', 'critical', 'node', 'docker_engine_unavailable', '>=', 1,
  120, 100, 60, 100,
  '[]'::jsonb,
  'Docker on node {{node.name}} cannot start containers: {{details.problem}}. Running containers keep running, but new containers, deploys, restarts and builds there fail. Check the Docker Engine on the node (restart containerd or dockerd and read its log).',
  coalesce(
    (
      SELECT jsonb_agg(DISTINCT "w"."id"::text)
      FROM "notification_alert_rules" AS "r"
      CROSS JOIN LATERAL jsonb_array_elements_text("r"."webhook_ids") AS "rw"("id")
      JOIN "notification_webhooks" AS "w" ON "w"."id"::text = "rw"."id" AND "w"."enabled"
      WHERE "r"."enabled" AND "r"."category" = 'node'
    ),
    '[]'::jsonb
  ),
  3600, true
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules" WHERE "category" = 'node' AND "metric" = 'docker_engine_unavailable'
);
