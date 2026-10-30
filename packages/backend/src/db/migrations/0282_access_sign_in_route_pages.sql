-- Visitors sign in on the protected route itself: the sign-in domain and the placement of its system route are gone.
-- The system route of an existing sign-in domain is withdrawn from its node by the access sign-in maintenance job
-- (its node config cannot be removed from here).
UPDATE "settings"
SET "value" = "value" - 'domain' - 'nodeId' - 'ingressGroupId' - 'sslCertificateId', "updated_at" = now()
WHERE "key" = 'access.signIn' AND jsonb_typeof("value") = 'object';
