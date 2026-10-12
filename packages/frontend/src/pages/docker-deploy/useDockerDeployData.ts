import { useEffect, useState } from "react";
import { useDialogPresence } from "@/components/ui/dialog";
import { isInternalAvailabilityImage, isUserDockerRegistry } from "@/lib/docker-image-visibility";
import { api } from "@/services/api";
import type { DockerBuildAdmissionStatus, DockerRegistry, Node } from "@/types";
import type { DockerDeploySourceMode } from "./types";
import { useDockerSourceRepositories } from "./useDockerSourceRepositories";

interface UseDockerDeployDataOptions {
  allNodes: Node[];
  deployNodeId: string;
  hasScope: (scope: string) => boolean;
  open: boolean;
  sourceConnectorId: string;
  sourceMode: DockerDeploySourceMode;
}

function extractTags(data: unknown): string[] {
  const tags: string[] = [];
  for (const img of Array.isArray(data) ? data : []) {
    for (const tag of (img as any).repoTags ?? (img as any).RepoTags ?? []) {
      if (tag && tag !== "<none>:<none>" && !isInternalAvailabilityImage(tag)) tags.push(tag);
    }
  }
  return tags;
}

export function useDockerDeployData({
  allNodes,
  deployNodeId,
  hasScope,
  open,
  sourceConnectorId,
  sourceMode,
}: UseDockerDeployDataOptions) {
  // Loaded lists stay while the dialog closes; they are dropped once it is gone.
  const present = useDialogPresence(open);
  const [registries, setRegistries] = useState<DockerRegistry[]>([]);
  const [registriesLoaded, setRegistriesLoaded] = useState(false);
  const [deployLocalImages, setDeployLocalImages] = useState<string[]>([]);
  // The node whose local images are listed, so the dialog can wait for the preselected node's list.
  const [localImagesNodeId, setLocalImagesNodeId] = useState<string | null>(null);
  const [deployPullableImages, setDeployPullableImages] = useState<string[]>([]);
  const [sourceAdmission, setSourceAdmission] = useState<DockerBuildAdmissionStatus | null>(null);
  const [checkingSourceAdmission, setCheckingSourceAdmission] = useState(false);
  const {
    connectorOptions: sourceConnectorOptions,
    repositories: sourceRepositories,
    loadErrors: sourceLoadErrors,
    repositoriesLoading: sourceRepositoriesLoading,
    repositoriesHint: sourceRepositoriesHint,
    onRepositorySearch: onSourceRepositorySearch,
  } = useDockerSourceRepositories(present && sourceMode === "repository", sourceConnectorId);

  const canViewRegistries = hasScope("docker:registries:view");
  useEffect(() => {
    if (!present || !canViewRegistries) {
      setRegistries([]);
      setRegistriesLoaded(false);
      return;
    }
    let cancelled = false;
    api
      .listDockerRegistries()
      .then((items) => {
        if (!cancelled) setRegistries(items.filter(isUserDockerRegistry));
      })
      .catch(() => {
        if (!cancelled) setRegistries([]);
      })
      .finally(() => {
        if (!cancelled) setRegistriesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [canViewRegistries, present]);

  useEffect(() => {
    if (!present || sourceMode !== "repository" || !deployNodeId) {
      setSourceAdmission(null);
      setCheckingSourceAdmission(false);
      return;
    }
    let cancelled = false;
    setCheckingSourceAdmission(true);
    void api
      .getDockerBuildAdmission(deployNodeId)
      .then((status) => {
        if (!cancelled) setSourceAdmission(status);
      })
      .catch((error) => {
        if (!cancelled) {
          setSourceAdmission({
            ready: false,
            code: "BUILD_ADMISSION_CHECK_FAILED",
            message:
              error instanceof Error ? error.message : "Build capacity could not be verified",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setCheckingSourceAdmission(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deployNodeId, present, sourceMode]);

  useEffect(() => {
    if (!deployNodeId) {
      setDeployLocalImages([]);
      setDeployPullableImages([]);
      return;
    }
    let cancelled = false;
    api
      .listDockerImages(deployNodeId)
      .then((data) => {
        if (!cancelled) setDeployLocalImages(extractTags(data).sort());
      })
      .catch(() => {
        if (!cancelled) setDeployLocalImages([]);
      })
      .finally(() => {
        if (!cancelled) setLocalImagesNodeId(deployNodeId);
      });

    const cancel = () => {
      cancelled = true;
    };
    if (!hasScope("docker:images:pull") && !hasScope(`docker:images:pull:${deployNodeId}`)) {
      setDeployPullableImages([]);
      return cancel;
    }
    const otherNodes = allNodes.filter((node) => node.id !== deployNodeId);
    if (otherNodes.length === 0) {
      setDeployPullableImages([]);
      return cancel;
    }
    Promise.all(
      otherNodes.map((node) =>
        api
          .listDockerImages(node.id)
          .then(extractTags)
          .catch(() => [] as string[])
      )
    ).then((results) => {
      const localSet = new Set<string>();
      api
        .listDockerImages(deployNodeId)
        .then((data) => {
          for (const tag of extractTags(data)) localSet.add(tag);
          const pullable = new Set<string>();
          for (const tags of results) {
            for (const tag of tags) {
              if (!localSet.has(tag)) pullable.add(tag);
            }
          }
          if (!cancelled) setDeployPullableImages(Array.from(pullable).sort());
        })
        .catch(() => {});
    });
    return cancel;
  }, [allNodes, deployNodeId, hasScope]);

  // Options the dialog's first render depends on. Pullable images from other nodes stay a background
  // suggestion list: it fans out to every node and only adds entries to the image picker.
  const initialLoading =
    present &&
    ((canViewRegistries && !registriesLoaded) ||
      (!!deployNodeId && localImagesNodeId !== deployNodeId));

  return {
    checkingSourceAdmission,
    initialLoading,
    deployLocalImages,
    deployPullableImages,
    registries,
    sourceAdmission,
    sourceConnectorOptions,
    sourceLoadErrors,
    sourceRepositories,
    sourceRepositoriesLoading,
    sourceRepositoriesHint,
    onSourceRepositorySearch,
  };
}
