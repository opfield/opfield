-- Built-in alert rule "Storage is full" (category managed_storage, event storage.full): a managed storage that refuses
-- uploads (its disk is full, or it can create no volume) alerts out of the box and resolves once it takes uploads again
-- (storage.writable). It notifies the enabled webhooks the enabled proxy, node and managed storage rules notify now, so
-- an install that alerts gets this alert without setup; a fresh install has none to copy and the operator picks them.
-- Created once: an install that already has such a rule keeps its own.
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "event_pattern", "duration_seconds", "fire_threshold_percent",
  "resolve_after_seconds", "resolve_threshold_percent", "resource_ids", "message_template", "webhook_ids",
  "cooldown_seconds", "is_builtin"
)
SELECT
  'Storage is full', true, 'event', 'critical', 'managed_storage', 'storage.full', 0, 100, 60, 100,
  '[]'::jsonb,
  'Storage {{resource.name}} is full: uploads are refused until it has room again. Grow the storage or delete objects.',
  coalesce(
    (
      SELECT jsonb_agg(DISTINCT "w"."id"::text)
      FROM "notification_alert_rules" AS "r"
      CROSS JOIN LATERAL jsonb_array_elements_text("r"."webhook_ids") AS "rw"("id")
      JOIN "notification_webhooks" AS "w" ON "w"."id"::text = "rw"."id" AND "w"."enabled"
      WHERE "r"."enabled" AND "r"."category" IN ('proxy', 'node', 'managed_storage')
    ),
    '[]'::jsonb
  ),
  900, true
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules" WHERE "category" = 'managed_storage' AND "event_pattern" = 'storage.full'
);
