-- The built-in alert rule "Container changed outside Opfield" also fires for a managed container stopped, killed,
-- paused, resumed or updated outside Opfield (Docker daemons of 2.12.3 and later report these), and its message said
-- "its permissions were reset and its Git source builds refuse it" for every change, also for a stop or for a new
-- container under a managed name. Its message now says what the change means ({{details.consequence}}). A rule whose
-- message someone edited keeps it.
UPDATE "notification_alert_rules"
SET "message_template" = 'Container {{resource.name}} on {{node.name}} was {{details.change}} outside Opfield. {{details.consequence}} Change managed containers through Opfield.'
WHERE "is_builtin"
  AND "category" = 'container'
  AND "event_pattern" = 'changed_outside'
  AND "message_template" = 'Container {{resource.name}} on {{node.name}} was {{details.change}} outside Opfield. Opfield no longer tracks it as before: its permissions were reset and its Git source builds refuse it. Change managed containers through Opfield.';
