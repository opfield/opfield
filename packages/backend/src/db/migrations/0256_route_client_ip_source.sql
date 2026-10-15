-- Client IP source of a route: where nginx takes the client address from (auto: Cloudflare's edge header when a name of
-- the route is a Cloudflare-proxied domain, else the TCP peer). Existing routes get auto.
ALTER TABLE "proxy_hosts" ADD COLUMN "client_ip_source" varchar(16) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "client_ip_options" jsonb;