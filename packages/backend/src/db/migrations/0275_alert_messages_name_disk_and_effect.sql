-- Built-in alert messages that said too little (rc.3 stand): the Opfield disk alerts did not name the disk, and
-- "Container changed outside Opfield" told of reset permissions even for a container created by hand. Only messages
-- still at their shipped text change; an edited message stays as the operator wrote it.
UPDATE "notification_alert_rules"
SET
	"message_template" = 'The data disk of the Opfield host is {{metric.value}}% full{{#if details.disk}} ({{details.disk}}){{/if}}. Free space before Opfield stops: run Housekeeping, remove old images or logs, or grow the disk.',
	"updated_at" = now()
WHERE "is_builtin" AND "category" = 'opfield' AND "metric" = 'host_disk'
	AND "message_template" = 'The data disk of the Opfield host is {{metric.value}}% full. Free space before Opfield stops: run Housekeeping, remove old images or logs, or grow the disk.';
--> statement-breakpoint
UPDATE "notification_alert_rules"
SET
	"message_template" = 'A disk holding Opfield data on the Opfield host is {{metric.value}}% full{{#if details.disk}} ({{details.disk}}){{/if}}. Opfield ran Housekeeping already; free space now (Housekeeping shows what uses it) or grow the disk before Postgres stops.',
	"updated_at" = now()
WHERE "is_builtin" AND "category" = 'opfield' AND "metric" = 'host_disk'
	AND "message_template" = 'A disk holding Opfield data on the Opfield host is {{metric.value}}% full. Opfield ran Housekeeping already; free space now (Housekeeping shows what uses it) or grow the disk before Postgres stops.';
--> statement-breakpoint
UPDATE "notification_alert_rules"
SET
	"message_template" = 'Container {{resource.name}} on {{node.name}} was {{details.change}} outside Opfield. {{#if details.effect}}{{details.effect}}{{else}}Opfield no longer tracks it as before.{{/if}} Change managed containers through Opfield.',
	"updated_at" = now()
WHERE "is_builtin" AND "category" = 'container' AND "event_pattern" = 'changed_outside'
	AND "message_template" = 'Container {{resource.name}} on {{node.name}} was {{details.change}} outside Opfield. Opfield no longer tracks it as before: its permissions were reset and its Git source builds refuse it. Change managed containers through Opfield.';
