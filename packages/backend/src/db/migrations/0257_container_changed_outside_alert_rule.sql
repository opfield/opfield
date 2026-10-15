-- Built-in alert rule "Container changed outside Opfield" (category container, event changed_outside): a managed
-- container removed, created under its name or renamed by anything other than Opfield (docker on the node's console,
-- a script, another tool) alerts out of the box. Opfield no longer tracks such a container as before: its access
-- identity and grants are reset and its Git-source builds refuse it. It notifies the enabled webhooks the enabled
-- container and node rules notify now, so an install that alerts gets this alert without setup; a fresh install has
-- none to copy and the operator picks them. Created once: an install that already has such a rule keeps its own.
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "event_pattern", "duration_seconds", "fire_threshold_percent",
  "resolve_after_seconds", "resolve_threshold_percent", "resource_ids", "message_template", "webhook_ids",
  "cooldown_seconds", "is_builtin"
)
SELECT
  'Container changed outside Opfield', true, 'event', 'warning', 'container', 'changed_outside', 0, 100, 60, 100,
  '[]'::jsonb,
  'Container {{resource.name}} on {{node.name}} was {{details.change}} outside Opfield. Opfield no longer tracks it as before: its permissions were reset and its Git source builds refuse it. Change managed containers through Opfield.',
  coalesce(
    (
      SELECT jsonb_agg(DISTINCT "w"."id"::text)
      FROM "notification_alert_rules" AS "r"
      CROSS JOIN LATERAL jsonb_array_elements_text("r"."webhook_ids") AS "rw"("id")
      JOIN "notification_webhooks" AS "w" ON "w"."id"::text = "rw"."id" AND "w"."enabled"
      WHERE "r"."enabled" AND "r"."category" IN ('container', 'node')
    ),
    '[]'::jsonb
  ),
  300, true
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules" WHERE "category" = 'container' AND "event_pattern" = 'changed_outside'
);
