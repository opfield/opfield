CREATE TYPE "public"."access_identity_provider_kind" AS ENUM('google', 'oidc');--> statement-breakpoint
CREATE TYPE "public"."access_signing_key_status" AS ENUM('active', 'verification_only', 'retired');--> statement-breakpoint
CREATE TABLE "access_identity_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "access_identity_provider_kind" NOT NULL,
	"name" varchar(64) NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"scopes" text DEFAULT 'openid email profile' NOT NULL,
	"groups_claim" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_service_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"secret_sha256" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "access_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"method" varchar(80) NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"name" text,
	"groups" text[] DEFAULT '{}' NOT NULL,
	"access_list_id" uuid,
	"client_ip" varchar(64),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "access_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" varchar(64) NOT NULL,
	"public_key" text NOT NULL,
	"encrypted_private_key" text,
	"encrypted_dek" text,
	"status" "access_signing_key_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"verify_until" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN "sign_in_methods" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN "users" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN "shared_password_hash" text;--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN "skip_ip_ranges" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN "include_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN "require_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN "exclude_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "access_lists" ADD COLUMN "session_ttl_seconds" integer;--> statement-breakpoint
ALTER TABLE "access_service_tokens" ADD CONSTRAINT "access_service_tokens_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_sessions" ADD CONSTRAINT "access_sessions_access_list_id_access_lists_id_fk" FOREIGN KEY ("access_list_id") REFERENCES "public"."access_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_service_tokens_client_id_unique" ON "access_service_tokens" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "access_sessions_expires_idx" ON "access_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "access_signing_keys_key_id_unique" ON "access_signing_keys" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_signing_keys_single_active_idx" ON "access_signing_keys" USING btree ("status") WHERE "access_signing_keys"."status" = 'active';--> statement-breakpoint
-- What a deny rule still denied: `range` without the addresses earlier allow rules let in (nginx took the first
-- rule that matched). A partly covered range splits into its two halves until each half is in or out.
CREATE FUNCTION "opfield_0277_cidr_minus"("range" inet, "covers" inet[]) RETURNS inet[] LANGUAGE plpgsql AS $$
DECLARE
  "cover" inet;
  "overlaps" boolean := false;
  "half" inet;
BEGIN
  FOREACH "cover" IN ARRAY "covers" LOOP
    CONTINUE WHEN family("cover") <> family("range");
    IF "range" <<= "cover" THEN
      RETURN '{}'::inet[];
    END IF;
    IF "cover" <<= "range" THEN
      "overlaps" := true;
    END IF;
  END LOOP;
  IF NOT "overlaps" THEN
    RETURN ARRAY["range"];
  END IF;
  "half" := set_masklen("range", masklen("range") + 1);
  RETURN "opfield_0277_cidr_minus"("half", "covers")
    || "opfield_0277_cidr_minus"(set_masklen(broadcast("half") + 1, masklen("half")), "covers");
END $$;
--> statement-breakpoint
-- Old lists keep their behaviour. nginx checked the IP rules in order up to the first `all` rule and
-- denied what matched none (no rules: everyone); basic authentication applied on top (satisfy all).
DO $$
DECLARE
  list record;
  rule jsonb;
  rule_type text;
  rule_value text;
  allows text[];
  allow_ranges inet[];
  denies text[];
  deny_range inet;
  pieces inet[];
  piece inet;
  all_allowed boolean;
  ip_restricted boolean;
BEGIN
  FOR list IN SELECT "id", "ip_rules", "basic_auth_enabled", "basic_auth_users" FROM "access_lists" LOOP
    allows := '{}';
    allow_ranges := '{}';
    denies := '{}';
    all_allowed := false;
    FOR rule IN SELECT value FROM jsonb_array_elements(list."ip_rules") LOOP
      rule_type := rule->>'type';
      rule_value := btrim(rule->>'value');
      IF lower(rule_value) = 'all' THEN
        all_allowed := rule_type = 'allow';
        EXIT;
      END IF;
      IF rule_type = 'allow' THEN
        allows := array_append(allows, rule_value);
        BEGIN
          allow_ranges := array_append(allow_ranges, network(rule_value::inet)::inet);
        EXCEPTION WHEN others THEN
          NULL;
        END;
      ELSE
        -- Only the addresses no earlier allow rule let in; the rule as written when none overlaps it.
        BEGIN
          deny_range := network(rule_value::inet)::inet;
          pieces := "opfield_0277_cidr_minus"(deny_range, allow_ranges);
          IF cardinality(pieces) = 1 AND masklen(pieces[1]) = masklen(deny_range) THEN
            denies := array_append(denies, rule_value);
          ELSE
            FOREACH piece IN ARRAY pieces LOOP
              denies := array_append(denies, CASE
                WHEN masklen(piece) = CASE WHEN family(piece) = 4 THEN 32 ELSE 128 END THEN host(piece)
                ELSE host(piece) || '/' || masklen(piece) END);
            END LOOP;
          END IF;
        EXCEPTION WHEN others THEN
          denies := array_append(denies, rule_value);
        END;
      END IF;
    END LOOP;
    ip_restricted := jsonb_array_length(list."ip_rules") > 0 AND NOT all_allowed;

    UPDATE "access_lists" SET
      "users" = list."basic_auth_users",
      "exclude_rules" = CASE WHEN cardinality(denies) > 0
        THEN jsonb_build_array(jsonb_build_object('selector', 'ip', 'values', to_jsonb(denies)))
        ELSE '[]'::jsonb END,
      "sign_in_methods" = CASE WHEN list."basic_auth_enabled" THEN ARRAY['basic'] ELSE '{}'::text[] END,
      "skip_ip_ranges" = CASE
        WHEN list."basic_auth_enabled" THEN '{}'::text[]
        WHEN ip_restricted THEN allows
        ELSE ARRAY['0.0.0.0/0', '::/0'] END,
      "include_rules" = CASE WHEN list."basic_auth_enabled"
        THEN jsonb_build_array(jsonb_build_object('selector', 'everyone', 'values', '[]'::jsonb))
        ELSE '[]'::jsonb END,
      "require_rules" = CASE WHEN list."basic_auth_enabled" AND ip_restricted
        THEN jsonb_build_array(jsonb_build_object('selector', 'ip', 'values', to_jsonb(allows)))
        ELSE '[]'::jsonb END
    WHERE "id" = list."id";
  END LOOP;
END $$;
--> statement-breakpoint
DROP FUNCTION "opfield_0277_cidr_minus"(inet, inet[]);
