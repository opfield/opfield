-- A node with Docker migration history can be deleted: the history keeps the ids of the nodes it ran between, so it
-- stays readable after one of them is gone (the restrict foreign keys of 0063 made the node delete fail).
ALTER TABLE "docker_migrations" DROP CONSTRAINT "docker_migrations_source_node_id_nodes_id_fk";--> statement-breakpoint
ALTER TABLE "docker_migrations" DROP CONSTRAINT "docker_migrations_target_node_id_nodes_id_fk";
