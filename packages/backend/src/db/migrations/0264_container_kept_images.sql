-- A container whose Git source is detached keeps running the build it ran: that build is kept in the internal
-- registry as the container's own artifact (owner_kind 'container', owner_key container:<node>:<name>) until the
-- container is removed or runs another image. Existing rows are build, Availability or promotion artifacts.
ALTER TABLE "docker_build_artifacts" DROP CONSTRAINT "docker_build_artifacts_owner_check";--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" ADD CONSTRAINT "docker_build_artifacts_owner_check" CHECK ((
        "docker_build_artifacts"."owner_kind" = 'build'
        AND "docker_build_artifacts"."build_id" IS NOT NULL
        AND "docker_build_artifacts"."source_binding_id" IS NOT NULL
        AND "docker_build_artifacts"."owner_key" IS NULL
        AND "docker_build_artifacts"."source_image_reference" IS NULL
      ) OR (
        "docker_build_artifacts"."owner_kind" IN ('availability', 'promotion', 'container')
        AND "docker_build_artifacts"."build_id" IS NULL
        AND "docker_build_artifacts"."source_binding_id" IS NULL
        AND "docker_build_artifacts"."owner_key" IS NOT NULL
        AND "docker_build_artifacts"."source_image_reference" IS NOT NULL
      ));
