import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Button } from "@/components/ui/button";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import { handleLicenseApiError } from "@/stores/license-paywall";
import type { DockerSourceBinding, DockerSourceTarget } from "@/types";
import { ACTIVE_DOCKER_BUILD_STATUSES } from "./docker-build-status";

/** Why a container source cannot roll back now; null when it can. */
function rollbackBlocked(source: DockerSourceBinding): string | null {
  const builds = source.latestBuilds ?? (source.latestBuild ? [source.latestBuild] : []);
  if (builds.some((build) => ACTIVE_DOCKER_BUILD_STATUSES.has(build.status))) {
    return "A build is running. Roll back once it finishes.";
  }
  if (!source.rollbackBuild) {
    return "No previous build is kept. To run older code, push a revert commit.";
  }
  return null;
}

/**
 * The Delivery status row that runs the build the container ran before again (the registry keeps that one build),
 * after a confirmation naming the commit it goes back to.
 */
export function DockerSourceRollbackRow({
  target,
  source,
  onRolledBack,
}: {
  target: Extract<DockerSourceTarget, { kind: "container" }>;
  source: DockerSourceBinding;
  onRolledBack: (source: DockerSourceBinding) => void;
}) {
  const [rollingBack, setRollingBack] = useState(false);
  const blocked = rollbackBlocked(source);
  const commit = source.rollbackBuild?.commitSha.slice(0, 12);

  const rollBack = async () => {
    const build = source.rollbackBuild;
    if (blocked || !build) return;
    const accepted = await confirm({
      title: "Roll Back Container",
      description: `Run commit ${build.commitSha.slice(0, 12)} again? The container is recreated from that build with its current settings. It stays on it until the next new commit is built and deployed.`,
      confirmLabel: "Roll back",
      variant: "default",
    });
    if (!accepted) return;
    setRollingBack(true);
    try {
      const result = await api.rollbackDockerSource(target, { buildId: build.id });
      onRolledBack(result.source);
      toast.success(`Rolled back to commit ${result.build.commitSha.slice(0, 12)}`);
    } catch (error) {
      if (!handleLicenseApiError(error, "Git push-to-deploy")) {
        toastApiError(error, "Failed to roll back");
      }
    } finally {
      setRollingBack(false);
    }
  };

  return (
    <SettingsControlRow
      title="Roll back"
      description={blocked ?? `Run commit ${commit} again, the build this container ran before.`}
      help="The internal registry keeps the build a container runs and one previous build. Rolling back runs the previous one again; rolling back once more returns to the newer one."
    >
      <Button
        variant="outline"
        onClick={() => void rollBack()}
        pending={rollingBack}
        disabled={Boolean(blocked)}
        title={blocked ?? undefined}
      >
        <RotateCcw className="h-4 w-4" />
        Roll back
      </Button>
    </SettingsControlRow>
  );
}
