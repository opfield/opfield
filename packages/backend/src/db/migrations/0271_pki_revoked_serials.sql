-- A revoked PKI certificate deleted before it expires stays on its CA's CRL, and OCSP answers "revoked" for it, until
-- it would have expired: deleting a certificate never makes it valid again.
CREATE TABLE IF NOT EXISTS "pki_revoked_serials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ca_id" uuid NOT NULL,
	"serial_number" varchar(255) NOT NULL,
	"revoked_at" timestamp with time zone NOT NULL,
	"revocation_reason" varchar(50),
	"not_after" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "pki_revoked_serials" ADD CONSTRAINT "pki_revoked_serials_ca_id_certificate_authorities_id_fk" FOREIGN KEY ("ca_id") REFERENCES "public"."certificate_authorities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pki_revoked_serials_ca_serial_idx" ON "pki_revoked_serials" USING btree ("ca_id","serial_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pki_revoked_serials_not_after_idx" ON "pki_revoked_serials" USING btree ("not_after");
