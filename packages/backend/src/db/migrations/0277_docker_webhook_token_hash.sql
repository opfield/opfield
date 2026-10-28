-- Docker and deployment webhook tokens are stored as SHA-256 hashes, like every other credential. The URL is shown
-- once, when the webhook is created or its token regenerated. Existing plaintext tokens are hashed here, so the URLs
-- that CI already calls keep working, and the plaintext is removed.
ALTER TABLE "docker_webhooks" ADD COLUMN "token_hash" text;--> statement-breakpoint
UPDATE "docker_webhooks" SET "token_hash" = encode(sha256(convert_to("token"::text, 'UTF8')), 'hex') WHERE "token" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_webhooks" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
UPDATE "docker_webhooks" SET "token" = NULL WHERE "token_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "docker_webhooks_token_hash_idx" ON "docker_webhooks" USING btree ("token_hash");
