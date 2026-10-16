-- An inference request on an API source with no price runs; its cost is recorded as unknown (not $0) on the request,
-- its attempts and its ledger rows, and stays outside API budget enforcement. Existing rows were all priced.
ALTER TABLE "inference_request_attempts" ADD COLUMN "cost_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD COLUMN "cost_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_usage_ledger" ADD COLUMN "cost_unknown" boolean DEFAULT false NOT NULL;
