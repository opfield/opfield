-- Apps phase 2: shutdown and kill switch incidents per environment, each with the items it changed and their prior
-- state (restored item by item). Managed storage gets a 'paused' status for app shutdowns; a kill switch can hold a
-- Secure Link closed and keep a suspended publication's port (owner kind app_incident). Additive only.
ALTER TYPE "public"."managed_storage_status" ADD VALUE 'paused' BEFORE 'stopped';--> statement-breakpoint
CREATE TABLE "app_incident_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"item_kind" varchar(32) NOT NULL,
	"item_key" text NOT NULL,
	"phase" integer DEFAULT 0 NOT NULL,
	"ref" jsonb NOT NULL,
	"prior_state" jsonb,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"state" varchar(16) DEFAULT 'applying' NOT NULL,
	"started_by_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by_id" uuid,
	"released_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_host_port_reservations" DROP CONSTRAINT "node_host_port_reservations_owner_kind_valid";--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD COLUMN "incident_suspended_by" uuid;--> statement-breakpoint
ALTER TABLE "app_incident_items" ADD CONSTRAINT "app_incident_items_incident_id_app_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."app_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_incidents" ADD CONSTRAINT "app_incidents_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_incidents" ADD CONSTRAINT "app_incidents_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_incidents" ADD CONSTRAINT "app_incidents_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_incidents" ADD CONSTRAINT "app_incidents_released_by_id_users_id_fk" FOREIGN KEY ("released_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_incident_items_incident_key_unique" ON "app_incident_items" USING btree ("incident_id","item_key");--> statement-breakpoint
CREATE INDEX "app_incident_items_kind_status_idx" ON "app_incident_items" USING btree ("item_kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "app_incidents_env_kind_open_unique" ON "app_incidents" USING btree ("environment_id","kind") WHERE "app_incidents"."state" in ('applying', 'active', 'releasing');--> statement-breakpoint
CREATE INDEX "app_incidents_app_started_idx" ON "app_incidents" USING btree ("app_id","started_at");--> statement-breakpoint
CREATE INDEX "app_incidents_state_idx" ON "app_incidents" USING btree ("state");--> statement-breakpoint
ALTER TABLE "node_host_port_reservations" ADD CONSTRAINT "node_host_port_reservations_owner_kind_valid" CHECK ("node_host_port_reservations"."owner_kind" IN ('deployment', 'deployment_replica', 'managed_storage', 'managed_database', 'app_incident'));