-- A key-value store's automatic AOF rewrite percentage of 0 turned the rewrite off: the append-only file then grew with
-- every write until the disk was full. The API no longer accepts it; stored zeros become the default 100, which the
-- node applies at the store's next start (the node also treats 0 as 100).
UPDATE "managed_database_instances"
SET "engine_config" = jsonb_set("engine_config", '{redisConfig,autoAofRewritePercentage}', '100'::jsonb)
WHERE "type" = 'redis'
  AND jsonb_typeof("engine_config" -> 'redisConfig' -> 'autoAofRewritePercentage') = 'number'
  AND ("engine_config" -> 'redisConfig' ->> 'autoAofRewritePercentage')::numeric = 0;
