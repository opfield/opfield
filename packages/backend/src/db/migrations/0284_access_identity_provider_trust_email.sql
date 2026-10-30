-- Access sign-in through an external identity provider: "Trust the provider's email address" (on for existing and new
-- providers) counts an email sent without an email_verified claim as verified; email_verified false never counts.
ALTER TABLE "access_identity_providers" ADD COLUMN "trust_email" boolean DEFAULT true NOT NULL;
