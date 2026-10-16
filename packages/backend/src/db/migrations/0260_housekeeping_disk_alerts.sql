-- Built-in alert rules: "Opfield disk full" (category opfield, metric host_disk, critical at 95% or more; host_disk is
-- now the fullest disk holding Opfield data: the Docker data root and every volume of the stack, not only the app's
-- data directory) and "Housekeeping not running" (event housekeeping.stale: no successful run for two days, so
-- retention stopped). They notify the enabled webhooks the enabled node and Opfield rules notify now; a fresh install
-- has none to copy. Created once each: an install that already has such a rule keeps its own.
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "metric", "operator", "threshold_value",
  "duration_seconds", "fire_threshold_percent", "resolve_after_seconds", "resolve_threshold_percent", "resource_ids",
  "message_template", "webhook_ids", "cooldown_seconds", "is_builtin"
)
SELECT
  'Opfield disk full', true, 'threshold', 'critical', 'opfield', 'host_disk', '>=', 95, 120, 100, 60, 100,
  '[]'::jsonb,
  'A disk holding Opfield data on the Opfield host is {{metric.value}}% full. Opfield ran Housekeeping already; free space now (Housekeeping shows what uses it) or grow the disk before Postgres stops.',
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
  1800, true
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules"
  WHERE "category" = 'opfield' AND "metric" = 'host_disk' AND "is_builtin" AND "severity" = 'critical'
);
--> statement-breakpoint
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "event_pattern", "duration_seconds", "fire_threshold_percent",
  "resolve_after_seconds", "resolve_threshold_percent", "resource_ids", "message_template", "webhook_ids",
  "cooldown_seconds", "is_builtin"
)
SELECT
  'Housekeeping not running', true, 'event', 'warning', 'opfield', 'housekeeping.stale', 0, 100, 60, 100,
  '[]'::jsonb,
  'Housekeeping has not finished successfully since {{details.last_success_at}}. Old records, build logs, images and leftovers are not being removed. Check the last run in Settings > Features > Housekeeping.',
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
  86400, true
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules" WHERE "category" = 'opfield' AND "event_pattern" = 'housekeeping.stale'
);
--> statement-breakpoint
-- The update counts as the first success, so "not running" is measured from it on installs that ran before.
INSERT INTO "settings" ("key", "value", "updated_at")
VALUES ('housekeeping:last_success_at', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), now())
ON CONFLICT ("key") DO NOTHING;
