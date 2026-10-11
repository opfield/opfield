-- Apps phase 2: promotions between environments (per-item status), artifacts kept for a promotion (owner kind
-- promotion) and the revision a promoted Compose revision came from. Additive only.
CREATE TABLE "app_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"source_environment_id" uuid NOT NULL,
	"target_environment_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'running' NOT NULL,
	"preview_digest" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_by_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" DROP CONSTRAINT "docker_build_artifacts_owner_check";--> statement-breakpoint
ALTER TABLE "docker_compose_revisions" ADD COLUMN "promoted_from_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "app_promotions" ADD CONSTRAINT "app_promotions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_promotions" ADD CONSTRAINT "app_promotions_source_environment_id_app_environments_id_fk" FOREIGN KEY ("source_environment_id") REFERENCES "public"."app_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_promotions" ADD CONSTRAINT "app_promotions_target_environment_id_app_environments_id_fk" FOREIGN KEY ("target_environment_id") REFERENCES "public"."app_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_promotions" ADD CONSTRAINT "app_promotions_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_promotions_app_started_idx" ON "app_promotions" USING btree ("app_id","started_at");--> statement-breakpoint
CREATE INDEX "app_promotions_target_started_idx" ON "app_promotions" USING btree ("target_environment_id","started_at");--> statement-breakpoint
ALTER TABLE "docker_compose_revisions" ADD CONSTRAINT "docker_compose_revisions_promoted_from_revision_id_docker_compose_revisions_id_fk" FOREIGN KEY ("promoted_from_revision_id") REFERENCES "public"."docker_compose_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" ADD CONSTRAINT "docker_build_artifacts_owner_check" CHECK ((
        "docker_build_artifacts"."owner_kind" = 'build'
        AND "docker_build_artifacts"."build_id" IS NOT NULL
        AND "docker_build_artifacts"."source_binding_id" IS NOT NULL
        AND "docker_build_artifacts"."owner_key" IS NULL
        AND "docker_build_artifacts"."source_image_reference" IS NULL
      ) OR (
        "docker_build_artifacts"."owner_kind" IN ('availability', 'promotion')
        AND "docker_build_artifacts"."build_id" IS NULL
        AND "docker_build_artifacts"."source_binding_id" IS NULL
        AND "docker_build_artifacts"."owner_key" IS NOT NULL
        AND "docker_build_artifacts"."source_image_reference" IS NOT NULL
      ));