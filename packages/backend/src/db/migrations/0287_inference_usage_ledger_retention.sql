-- Housekeeping removes inference usage records past the retention period after adding them to the lifetime totals,
-- but the ledger's trigger refused every delete, so the Inference Usage cleanup failed as soon as the first records
-- reached that age. The ledger stays append-only: an update is always refused, and a delete passes only inside a
-- transaction that set opfield.inference_usage_retention, which only that cleanup does. The function gets its
-- Opfield name; the trigger keeps pointing at it.
ALTER FUNCTION "gateway_reject_inference_usage_ledger_mutation"() RENAME TO "opfield_guard_inference_usage_ledger";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "opfield_guard_inference_usage_ledger"() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' AND coalesce(current_setting('opfield.inference_usage_retention', true), '') = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'inference_usage_ledger is append-only';
END;
$$ LANGUAGE plpgsql;
