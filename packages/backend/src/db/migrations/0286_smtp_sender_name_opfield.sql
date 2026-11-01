-- The setup wizard used to prefill the sender name with the old product name, so mail still went out under it.
UPDATE "settings"
SET "value" = jsonb_set("value", '{senderName}', '"Opfield"'), "updated_at" = now()
WHERE "key" = 'auth:smtp' AND "value"->>'senderName' = 'Gateway';
