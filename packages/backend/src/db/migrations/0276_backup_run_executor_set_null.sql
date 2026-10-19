ALTER TABLE "backup_runs" DROP CONSTRAINT "backup_runs_executor_node_id_nodes_id_fk";
--> statement-breakpoint
ALTER TABLE "backup_runs" ALTER COLUMN "executor_node_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_executor_node_id_nodes_id_fk" FOREIGN KEY ("executor_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;