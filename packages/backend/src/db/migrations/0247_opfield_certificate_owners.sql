-- System certificates of the Opfield listeners and internal services are owned under Opfield names (2.12.1); the
-- enum values carried the former product name. Rows keep their owner. The update sidecar restores the pre-update dump
-- if the update fails, so 2.12.0 never reads these values.
ALTER TYPE "public"."system_certificate_owner_type" RENAME VALUE 'gateway_listener' TO 'opfield_listener';--> statement-breakpoint
ALTER TYPE "public"."system_certificate_owner_type" RENAME VALUE 'gateway_service' TO 'opfield_service';
