-- Usage of each user that housekeeping removes with settled inference requests older than the retention period
-- (Housekeeping, Inference Usage), so the lifetime figure still counts it.
CREATE TABLE IF NOT EXISTS "inference_usage_lifetime_totals" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	"credits" numeric(24, 6) DEFAULT '0' NOT NULL,
	"api_microdollars" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "inference_usage_lifetime_totals" ADD CONSTRAINT "inference_usage_lifetime_totals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
