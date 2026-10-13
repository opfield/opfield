ALTER TABLE "logging_environment_folders" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "logging_environment_folders" ADD COLUMN "app_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "ssl_certificate_folders" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "ssl_certificate_folders" ADD COLUMN "app_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "logging_environment_folders" ADD CONSTRAINT "logging_environment_folders_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logging_environment_folders" ADD CONSTRAINT "logging_environment_folders_app_environment_id_app_environments_id_fk" FOREIGN KEY ("app_environment_id") REFERENCES "public"."app_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssl_certificate_folders" ADD CONSTRAINT "ssl_certificate_folders_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssl_certificate_folders" ADD CONSTRAINT "ssl_certificate_folders_app_environment_id_app_environments_id_fk" FOREIGN KEY ("app_environment_id") REFERENCES "public"."app_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "logging_environment_folders_app_idx" ON "logging_environment_folders" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "logging_environment_folders_app_root_unique" ON "logging_environment_folders" USING btree ("app_id") WHERE "logging_environment_folders"."app_id" IS NOT NULL AND "logging_environment_folders"."app_environment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "logging_environment_folders_app_env_unique" ON "logging_environment_folders" USING btree ("app_environment_id") WHERE "logging_environment_folders"."app_environment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ssl_certificate_folders_app_idx" ON "ssl_certificate_folders" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssl_certificate_folders_app_root_unique" ON "ssl_certificate_folders" USING btree ("app_id") WHERE "ssl_certificate_folders"."app_id" IS NOT NULL AND "ssl_certificate_folders"."app_environment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ssl_certificate_folders_app_env_unique" ON "ssl_certificate_folders" USING btree ("app_environment_id") WHERE "ssl_certificate_folders"."app_environment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "logging_environment_folders" ADD CONSTRAINT "logging_environment_folders_app_env_check" CHECK ("logging_environment_folders"."app_environment_id" IS NULL OR "logging_environment_folders"."app_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "ssl_certificate_folders" ADD CONSTRAINT "ssl_certificate_folders_app_env_check" CHECK ("ssl_certificate_folders"."app_environment_id" IS NULL OR "ssl_certificate_folders"."app_id" IS NOT NULL);--> statement-breakpoint
-- Hidden app folders of the new families for every existing app and environment.
INSERT INTO "ssl_certificate_folders" ("name", "parent_id", "depth", "sort_order", "app_id", "app_environment_id", "created_by_id")
SELECT a."name", NULL, 0, 0, a."id", NULL, a."created_by_id" FROM "apps" a
WHERE NOT EXISTS (SELECT 1 FROM "ssl_certificate_folders" f WHERE f."app_id" = a."id" AND f."app_environment_id" IS NULL);
--> statement-breakpoint
INSERT INTO "ssl_certificate_folders" ("name", "parent_id", "depth", "sort_order", "app_id", "app_environment_id", "created_by_id")
SELECT e."name", r."id", 1, 0, e."app_id", e."id", e."created_by_id" FROM "app_environments" e
JOIN "ssl_certificate_folders" r ON r."app_id" = e."app_id" AND r."app_environment_id" IS NULL
WHERE NOT EXISTS (SELECT 1 FROM "ssl_certificate_folders" f WHERE f."app_environment_id" = e."id");
--> statement-breakpoint
INSERT INTO "logging_environment_folders" ("name", "parent_id", "depth", "sort_order", "app_id", "app_environment_id", "created_by_id")
SELECT a."name", NULL, 0, 0, a."id", NULL, a."created_by_id" FROM "apps" a
WHERE NOT EXISTS (SELECT 1 FROM "logging_environment_folders" f WHERE f."app_id" = a."id" AND f."app_environment_id" IS NULL);
--> statement-breakpoint
INSERT INTO "logging_environment_folders" ("name", "parent_id", "depth", "sort_order", "app_id", "app_environment_id", "created_by_id")
SELECT e."name", r."id", 1, 0, e."app_id", e."id", e."created_by_id" FROM "app_environments" e
JOIN "logging_environment_folders" r ON r."app_id" = e."app_id" AND r."app_environment_id" IS NULL
WHERE NOT EXISTS (SELECT 1 FROM "logging_environment_folders" f WHERE f."app_environment_id" = e."id");
