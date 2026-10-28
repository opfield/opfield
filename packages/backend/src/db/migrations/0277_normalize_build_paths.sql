CREATE FUNCTION pg_temp.normalize_build_path(path text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN path IS NULL THEN NULL ELSE coalesce(nullif(array_to_string(array(
    SELECT segment FROM unnest(string_to_array(path, '/')) WITH ORDINALITY AS parts(segment, position)
    WHERE segment NOT IN ('', '.') ORDER BY position
  ), '/'), ''), '.') END
$$;--> statement-breakpoint
UPDATE "docker_source_bindings" SET
  "dockerfile_path" = pg_temp.normalize_build_path("dockerfile_path"),
  "context_path" = pg_temp.normalize_build_path("context_path"),
  "compose_file_path" = pg_temp.normalize_build_path("compose_file_path"),
  "application_root" = pg_temp.normalize_build_path("application_root"),
  "artifact_directory" = pg_temp.normalize_build_path("artifact_directory")
WHERE ("dockerfile_path", "context_path", "compose_file_path", "application_root", "artifact_directory")
  IS DISTINCT FROM (
    pg_temp.normalize_build_path("dockerfile_path"),
    pg_temp.normalize_build_path("context_path"),
    pg_temp.normalize_build_path("compose_file_path"),
    pg_temp.normalize_build_path("application_root"),
    pg_temp.normalize_build_path("artifact_directory")
  );--> statement-breakpoint
UPDATE "docker_builds" SET
  "dockerfile_path" = pg_temp.normalize_build_path("dockerfile_path"),
  "context_path" = pg_temp.normalize_build_path("context_path"),
  "application_root" = pg_temp.normalize_build_path("application_root"),
  "artifact_directory" = pg_temp.normalize_build_path("artifact_directory")
WHERE ("dockerfile_path", "context_path", "application_root", "artifact_directory")
  IS DISTINCT FROM (
    pg_temp.normalize_build_path("dockerfile_path"),
    pg_temp.normalize_build_path("context_path"),
    pg_temp.normalize_build_path("application_root"),
    pg_temp.normalize_build_path("artifact_directory")
  );--> statement-breakpoint
DROP FUNCTION pg_temp.normalize_build_path(text);
