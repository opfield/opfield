-- Disk alerts for every data disk. The built-in "Node disk almost full" (0258) watched only the root mount "/", so a
-- Docker data root, the managed storage root or any data disk on a mount of its own filled with no alert. While it is
-- still the unedited built-in (name, operator, threshold and target as 0258 created them), it now watches every data
-- disk of the node ('@data': each mount except Opfield's own disk images, each disk alerting on its own), and its
-- unedited message names the disk. An edited rule keeps what its owner chose.
UPDATE "notification_alert_rules"
SET "message_template" = 'Disk {{details.mount}} of node {{node.name}} is {{round metric.value 1}}% full. Free space before workloads fail: remove old images (Housekeeping, Docker Images), unused volumes or logs, or grow the disk.',
  "updated_at" = now()
WHERE "is_builtin" AND "type" = 'threshold' AND "category" = 'node' AND "metric" = 'disk' AND "metric_target" = '/'
  AND "name" = 'Node disk almost full' AND "operator" = '>=' AND "threshold_value" = 85
  AND "message_template" = 'The root disk of node {{node.name}} is {{metric.value}}% full. Free space before workloads fail: remove old images (Housekeeping, Docker Images), unused volumes or logs, or grow the disk.';
--> statement-breakpoint
UPDATE "notification_alert_rules"
SET "metric_target" = '@data', "updated_at" = now()
WHERE "is_builtin" AND "type" = 'threshold' AND "category" = 'node' AND "metric" = 'disk' AND "metric_target" = '/'
  AND "name" = 'Node disk almost full' AND "operator" = '>=' AND "threshold_value" = 85;
--> statement-breakpoint
-- More built-in rules, created once each: an install that already has a rule of that kind keeps its own. They notify
-- the enabled webhooks the enabled node, Opfield, database and storage rules notify; a fresh install has none to copy
-- and the operator picks them in Notifications > Alerts.
-- A data disk of a node at 95% or more: critical, beside the warning at 85%.
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "metric", "metric_target", "operator", "threshold_value",
  "duration_seconds", "fire_threshold_percent", "resolve_after_seconds", "resolve_threshold_percent", "resource_ids",
  "message_template", "webhook_ids", "cooldown_seconds", "is_builtin"
)
SELECT
  'Node disk full', true, 'threshold', 'critical', 'node', 'disk', '@data', '>=', 95, 0, 100, 60, 100,
  '[]'::jsonb,
  'Disk {{details.mount}} of node {{node.name}} is {{round metric.value 1}}% full and about to run out of space. Free space now: remove old images (Housekeeping, Docker Images), unused volumes or logs, or grow the disk.',
  coalesce(
    (
      SELECT jsonb_agg(DISTINCT "w"."id"::text)
      FROM "notification_alert_rules" AS "r"
      CROSS JOIN LATERAL jsonb_array_elements_text("r"."webhook_ids") AS "rw"("id")
      JOIN "notification_webhooks" AS "w" ON "w"."id"::text = "rw"."id" AND "w"."enabled"
      WHERE "r"."enabled"
        AND "r"."category" IN ('node', 'opfield', 'database_postgres', 'database_redis', 'database_clickhouse', 'managed_storage')
    ),
    '[]'::jsonb
  ),
  3600, true
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules" WHERE "category" = 'node' AND "metric" = 'disk' AND "severity" = 'critical'
);
--> statement-breakpoint
-- The disk of managed databases and storage on a node is promised more than it holds: its instances fill it before
-- they reach their sizes, and new instances and disk grows there are refused.
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "metric", "operator", "threshold_value",
  "duration_seconds", "fire_threshold_percent", "resolve_after_seconds", "resolve_threshold_percent", "resource_ids",
  "message_template", "webhook_ids", "cooldown_seconds", "is_builtin"
)
SELECT
  'Node disk oversubscribed', true, 'threshold', 'warning', 'node', 'managed_disk_promised_pct', '>', 100, 300, 100, 300, 100,
  '[]'::jsonb,
  'The disk for managed databases and storage on node {{node.name}} is promised {{round metric.value 1}}% of its size: its instances fill it before they reach their sizes, and new instances and disk grows there are refused. Free space on that disk, grow it, or move or shrink instances.',
  coalesce(
    (
      SELECT jsonb_agg(DISTINCT "w"."id"::text)
      FROM "notification_alert_rules" AS "r"
      CROSS JOIN LATERAL jsonb_array_elements_text("r"."webhook_ids") AS "rw"("id")
      JOIN "notification_webhooks" AS "w" ON "w"."id"::text = "rw"."id" AND "w"."enabled"
      WHERE "r"."enabled"
        AND "r"."category" IN ('node', 'opfield', 'database_postgres', 'database_redis', 'database_clickhouse', 'managed_storage')
    ),
    '[]'::jsonb
  ),
  3600, true
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules" WHERE "category" = 'node' AND "metric" = 'managed_disk_promised_pct'
);
--> statement-breakpoint
-- The data disk of a managed Postgres or key-value store, and the disk of a ClickHouse, at 85% or more.
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "metric", "operator", "threshold_value",
  "duration_seconds", "fire_threshold_percent", "resolve_after_seconds", "resolve_threshold_percent", "resource_ids",
  "message_template", "webhook_ids", "cooldown_seconds", "is_builtin"
)
SELECT
  "seed"."name", true, 'threshold', 'warning', "seed"."category", "seed"."metric", '>=', 85, 300, 100, 300, 100,
  '[]'::jsonb, "seed"."message", coalesce(
    (
      SELECT jsonb_agg(DISTINCT "w"."id"::text)
      FROM "notification_alert_rules" AS "r"
      CROSS JOIN LATERAL jsonb_array_elements_text("r"."webhook_ids") AS "rw"("id")
      JOIN "notification_webhooks" AS "w" ON "w"."id"::text = "rw"."id" AND "w"."enabled"
      WHERE "r"."enabled"
        AND "r"."category" IN ('node', 'opfield', 'database_postgres', 'database_redis', 'database_clickhouse', 'managed_storage')
    ),
    '[]'::jsonb
  ), 3600, true
FROM (
  VALUES
    (
      'Postgres disk almost full', 'database_postgres', 'managed_disk_pct',
      'The data disk of Postgres {{resource.name}} is {{round metric.value 1}}% full. Grow its disk or delete data before it stops taking writes.'
    ),
    (
      'Key-value store disk almost full', 'database_redis', 'managed_disk_pct',
      'The data disk of key-value store {{resource.name}} is {{round metric.value 1}}% full. Grow its disk or delete keys before it stops taking writes.'
    ),
    (
      'ClickHouse disk almost full', 'database_clickhouse', 'disk_used_pct',
      'The disk of ClickHouse {{resource.name}} is {{round metric.value 1}}% full. Grow its disk, shorten retention or delete data before inserts fail.'
    )
) AS "seed"("name", "category", "metric", "message")
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules" AS "r" WHERE "r"."category" = "seed"."category" AND "r"."metric" = "seed"."metric"
);
