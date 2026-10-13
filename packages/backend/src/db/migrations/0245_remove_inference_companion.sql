-- The desktop inference companion (@sqgateway/inference) and its setup API are removed.
-- Its OAuth grants were bound to the setup resource and carry only inference:setup.
DELETE FROM "oauth_access_tokens"
WHERE "scopes" ? 'inference:setup' OR "resource" LIKE '%/api/inference/setup';
--> statement-breakpoint
DELETE FROM "oauth_refresh_tokens"
WHERE "scopes" ? 'inference:setup' OR "resource" LIKE '%/api/inference/setup';
--> statement-breakpoint
DELETE FROM "oauth_authorization_codes"
WHERE "scopes" ? 'inference:setup' OR "resource" LIKE '%/api/inference/setup';
--> statement-breakpoint
-- Tokens the companion issued stay valid as ordinary inference tokens; only the companion bookkeeping goes.
DROP INDEX IF EXISTS "inference_tokens_managed_identity_active_unique";
--> statement-breakpoint
ALTER TABLE "inference_tokens" DROP COLUMN IF EXISTS "managed_by";
--> statement-breakpoint
ALTER TABLE "inference_tokens" DROP COLUMN IF EXISTS "harness";
--> statement-breakpoint
ALTER TABLE "inference_tokens" DROP COLUMN IF EXISTS "device_name";
--> statement-breakpoint
ALTER TABLE "inference_tokens" DROP COLUMN IF EXISTS "installation_id";
--> statement-breakpoint
-- Vision sidecar sources of the removed inference sidecars: no path creates them, and nothing routes to them.
DELETE FROM "inference_model_sources"
WHERE "metadata" -> 'composition' ->> 'role' = 'vision_sidecar';
--> statement-breakpoint
UPDATE "inference_model_sources"
SET "metadata" = "metadata" - 'composition'
WHERE "metadata" ? 'composition';
