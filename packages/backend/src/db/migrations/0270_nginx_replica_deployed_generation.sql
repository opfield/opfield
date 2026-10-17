-- The generation a node acknowledged with its last deploy of a certificate replica. Removing a deleted route's
-- certificate names it: the tombstone raises the row's generation above what the node holds, and the node refused
-- every removal. Existing rows stay NULL; their removal tries the generations below the tombstone.
ALTER TABLE "nginx_certificate_replicas" ADD COLUMN IF NOT EXISTS "deployed_generation" integer;
