-- An SSL certificate linked from a PKI certificate that was revoked stayed "active" (rc.3 stand O-7). Revocation now
-- marks it status error with the reason; this applies that to links revoked before the update.
UPDATE "ssl_certificates" AS s
SET
	"status" = 'error',
	"renewal_error" = 'The PKI certificate it links (' || c."common_name" || ') was revoked at '
		|| to_char(COALESCE(c."revoked_at", now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
		|| ': clients that check the CRL refuse it. Issue a new certificate and link it, or give the routes another certificate.',
	"updated_at" = now()
FROM "certificates" AS c
WHERE s."internal_cert_id" = c."id"
	AND c."status" = 'revoked'
	AND s."status" IN ('active', 'pending');
