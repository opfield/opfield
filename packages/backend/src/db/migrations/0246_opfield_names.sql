-- Opfield names for what the database stored under the former product name (2.12.1). Tables and columns are renamed;
-- stored values are rewritten so the code reads only the new names: the settings scopes, the alert category and its
-- resources, notification template variables, the system user, the built-in outbound alert rule (only while it still
-- has the seeded text), queued SIEM events, the AI provider type and settings, and stored assistant tool names.
-- The update sidecar restores the pre-update dump if the update fails, so nothing here has to stay readable by 2.12.0.
ALTER TABLE "gateway_diagnostics_samples" RENAME TO "opfield_diagnostics_samples";--> statement-breakpoint
ALTER TABLE "opfield_diagnostics_samples" RENAME CONSTRAINT "gateway_diagnostics_samples_pkey" TO "opfield_diagnostics_samples_pkey";--> statement-breakpoint
ALTER TABLE "permission_groups" RENAME COLUMN "require_gateway_2fa" TO "require_2fa";--> statement-breakpoint
ALTER TABLE "relay_pools" RENAME COLUMN "gateway_host_identity_id" TO "host_identity_id";--> statement-breakpoint
ALTER TABLE "relay_policy_state" RENAME COLUMN "gateway_instance_id" TO "instance_id";--> statement-breakpoint
ALTER FUNCTION gateway_page_preview_hash() RENAME TO opfield_page_preview_hash;--> statement-breakpoint

-- Scopes: settings:gateway:view|edit became settings:opfield:view|edit (bare or qualified).
UPDATE "permission_groups" SET "scopes" = replace("scopes"::text, '"settings:gateway:', '"settings:opfield:')::jsonb, "updated_at" = now()
WHERE "scopes"::text LIKE '%"settings:gateway:%';--> statement-breakpoint
UPDATE "users" SET "additional_scopes" = replace("additional_scopes"::text, '"settings:gateway:', '"settings:opfield:')::jsonb, "updated_at" = now()
WHERE "additional_scopes"::text LIKE '%"settings:gateway:%';--> statement-breakpoint
UPDATE "api_tokens" SET "scopes" = replace("scopes"::text, '"settings:gateway:', '"settings:opfield:')::jsonb
WHERE "scopes"::text LIKE '%"settings:gateway:%';--> statement-breakpoint
UPDATE "oauth_authorization_codes" SET
  "scopes" = replace("scopes"::text, '"settings:gateway:', '"settings:opfield:')::jsonb,
  "requested_scopes" = replace("requested_scopes"::text, '"settings:gateway:', '"settings:opfield:')::jsonb
WHERE "scopes"::text LIKE '%"settings:gateway:%' OR "requested_scopes"::text LIKE '%"settings:gateway:%';--> statement-breakpoint
UPDATE "oauth_refresh_tokens" SET "scopes" = replace("scopes"::text, '"settings:gateway:', '"settings:opfield:')::jsonb
WHERE "scopes"::text LIKE '%"settings:gateway:%';--> statement-breakpoint
UPDATE "oauth_access_tokens" SET "scopes" = replace("scopes"::text, '"settings:gateway:', '"settings:opfield:')::jsonb
WHERE "scopes"::text LIKE '%"settings:gateway:%';--> statement-breakpoint
UPDATE "ai_run_tool_calls" SET "required_scopes" = replace("required_scopes"::text, '"settings:gateway:', '"settings:opfield:')::jsonb
WHERE "required_scopes"::text LIKE '%"settings:gateway:%';--> statement-breakpoint
UPDATE "sandbox_jobs" SET "required_scopes" = replace("required_scopes"::text, '"settings:gateway:', '"settings:opfield:')::jsonb
WHERE "required_scopes"::text LIKE '%"settings:gateway:%';--> statement-breakpoint

-- Alerts about Opfield itself: category, resource type, resource ids (`gateway`, `gateway-postgres`, `gateway-relay`,
-- `gateway-relay-instance:<id>`, `gateway-container:<service>`, ...) and the folded-under kind.
CREATE FUNCTION opfield_resource_id_0246(id text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN id = 'gateway' THEN 'opfield'
    WHEN id LIKE 'gateway-%' THEN 'opfield-' || substr(id, 9)
    ELSE id
  END
$$;--> statement-breakpoint
UPDATE "notification_alert_rules" SET
  "category" = 'opfield',
  "resource_ids" = coalesce(
    (SELECT jsonb_agg(opfield_resource_id_0246("rid"."value") ORDER BY "rid"."ordinality")
     FROM jsonb_array_elements_text(coalesce("resource_ids", '[]'::jsonb)) WITH ORDINALITY AS "rid"("value", "ordinality")),
    '[]'::jsonb
  ),
  "updated_at" = now()
WHERE "category" = 'gateway';--> statement-breakpoint
UPDATE "notification_alert_states" SET
  "resource_type" = 'opfield',
  "resource_id" = opfield_resource_id_0246("resource_id")
WHERE "resource_type" = 'gateway';--> statement-breakpoint
UPDATE "notification_alert_states" SET "context" = jsonb_set("context", '{folded,kind}', '"opfield_outbound"')
WHERE "context" #>> '{folded,kind}' = 'gateway_outbound';--> statement-breakpoint
DROP FUNCTION opfield_resource_id_0246(text);--> statement-breakpoint

-- The built-in outbound alert rule (0235) keeps an operator's own name and text.
UPDATE "notification_alert_rules" SET "name" = 'Opfield lost outbound connectivity', "updated_at" = now()
WHERE "is_builtin" AND "event_pattern" = 'outbound.unavailable' AND "name" = 'Gateway lost outbound connectivity';--> statement-breakpoint
UPDATE "notification_alert_rules" SET
  "message_template" = 'Opfield cannot reach {{details.targets}}. Route alerts this explains are folded into this alert, and notifications wait until Opfield can send them.',
  "updated_at" = now()
WHERE "is_builtin" AND "event_pattern" = 'outbound.unavailable'
  AND "message_template" = 'Gateway cannot reach {{details.targets}}. Route alerts this explains are folded into this alert, and notifications wait until Gateway can send them.';--> statement-breakpoint

-- Template variable {{gateway.url}} (and {{{json gateway}}} in the JSON preset) is {{opfield.url}} / {{{json opfield}}}.
UPDATE "notification_webhooks" SET
  "body_template" = regexp_replace("body_template", '(\{\{[^}]*?)\ygateway\y', '\1opfield', 'g'),
  "updated_at" = now()
WHERE "body_template" ~ '\{\{[^}]*?\ygateway\y';--> statement-breakpoint
UPDATE "notification_alert_rules" SET
  "message_template" = regexp_replace("message_template", '(\{\{[^}]*?)\ygateway\y', '\1opfield', 'g'),
  "resolve_message_template" = regexp_replace("resolve_message_template", '(\{\{[^}]*?)\ygateway\y', '\1opfield', 'g'),
  "updated_at" = now()
WHERE "message_template" ~ '\{\{[^}]*?\ygateway\y' OR "resolve_message_template" ~ '\{\{[^}]*?\ygateway\y';--> statement-breakpoint

-- The system user that owns bootstrap resources.
UPDATE "users" SET
  "oidc_subject" = 'system:opfield-setup',
  "name" = CASE WHEN "name" = 'Gateway System' THEN 'Opfield System' ELSE "name" END,
  "email" = CASE WHEN "email" = 'system@gateway.local' THEN 'system@opfield.local' ELSE "email" END,
  "updated_at" = now()
WHERE "oidc_subject" = 'system:gateway-setup';--> statement-breakpoint

-- SIEM events already queued carry the new event type and source.
UPDATE "siem_deliveries" SET
  "payload" = jsonb_set(
    jsonb_set("payload", '{type}', to_jsonb(CASE "payload"->>'type'
      WHEN 'com.wiolett.gateway.audit.test.v1' THEN 'dev.opfield.audit.test.v1'
      ELSE 'dev.opfield.audit.v1' END)),
    '{source}',
    to_jsonb(regexp_replace(coalesce("payload"->>'source', 'urn:opfield'), '^urn:wiolett:gateway', 'urn:opfield'))
  ),
  "updated_at" = now()
WHERE "payload"->>'type' LIKE 'com.wiolett.gateway.%';--> statement-breakpoint

-- AI Workspace provider "Opfield Inference": provider type value and its two settings keys.
UPDATE "settings" SET "value" = '"opfield_inference"'::jsonb, "updated_at" = now()
WHERE "key" = 'ai:provider_type' AND "value" = '"gateway_inference"'::jsonb;--> statement-breakpoint
INSERT INTO "settings" ("key", "value", "updated_at")
SELECT replace("key", 'ai:gateway_inference_', 'ai:opfield_inference_'), "value", now()
FROM "settings"
WHERE "key" IN ('ai:gateway_inference_model', 'ai:gateway_inference_allow_user_model_selection')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
DELETE FROM "settings" WHERE "key" IN ('ai:gateway_inference_model', 'ai:gateway_inference_allow_user_model_selection');--> statement-breakpoint

-- General settings keep the gRPC targets under their new keys.
UPDATE "settings" SET
  "value" = ("value" - 'gatewayGrpcPublicTarget' - 'gatewayGrpcLocalIp')
    || CASE WHEN "value" ? 'gatewayGrpcPublicTarget' THEN jsonb_build_object('grpcPublicTarget', "value"->'gatewayGrpcPublicTarget') ELSE '{}'::jsonb END
    || CASE WHEN "value" ? 'gatewayGrpcLocalIp' THEN jsonb_build_object('grpcLocalIp', "value"->'gatewayGrpcLocalIp') ELSE '{}'::jsonb END,
  "updated_at" = now()
WHERE "key" = 'general:settings' AND jsonb_typeof("value") = 'object'
  AND ("value" ? 'gatewayGrpcPublicTarget' OR "value" ? 'gatewayGrpcLocalIp');--> statement-breakpoint

-- Assistant tools renamed from *_gateway_* to *_opfield_*: runs paused or in flight resume by tool name, and the
-- disabled-tools setting lists exact names.
CREATE FUNCTION opfield_ai_tool_names_0246(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(t,
    'read_gateway_documentation', 'read_opfield_documentation'),
    'manage_gateway_diagnostics', 'manage_opfield_diagnostics'),
    'get_gateway_settings', 'get_opfield_settings'),
    'update_gateway_settings', 'update_opfield_settings'),
    'get_gateway_status', 'get_opfield_status'),
    'acknowledge_gateway_update_failure', 'acknowledge_opfield_update_failure'),
    'perform_gateway_update', 'perform_opfield_update'),
    'proceed_gateway_update', 'proceed_opfield_update'),
    'get_gateway_release_notes', 'get_opfield_release_notes'),
    'list_gateway_release_notes', 'list_opfield_release_notes'),
    'check_gateway', 'check_opfield')
$$;--> statement-breakpoint
UPDATE "ai_conversation_messages" SET
  "tool_name" = opfield_ai_tool_names_0246("tool_name"),
  "ui_message" = opfield_ai_tool_names_0246("ui_message"::text)::jsonb,
  "tool_calls" = opfield_ai_tool_names_0246("tool_calls"::text)::jsonb,
  "tool_args_compact" = opfield_ai_tool_names_0246("tool_args_compact"::text)::jsonb,
  "tool_result_raw" = opfield_ai_tool_names_0246("tool_result_raw"::text)::jsonb,
  "tool_result_compact" = opfield_ai_tool_names_0246("tool_result_compact"::text)::jsonb
WHERE concat_ws(' ', "tool_name", "ui_message"::text, "tool_calls"::text, "tool_args_compact"::text,
  "tool_result_raw"::text, "tool_result_compact"::text) ~ '(read|manage|get|update|check|perform|proceed|acknowledge|list)_gateway';--> statement-breakpoint
UPDATE "ai_run_tool_calls" SET
  "tool_name" = opfield_ai_tool_names_0246("tool_name"),
  "tool_args" = opfield_ai_tool_names_0246("tool_args"::text)::jsonb,
  "result" = opfield_ai_tool_names_0246("result"::text)::jsonb
WHERE concat_ws(' ', "tool_name", "tool_args"::text, "result"::text) ~ '(read|manage|get|update|check|perform|proceed|acknowledge|list)_gateway';--> statement-breakpoint
UPDATE "ai_run_tool_rounds" SET "provider_messages" = opfield_ai_tool_names_0246("provider_messages"::text)::jsonb
WHERE "provider_messages"::text ~ '(read|manage|get|update|check|perform|proceed|acknowledge|list)_gateway';--> statement-breakpoint
UPDATE "ai_conversations" SET "checkpoint" = opfield_ai_tool_names_0246("checkpoint"::text)::jsonb
WHERE "checkpoint"::text ~ '(read|manage|get|update|check|perform|proceed|acknowledge|list)_gateway';--> statement-breakpoint
UPDATE "settings" SET "value" = opfield_ai_tool_names_0246("value"::text)::jsonb, "updated_at" = now()
WHERE "key" = 'ai:disabled_tools' AND "value"::text ~ '(read|manage|get|update|check|perform|proceed|acknowledge|list)_gateway';--> statement-breakpoint
DROP FUNCTION opfield_ai_tool_names_0246(text);
