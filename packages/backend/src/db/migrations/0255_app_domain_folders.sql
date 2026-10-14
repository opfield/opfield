ALTER TABLE "app_environments" ADD COLUMN "domain_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "domain_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_folders" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "domain_folders" ADD COLUMN "app_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "domain_folders" ADD CONSTRAINT "domain_folders_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_folders" ADD CONSTRAINT "domain_folders_app_environment_id_app_environments_id_fk" FOREIGN KEY ("app_environment_id") REFERENCES "public"."app_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_folders_app_idx" ON "domain_folders" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_folders_app_root_unique" ON "domain_folders" USING btree ("app_id") WHERE "domain_folders"."app_id" IS NOT NULL AND "domain_folders"."app_environment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_folders_app_env_unique" ON "domain_folders" USING btree ("app_environment_id") WHERE "domain_folders"."app_environment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_folders" ADD CONSTRAINT "domain_folders_app_env_check" CHECK ("domain_folders"."app_environment_id" IS NULL OR "domain_folders"."app_id" IS NOT NULL);--> statement-breakpoint
-- Hidden app folders of the domains family for every existing app and environment.
INSERT INTO "domain_folders" ("name", "parent_id", "depth", "sort_order", "app_id", "app_environment_id", "created_by_id")
SELECT a."name", NULL, 0, 0, a."id", NULL, a."created_by_id" FROM "apps" a
WHERE NOT EXISTS (SELECT 1 FROM "domain_folders" f WHERE f."app_id" = a."id" AND f."app_environment_id" IS NULL);
--> statement-breakpoint
INSERT INTO "domain_folders" ("name", "parent_id", "depth", "sort_order", "app_id", "app_environment_id", "created_by_id")
SELECT e."name", r."id", 1, 0, e."app_id", e."id", e."created_by_id" FROM "app_environments" e
JOIN "domain_folders" r ON r."app_id" = e."app_id" AND r."app_environment_id" IS NULL
WHERE NOT EXISTS (SELECT 1 FROM "domain_folders" f WHERE f."app_environment_id" = e."id");
