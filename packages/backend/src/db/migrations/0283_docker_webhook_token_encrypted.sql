-- Docker and deployment webhook tokens are kept encrypted next to their hash, so the webhook URL can be shown again.
-- A webhook that migration 0277 reduced to a hash keeps working, but its URL cannot be recovered: the console offers
-- to regenerate it.
ALTER TABLE "docker_webhooks" ADD COLUMN "token_encrypted" text;
