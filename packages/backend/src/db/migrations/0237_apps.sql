-- Apps (2.12): apps, environments, node allowlist, environment variables/secrets and the layer each workload last
-- received. Members live in hidden folders of their own type (app_id set on the folder row). Routes get a computed app
-- maintenance overlay; audit rows get app tags written at log time. Additive only: existing rows are unchanged.
CREATE TABLE "app_environment_layer_state" (
	"owner_kind" varchar(16) NOT NULL,
	"owner_key" text NOT NULL,
	"environment_id" uuid,
	"applied_keys" text[] NOT NULL,
	"applied_digest" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_environment_layer_state_owner_kind_owner_key_pk" PRIMARY KEY("owner_kind","owner_key")
);
--> statement-breakpoint
CREATE TABLE "app_environment_nodes" (
	"environment_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_environment_nodes_environment_id_node_id_pk" PRIMARY KEY("environment_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "app_environment_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"encrypted_value" text NOT NULL,
	"secret" boolean NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"slug" varchar(64) NOT NULL,
	"is_production" boolean DEFAULT false NOT NULL,
	"maintenance_enabled" boolean DEFAULT false NOT NULL,
	"maintenance_started_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"maintenance_override" boolean DEFAULT false NOT NULL,
	"maintenance_override_at" timestamp with time zone,
	"maintenance_override_by" uuid,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "app_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "app_member_type" varchar(32);--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "app_member_id" text;--> statement-breakpoint
ALTER TABLE "database_connection_folders" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "database_connection_folders" ADD COLUMN "app_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_container_folders" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_container_folders" ADD COLUMN "app_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "object_storage_folders" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "object_storage_folders" ADD COLUMN "app_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "page_project_folders" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "page_project_folders" ADD COLUMN "app_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "proxy_host_folders" ADD COLUMN "app_id" uuid;--> statement-breakpoint
ALTER TABLE "proxy_host_folders" ADD COLUMN "app_environment_id" uuid;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "app_maintenance_mode" varchar(16) DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_environment_layer_state" ADD CONSTRAINT "app_environment_layer_state_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_environment_nodes" ADD CONSTRAINT "app_environment_nodes_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_environment_nodes" ADD CONSTRAINT "app_environment_nodes_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_environment_nodes" ADD CONSTRAINT "app_environment_nodes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_environment_variables" ADD CONSTRAINT "app_environment_variables_environment_id_app_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."app_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_environment_variables" ADD CONSTRAINT "app_environment_variables_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_environments" ADD CONSTRAINT "app_environments_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_environments" ADD CONSTRAINT "app_environments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_maintenance_override_by_users_id_fk" FOREIGN KEY ("maintenance_override_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_environment_layer_state_env_idx" ON "app_environment_layer_state" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "app_environment_nodes_node_idx" ON "app_environment_nodes" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_environment_variables_env_key_unique" ON "app_environment_variables" USING btree ("environment_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "app_environments_name_lower_unique" ON "app_environments" USING btree ("app_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "app_environments_slug_unique" ON "app_environments" USING btree ("app_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "app_environments_one_production" ON "app_environments" USING btree ("app_id") WHERE "app_environments"."is_production";--> statement-breakpoint
CREATE UNIQUE INDEX "apps_slug_unique" ON "apps" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_name_lower_unique" ON "apps" USING btree (lower("name"));--> statement-breakpoint
ALTER TABLE "database_connection_folders" ADD CONSTRAINT "database_connection_folders_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_connection_folders" ADD CONSTRAINT "database_connection_folders_app_environment_id_app_environments_id_fk" FOREIGN KEY ("app_environment_id") REFERENCES "public"."app_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_container_folders" ADD CONSTRAINT "docker_container_folders_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_container_folders" ADD CONSTRAINT "docker_container_folders_app_environment_id_app_environments_id_fk" FOREIGN KEY ("app_environment_id") REFERENCES "public"."app_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_storage_folders" ADD CONSTRAINT "object_storage_folders_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_storage_folders" ADD CONSTRAINT "object_storage_folders_app_environment_id_app_environments_id_fk" FOREIGN KEY ("app_environment_id") REFERENCES "public"."app_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_project_folders" ADD CONSTRAINT "page_project_folders_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_project_folders" ADD CONSTRAINT "page_project_folders_app_environment_id_app_environments_id_fk" FOREIGN KEY ("app_environment_id") REFERENCES "public"."app_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_host_folders" ADD CONSTRAINT "proxy_host_folders_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_host_folders" ADD CONSTRAINT "proxy_host_folders_app_environment_id_app_environments_id_fk" FOREIGN KEY ("app_environment_id") REFERENCES "public"."app_environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_app_idx" ON "audit_log" USING btree ("app_id","created_at" DESC NULLS LAST) WHERE "audit_log"."app_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "database_connection_folders_app_idx" ON "database_connection_folders" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "database_connection_folders_app_root_unique" ON "database_connection_folders" USING btree ("app_id") WHERE "database_connection_folders"."app_id" IS NOT NULL AND "database_connection_folders"."app_environment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "database_connection_folders_app_env_unique" ON "database_connection_folders" USING btree ("app_environment_id") WHERE "database_connection_folders"."app_environment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "docker_container_folders_app_idx" ON "docker_container_folders" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_container_folders_app_root_unique" ON "docker_container_folders" USING btree ("app_id","resource_type") WHERE "docker_container_folders"."app_id" IS NOT NULL AND "docker_container_folders"."app_environment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "docker_container_folders_app_env_unique" ON "docker_container_folders" USING btree ("app_environment_id","resource_type") WHERE "docker_container_folders"."app_environment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "object_storage_folders_app_idx" ON "object_storage_folders" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "object_storage_folders_app_root_unique" ON "object_storage_folders" USING btree ("app_id") WHERE "object_storage_folders"."app_id" IS NOT NULL AND "object_storage_folders"."app_environment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "object_storage_folders_app_env_unique" ON "object_storage_folders" USING btree ("app_environment_id") WHERE "object_storage_folders"."app_environment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "page_project_folders_app_idx" ON "page_project_folders" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_project_folders_app_root_unique" ON "page_project_folders" USING btree ("app_id") WHERE "page_project_folders"."app_id" IS NOT NULL AND "page_project_folders"."app_environment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "page_project_folders_app_env_unique" ON "page_project_folders" USING btree ("app_environment_id") WHERE "page_project_folders"."app_environment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "proxy_host_folders_app_idx" ON "proxy_host_folders" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_host_folders_app_root_unique" ON "proxy_host_folders" USING btree ("app_id") WHERE "proxy_host_folders"."app_id" IS NOT NULL AND "proxy_host_folders"."app_environment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_host_folders_app_env_unique" ON "proxy_host_folders" USING btree ("app_environment_id") WHERE "proxy_host_folders"."app_environment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "database_connection_folders" ADD CONSTRAINT "database_connection_folders_app_env_check" CHECK ("database_connection_folders"."app_environment_id" IS NULL OR "database_connection_folders"."app_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "docker_container_folders" ADD CONSTRAINT "docker_container_folders_app_env_check" CHECK ("docker_container_folders"."app_environment_id" IS NULL OR "docker_container_folders"."app_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "object_storage_folders" ADD CONSTRAINT "object_storage_folders_app_env_check" CHECK ("object_storage_folders"."app_environment_id" IS NULL OR "object_storage_folders"."app_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "page_project_folders" ADD CONSTRAINT "page_project_folders_app_env_check" CHECK ("page_project_folders"."app_environment_id" IS NULL OR "page_project_folders"."app_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "proxy_host_folders" ADD CONSTRAINT "proxy_host_folders_app_env_check" CHECK ("proxy_host_folders"."app_environment_id" IS NULL OR "proxy_host_folders"."app_id" IS NOT NULL);