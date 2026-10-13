-- A Compose service linked to a managed database reads the link's values through Compose variables named after the
-- link. Links created from 2.12.1 on use OPFIELD_DB_<link>_<name>; every link that exists already keeps
-- GATEWAY_DB_<link>_<name>, the names its stored revisions and project secrets use.
ALTER TABLE "managed_database_bindings" ADD COLUMN "compose_variables_legacy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ALTER COLUMN "compose_variables_legacy" SET DEFAULT false;
