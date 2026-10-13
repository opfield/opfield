ALTER TABLE "users" ADD COLUMN "blocked_by" varchar(32);--> statement-breakpoint
UPDATE "users" SET "blocked_by" = 'admin' WHERE "is_blocked" = true;
