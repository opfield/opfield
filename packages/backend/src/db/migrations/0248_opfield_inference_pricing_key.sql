-- Discovered inference models kept the provider-reported price under the metadata key named after the former product
-- (2.12.1). The key is renamed in place, so the code reads only the new one; the next model sync writes it anyway.
-- The update sidecar restores the pre-update dump if the update fails, so 2.12.0 never reads the new key.
UPDATE "inference_discovered_models"
SET "metadata" = ("metadata" - 'gatewayPricing') || jsonb_build_object('opfieldPricing', "metadata" -> 'gatewayPricing'),
  "updated_at" = now()
WHERE "metadata" ? 'gatewayPricing';
