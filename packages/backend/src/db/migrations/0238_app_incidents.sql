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
ALTER TABLE "managed_storage_bindings" ADD COLUMN "desired_state" varchar(32) DEFAULT 'active' NOT NULL;--> statement-breakpoint
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
ALTER TABLE "node_host_port_reservations" ADD CONSTRAINT "node_host_port_reservations_owner_kind_valid" CHECK ("node_host_port_reservations"."owner_kind" IN ('deployment', 'deployment_replica', 'managed_storage', 'managed_database', 'app_incident'));--> statement-breakpoint
-- The periodic reconcile also releases a kill switch's port hold once its incident item is gone (app deleted).
CREATE OR REPLACE FUNCTION "node_host_port_reservations_reconcile"() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
	"v_released" integer;
	"v_owner" record;
BEGIN
	DELETE FROM "node_host_port_reservations" AS "row"
	WHERE ("row"."owner_kind" = 'deployment' AND NOT EXISTS (SELECT 1 FROM "docker_deployments" AS "o" WHERE "o"."id" = "row"."owner_id"))
		OR ("row"."owner_kind" = 'deployment_replica' AND NOT EXISTS (SELECT 1 FROM "docker_availability_placements" AS "o" WHERE "o"."id" = "row"."owner_id"))
		OR ("row"."owner_kind" = 'managed_storage' AND NOT EXISTS (SELECT 1 FROM "managed_storage_clusters" AS "o" WHERE "o"."id" = "row"."owner_id"))
		OR ("row"."owner_kind" = 'managed_database' AND NOT EXISTS (SELECT 1 FROM "managed_database_instances" AS "o" WHERE "o"."id" = "row"."owner_id"))
		OR ("row"."owner_kind" = 'app_incident' AND NOT EXISTS (SELECT 1 FROM "app_incident_items" AS "o" WHERE "o"."id" = "row"."owner_id"));
	GET DIAGNOSTICS "v_released" = ROW_COUNT;
	FOR "v_owner" IN
		SELECT 'deployment' AS "kind", "id" FROM "docker_deployments"
		UNION ALL SELECT 'managed_storage', "id" FROM "managed_storage_clusters"
		UNION ALL SELECT 'managed_database', "id" FROM "managed_database_instances"
		UNION ALL SELECT 'deployment_replica', "placement"."id"
			FROM "docker_availability_placements" AS "placement"
			JOIN "docker_availability_policies" AS "policy" ON "policy"."id" = "placement"."policy_id"
			WHERE "policy"."resource_kind" = 'deployment'
	LOOP
		PERFORM "node_host_port_reservations_sync_owner"("v_owner"."kind", "v_owner"."id", true);
	END LOOP;
	BEGIN
		UPDATE "node_host_port_reservations" SET "conflict" = false
		WHERE "id" IN (
			SELECT DISTINCT ON ("waiting"."node_id", "waiting"."protocol", "waiting"."host_port") "waiting"."id"
			FROM "node_host_port_reservations" AS "waiting"
			WHERE "waiting"."conflict"
				AND NOT EXISTS (
					SELECT 1 FROM "node_host_port_reservations" AS "holder"
					WHERE "holder"."node_id" = "waiting"."node_id"
						AND "holder"."protocol" = "waiting"."protocol"
						AND "holder"."host_port" = "waiting"."host_port"
						AND NOT "holder"."conflict"
				)
			ORDER BY "waiting"."node_id", "waiting"."protocol", "waiting"."host_port", "waiting"."created_at", "waiting"."id"
		);
	EXCEPTION WHEN unique_violation THEN
		-- A reservation committed meanwhile holds the port: the next pass decides.
		NULL;
	END;
	RETURN "v_released";
END;
$$;
