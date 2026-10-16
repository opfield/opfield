-- list_alerts and GET /api/notifications/alerts show what fired: the resource's name and the message notified.
-- Rows written before 2.12.3 keep both null and are shown with their resource id.
ALTER TABLE "notification_alert_states" ADD COLUMN "resource_name" varchar(255);--> statement-breakpoint
ALTER TABLE "notification_alert_states" ADD COLUMN "message" text;
