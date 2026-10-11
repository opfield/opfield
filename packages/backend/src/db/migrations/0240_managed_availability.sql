-- Database and storage availability (2.12): availability sets of managed databases and storage clusters, their members
-- and witnesses, the relay witness hosting flag, and a lease policy registry so one lease host serves Availability
-- policies and availability sets. Every existing Availability policy is registered under its own id, so its lease
-- state, manifests, voter epochs, observations and relay gates carry on unchanged; the lease tables keep their names.
CREATE TABLE "managed_availability_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_kind" varchar(24) NOT NULL,
	"owner_id" uuid NOT NULL,
	"managed_database_id" uuid,
	"managed_storage_cluster_id" uuid,
	"engine" varchar(16) NOT NULL,
	"mode" varchar(16) NOT NULL,
	"durability" varchar(16) NOT NULL,
	"durability_source" varchar(8) DEFAULT 'auto' NOT NULL,
	"sync_degrade_after_seconds" integer DEFAULT 10 NOT NULL,
	"max_lag_bytes" bigint DEFAULT 1048576 NOT NULL,
	"priority_mode" boolean DEFAULT false NOT NULL,
	"failback_delay_seconds" integer DEFAULT 300 NOT NULL,
	"lease_policy_id" uuid,
	"primary_member_id" uuid,
	"primary_since" timestamp with time zone,
	"primary_generation" bigint DEFAULT 0 NOT NULL,
	"rtt_p50_ms" numeric(8, 2),
	"rtt_measured_at" timestamp with time zone,
	"state" varchar(16) DEFAULT 'converting' NOT NULL,
	"state_reason" jsonb,
	"operation" jsonb,
	"config_revision" bigint DEFAULT 0 NOT NULL,
	"encrypted_engine_credentials" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_availability_sets_owner_unique" UNIQUE("owner_kind","owner_id"),
	CONSTRAINT "managed_availability_sets_lease_policy_unique" UNIQUE("lease_policy_id"),
	CONSTRAINT "managed_availability_sets_owner_kind_check" CHECK ("managed_availability_sets"."owner_kind" IN ('managed_database', 'managed_storage')),
	CONSTRAINT "managed_availability_sets_owner_check" CHECK (("managed_availability_sets"."owner_kind" = 'managed_database' AND "managed_availability_sets"."managed_database_id" = "managed_availability_sets"."owner_id" AND "managed_availability_sets"."managed_storage_cluster_id" IS NULL) OR ("managed_availability_sets"."owner_kind" = 'managed_storage' AND "managed_availability_sets"."managed_storage_cluster_id" = "managed_availability_sets"."owner_id" AND "managed_availability_sets"."managed_database_id" IS NULL)),
	CONSTRAINT "managed_availability_sets_engine_check" CHECK ("managed_availability_sets"."engine" IN ('postgres', 'valkey', 'clickhouse', 'seaweedfs')),
	CONSTRAINT "managed_availability_sets_mode_check" CHECK ("managed_availability_sets"."mode" IN ('automatic', 'manual')),
	CONSTRAINT "managed_availability_sets_durability_check" CHECK ("managed_availability_sets"."durability" IN ('synchronous', 'asynchronous')),
	CONSTRAINT "managed_availability_sets_durability_source_check" CHECK ("managed_availability_sets"."durability_source" IN ('auto', 'admin')),
	CONSTRAINT "managed_availability_sets_state_check" CHECK ("managed_availability_sets"."state" IN ('converting', 'healthy', 'degraded', 'no_failover', 'failing_over', 'closing', 'error')),
	CONSTRAINT "managed_availability_sets_settings_check" CHECK ("managed_availability_sets"."sync_degrade_after_seconds" BETWEEN 1 AND 3600 AND "managed_availability_sets"."max_lag_bytes" >= 0 AND "managed_availability_sets"."failback_delay_seconds" >= 0 AND "managed_availability_sets"."primary_generation" >= 0 AND "managed_availability_sets"."config_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "managed_availability_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"member_index" integer NOT NULL,
	"desired_state" varchar(16) DEFAULT 'member' NOT NULL,
	"role" varchar(16) DEFAULT 'unknown' NOT NULL,
	"eligible" boolean DEFAULT false NOT NULL,
	"eligibility_reason" varchar(64),
	"lag_bytes" bigint,
	"lag_seconds" numeric(12, 3),
	"sync_state" varchar(16) DEFAULT 'none' NOT NULL,
	"engine_position" jsonb,
	"relay_endpoint_id" uuid,
	"certificate_id" uuid,
	"published_port" integer,
	"published_native_port" integer,
	"encrypted_replication_credentials" text,
	"status" varchar(16) DEFAULT 'creating' NOT NULL,
	"last_error" text,
	"last_reported_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_availability_members_set_node_unique" UNIQUE("set_id","node_id"),
	CONSTRAINT "managed_availability_members_set_index_unique" UNIQUE("set_id","member_index"),
	CONSTRAINT "managed_availability_members_desired_state_check" CHECK ("managed_availability_members"."desired_state" IN ('member', 'removing')),
	CONSTRAINT "managed_availability_members_role_check" CHECK ("managed_availability_members"."role" IN ('primary', 'copy', 'rebuilding', 'fenced', 'unknown')),
	CONSTRAINT "managed_availability_members_sync_state_check" CHECK ("managed_availability_members"."sync_state" IN ('sync', 'async', 'none')),
	CONSTRAINT "managed_availability_members_status_check" CHECK ("managed_availability_members"."status" IN ('creating', 'ready', 'error', 'removing')),
	CONSTRAINT "managed_availability_members_index_check" CHECK ("managed_availability_members"."member_index" BETWEEN 0 AND 1023)
);
--> statement-breakpoint
CREATE TABLE "managed_availability_witnesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"purpose" varchar(16) NOT NULL,
	"host_kind" varchar(16) NOT NULL,
	"relay_instance_id" uuid,
	"node_id" uuid,
	"role" varchar(16) DEFAULT 'active' NOT NULL,
	"keeper_server_id" integer,
	"artifact_version" varchar(64),
	"artifact_sha256" varchar(71),
	"desired_state" varchar(16) DEFAULT 'running' NOT NULL,
	"observed_state" varchar(32),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_availability_witnesses_purpose_check" CHECK ("managed_availability_witnesses"."purpose" IN ('lease', 'keeper')),
	CONSTRAINT "managed_availability_witnesses_host_check" CHECK (("managed_availability_witnesses"."host_kind" = 'relay' AND "managed_availability_witnesses"."relay_instance_id" IS NOT NULL AND "managed_availability_witnesses"."node_id" IS NULL) OR ("managed_availability_witnesses"."host_kind" = 'node' AND "managed_availability_witnesses"."node_id" IS NOT NULL AND "managed_availability_witnesses"."relay_instance_id" IS NULL)),
	CONSTRAINT "managed_availability_witnesses_role_check" CHECK ("managed_availability_witnesses"."role" IN ('active', 'standby')),
	CONSTRAINT "managed_availability_witnesses_desired_state_check" CHECK ("managed_availability_witnesses"."desired_state" IN ('running', 'standby', 'removed')),
	CONSTRAINT "managed_availability_witnesses_keeper_check" CHECK (("managed_availability_witnesses"."purpose" = 'keeper') = ("managed_availability_witnesses"."keeper_server_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lease_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"resource_id" uuid NOT NULL,
	"stateful" boolean DEFAULT false NOT NULL,
	"docker_availability_policy_id" uuid,
	"managed_availability_set_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_policies_kind_check" CHECK ("lease_policies"."kind" IN ('docker_availability', 'managed_availability_set')),
	CONSTRAINT "lease_policies_owner_check" CHECK (("lease_policies"."kind" <> 'docker_availability' OR "lease_policies"."docker_availability_policy_id" IS NOT DISTINCT FROM "lease_policies"."resource_id") AND ("lease_policies"."kind" <> 'managed_availability_set' OR "lease_policies"."managed_availability_set_id" IS NOT DISTINCT FROM "lease_policies"."resource_id"))
);
--> statement-breakpoint
ALTER TABLE "relay_instances" ADD COLUMN "witness_hosting_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_instances" ADD COLUMN "witness_hosting_local" varchar(32);--> statement-breakpoint
ALTER TABLE "managed_availability_sets" ADD CONSTRAINT "managed_availability_sets_managed_database_id_managed_database_instances_id_fk" FOREIGN KEY ("managed_database_id") REFERENCES "public"."managed_database_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_availability_sets" ADD CONSTRAINT "managed_availability_sets_managed_storage_cluster_id_managed_storage_clusters_id_fk" FOREIGN KEY ("managed_storage_cluster_id") REFERENCES "public"."managed_storage_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_availability_members" ADD CONSTRAINT "managed_availability_members_set_id_managed_availability_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."managed_availability_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_availability_members" ADD CONSTRAINT "managed_availability_members_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_availability_members" ADD CONSTRAINT "managed_availability_members_certificate_id_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_availability_witnesses" ADD CONSTRAINT "managed_availability_witnesses_set_id_managed_availability_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."managed_availability_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_availability_witnesses" ADD CONSTRAINT "managed_availability_witnesses_relay_instance_id_relay_instances_id_fk" FOREIGN KEY ("relay_instance_id") REFERENCES "public"."relay_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_availability_witnesses" ADD CONSTRAINT "managed_availability_witnesses_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_policies" ADD CONSTRAINT "lease_policies_docker_availability_policy_id_docker_availability_policies_id_fk" FOREIGN KEY ("docker_availability_policy_id") REFERENCES "public"."docker_availability_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_policies" ADD CONSTRAINT "lease_policies_managed_availability_set_id_managed_availability_sets_id_fk" FOREIGN KEY ("managed_availability_set_id") REFERENCES "public"."managed_availability_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_availability_members_node_idx" ON "managed_availability_members" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "managed_availability_witnesses_set_idx" ON "managed_availability_witnesses" USING btree ("set_id");--> statement-breakpoint
CREATE INDEX "managed_availability_witnesses_relay_idx" ON "managed_availability_witnesses" USING btree ("relay_instance_id");--> statement-breakpoint
CREATE INDEX "lease_policies_resource_idx" ON "lease_policies" USING btree ("kind","resource_id");--> statement-breakpoint
INSERT INTO "lease_policies" ("id", "kind", "resource_id", "stateful", "docker_availability_policy_id", "created_at")
SELECT "id", 'docker_availability', "id", false, "id", "created_at" FROM "docker_availability_policies"
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "docker_availability_lease_state" DROP CONSTRAINT "docker_availability_lease_state_policy_id_docker_availability_policies_id_fk";--> statement-breakpoint
ALTER TABLE "docker_availability_lease_state" ADD COLUMN "candidate_member_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_availability_lease_state" ADD COLUMN "required_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_availability_lease_state" ADD CONSTRAINT "docker_availability_lease_state_policy_id_lease_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."lease_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_lease_observations" DROP CONSTRAINT "docker_availability_lease_observations_policy_id_docker_availability_policies_id_fk";--> statement-breakpoint
ALTER TABLE "docker_availability_lease_observations" ADD COLUMN "state_hash" varchar(80);--> statement-breakpoint
ALTER TABLE "docker_availability_lease_observations" ADD CONSTRAINT "docker_availability_lease_observations_policy_id_lease_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."lease_policies"("id") ON DELETE cascade ON UPDATE no action;
