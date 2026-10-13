-- An Availability copy on a node other than its workload's runs under runtime names derived from its placement.
-- Placements created from 2.12.1 on use the opfav prefix; every placement that exists already keeps gwav, the names
-- its containers, networks and Compose projects have.
ALTER TABLE "docker_availability_placements" ADD COLUMN "runtime_name_prefix" varchar(16) DEFAULT 'gwav' NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_availability_placements" ALTER COLUMN "runtime_name_prefix" SET DEFAULT 'opfav';
