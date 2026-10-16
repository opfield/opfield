-- Built-in alert rules for disk space: "Node disk almost full" (category node, metric disk on the root mount "/", 85%
-- or more on any node) and "Opfield disk almost full" (category opfield, metric host_disk, the Opfield host's data disk
-- at 85% or more). A node whose disk filled with old build images alerted nothing before. They notify the enabled
-- webhooks the enabled node and Opfield rules notify now, so an install that alerts gets them without setup; a fresh
-- install has none to copy and the operator picks them. Created once each: an install that already has a disk rule of
-- that category keeps its own.
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "metric", "metric_target", "operator", "threshold_value",
  "duration_seconds", "fire_threshold_percent", "resolve_after_seconds", "resolve_threshold_percent", "resource_ids",
  "message_template", "webhook_ids", "cooldown_seconds", "is_builtin"
)
SELECT
  'Node disk almost full', true, 'threshold', 'warning', 'node', 'disk', '/', '>=', 85, 0, 100, 60, 100,
  '[]'::jsonb,
  'The root disk of node {{node.name}} is {{metric.value}}% full. Free space before workloads fail: remove old images (Housekeeping, Docker Images), unused volumes or logs, or grow the disk.',
  coalesce(
    (
      SELECT jsonb_agg(DISTINCT "w"."id"::text)
      FROM "notification_alert_rules" AS "r"
      CROSS JOIN LATERAL jsonb_array_elements_text("r"."webhook_ids") AS "rw"("id")
      JOIN "notification_webhooks" AS "w" ON "w"."id"::text = "rw"."id" AND "w"."enabled"
      WHERE "r"."enabled" AND "r"."category" IN ('node', 'opfield')
    ),
    '[]'::jsonb
  ),
  3600, true
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules" WHERE "category" = 'node' AND "metric" = 'disk'
);
--> statement-breakpoint
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "metric", "operator", "threshold_value",
  "duration_seconds", "fire_threshold_percent", "resolve_after_seconds", "resolve_threshold_percent", "resource_ids",
  "message_template", "webhook_ids", "cooldown_seconds", "is_builtin"
)
SELECT
  'Opfield disk almost full', true, 'threshold', 'warning', 'opfield', 'host_disk', '>=', 85, 300, 100, 60, 100,
  '[]'::jsonb,
  'The data disk of the Opfield host is {{metric.value}}% full. Free space before Opfield stops: run Housekeeping, remove old images or logs, or grow the disk.',
  coalesce(
    (
      SELECT jsonb_agg(DISTINCT "w"."id"::text)
      FROM "notification_alert_rules" AS "r"
      CROSS JOIN LATERAL jsonb_array_elements_text("r"."webhook_ids") AS "rw"("id")
      JOIN "notification_webhooks" AS "w" ON "w"."id"::text = "rw"."id" AND "w"."enabled"
      WHERE "r"."enabled" AND "r"."category" IN ('node', 'opfield')
    ),
    '[]'::jsonb
  ),
  3600, true
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules" WHERE "category" = 'opfield' AND "metric" = 'host_disk'
);
