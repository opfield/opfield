-- Token limits: an optional expiry and IP allowlist on API and inference tokens, and on OAuth grants (their own expiry
-- next to each token's, and the allowlist every token of the grant carries). Existing tokens get neither: no expiry, any address.
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "allowed_ips" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inference_tokens" ADD COLUMN "allowed_ips" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "grant_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN "allowed_ips" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "grant_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "allowed_ips" jsonb DEFAULT '[]'::jsonb NOT NULL;