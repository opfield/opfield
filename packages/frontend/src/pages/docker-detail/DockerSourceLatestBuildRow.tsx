import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import type { DockerSourceBinding } from "@/types";
import { DOCKER_BUILD_STATUS_VARIANT } from "./docker-build-status";

/**
 * The Delivery status row of the latest build: its status and the source's plain state, so a source with nothing
 * deployed says why (a failed build, a vulnerability policy rejection and what would admit the image).
 */
export function DockerSourceLatestBuildRow({ source }: { source: DockerSourceBinding }) {
  if (!source.state) return null;
  const builds = source.latestBuilds ?? (source.latestBuild ? [source.latestBuild] : []);
  const shown = builds.find((build) => build.status === "failed") ?? builds[0];
  return (
    <SettingsControlRow title="Latest build" description={source.state}>
      {shown ? (
        <Badge variant={DOCKER_BUILD_STATUS_VARIANT[shown.status]}>
          {shown.status.replaceAll("_", " ")}
        </Badge>
      ) : (
        <Badge variant="secondary">No build</Badge>
      )}
    </SettingsControlRow>
  );
}
