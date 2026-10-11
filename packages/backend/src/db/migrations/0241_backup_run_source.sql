ALTER TABLE "backup_runs" ADD COLUMN "source_member_id" uuid;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "source_node_id" uuid;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "source_role" varchar(16);