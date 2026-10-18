-- Resource folders for alert rules, notification webhooks and access lists, like the other resource lists. Existing
-- rules, webhooks and access lists stay ungrouped (folder_id NULL); built-in rules keep showing in the read-only
-- built-in group. Their list order is kept: sort_order follows the order they were created in.
CREATE TABLE "access_list_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_alert_rule_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_webhook_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_alert_rules" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_alert_rules" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_webhooks" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_webhooks" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "access_list_folders" ADD CONSTRAINT "access_list_folders_parent_id_access_list_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."access_list_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_list_folders" ADD CONSTRAINT "access_list_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_alert_rule_folders" ADD CONSTRAINT "notification_alert_rule_folders_parent_id_notification_alert_rule_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."notification_alert_rule_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_alert_rule_folders" ADD CONSTRAINT "notification_alert_rule_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_webhook_folders" ADD CONSTRAINT "notification_webhook_folders_parent_id_notification_webhook_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."notification_webhook_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_webhook_folders" ADD CONSTRAINT "notification_webhook_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_list_folder_parent_idx" ON "access_list_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "access_list_folder_sort_idx" ON "access_list_folders" USING btree ("parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "notification_alert_rule_folder_parent_idx" ON "notification_alert_rule_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "notification_alert_rule_folder_sort_idx" ON "notification_alert_rule_folders" USING btree ("parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "notification_webhook_folder_parent_idx" ON "notification_webhook_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "notification_webhook_folder_sort_idx" ON "notification_webhook_folders" USING btree ("parent_id","sort_order");--> statement-breakpoint
ALTER TABLE "access_lists" ADD CONSTRAINT "access_lists_folder_id_access_list_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."access_list_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_alert_rules" ADD CONSTRAINT "notification_alert_rules_folder_id_notification_alert_rule_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."notification_alert_rule_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_webhooks" ADD CONSTRAINT "notification_webhooks_folder_id_notification_webhook_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."notification_webhook_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_list_folder_idx" ON "access_lists" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "notif_alert_rules_folder_idx" ON "notification_alert_rules" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "notif_webhooks_folder_idx" ON "notification_webhooks" USING btree ("folder_id");--> statement-breakpoint
UPDATE "notification_alert_rules" AS r SET "sort_order" = o.position
FROM (SELECT "id", (row_number() OVER (ORDER BY "created_at", "id") - 1)::integer AS position FROM "notification_alert_rules") AS o
WHERE r."id" = o."id";--> statement-breakpoint
UPDATE "notification_webhooks" AS w SET "sort_order" = o.position
FROM (SELECT "id", (row_number() OVER (ORDER BY "created_at", "id") - 1)::integer AS position FROM "notification_webhooks") AS o
WHERE w."id" = o."id";--> statement-breakpoint
UPDATE "access_lists" AS a SET "sort_order" = o.position
FROM (SELECT "id", (row_number() OVER (ORDER BY "created_at", "id") - 1)::integer AS position FROM "access_lists") AS o
WHERE a."id" = o."id";
