-- Built-in alert messages that said too little (rc.3 stand): the Opfield disk alerts did not name the disk. Only
-- messages still at their shipped text change; an edited message stays as the operator wrote it. ("Container changed
-- outside Opfield" gets its new message from 0269.)
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
