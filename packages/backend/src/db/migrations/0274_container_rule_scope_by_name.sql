-- Container alert rules are scoped by container name, the identity every container alert is keyed by. A rule scoped
-- over the API by a runtime container id (the full id or a prefix of at least 12 characters) gets the name of the
-- container that id belongs to; ids that match no known container stay as they are.
UPDATE "notification_alert_rules" AS r
SET
	"resource_ids" = (
		SELECT coalesce(jsonb_agg(DISTINCT scoped.value), '[]'::jsonb)
		FROM (
			SELECT coalesce(
				(
					SELECT d."resource_key"
					FROM "docker_access_resources" AS d
					WHERE d."resource_type" = 'container'
						AND d."runtime_id" IS NOT NULL
						AND (d."runtime_id" = e.value OR (e.value ~ '^[0-9a-f]{12,64}$' AND d."runtime_id" LIKE e.value || '%'))
					ORDER BY d."updated_at" DESC
					LIMIT 1
				),
				e.value
			) AS value
			FROM jsonb_array_elements_text(r."resource_ids") AS e(value)
		) AS scoped
	),
	"updated_at" = now()
WHERE r."category" = 'container'
	AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements_text(r."resource_ids") AS e(value)
		JOIN "docker_access_resources" AS d
			ON d."resource_type" = 'container'
			AND d."runtime_id" IS NOT NULL
			AND (d."runtime_id" = e.value OR (e.value ~ '^[0-9a-f]{12,64}$' AND d."runtime_id" LIKE e.value || '%'))
	);
