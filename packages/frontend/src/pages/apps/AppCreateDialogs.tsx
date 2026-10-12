import { useEffect, useMemo, useRef, useState } from "react";
import type { AppCreateContext } from "@/components/apps/app-create-context";
import { CreateProxyHostDialog } from "@/components/proxy/CreateProxyHostDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type LicenseFeature, requireLicenseFeature } from "@/stores/license-paywall";
import type { AppMemberFamily } from "@/types";
import { ComposeProjectEditor } from "../compose/ComposeProjectEditor";
import { DockerDeployDialog } from "../DockerDeployDialog";
import { DatabaseConnectionCreateDialog } from "../database-create/DatabaseConnectionCreateDialog";
import { ManagedDatabaseCreateDialog } from "../database-create/ManagedDatabaseCreateDialog";
import { AppContainerLinkDialog } from "../docker-detail/AppContainerLinkDialog";
import { CreatePageProjectDialog } from "../pages/CreatePageProjectDialog";
import { ManagedStorageCreateDialog } from "../storage-create/ManagedStorageCreateDialog";
import { StorageConnectionCreateDialog } from "../storage-create/StorageConnectionCreateDialog";

/** What "New" / a section's create action / AddRow asks to create inside an app. */
export type AppCreateType =
  | "container"
  | "compose"
  | "database"
  | "storage"
  | "route"
  | "pages"
  | "container-link";

export interface AppCreateRequest {
  type: AppCreateType;
  /** The environment group the action was started from; else last used / Production. */
  environmentId?: string | null;
  /**
   * Databases and storage: deploy a managed one (default) or connect an existing one
   * ("external": no node field, only App and Environment).
   */
  variant?: "managed" | "external";
}

type DialogKey =
  | "container"
  | "compose"
  | "database-managed"
  | "database-external"
  | "storage-managed"
  | "storage-external"
  | "route"
  | "pages"
  | "container-link";

function dialogKey(request: Pick<AppCreateRequest, "type" | "variant">): DialogKey {
  if (request.type === "database" || request.type === "storage") {
    return `${request.type}-${request.variant === "external" ? "external" : "managed"}`;
  }
  return request.type;
}

/** The license feature a create dialog needs before it opens (the product pages check the same). */
const LICENSE_GATES: Partial<Record<DialogKey, [LicenseFeature, string]>> = {
  compose: ["compose-applications", "Compose projects"],
  "database-managed": ["managed-databases", "Managed databases"],
  "database-external": ["external-database-connections", "External database connections"],
  "storage-managed": ["managed-storage", "Managed storage"],
  "storage-external": ["storage-connections", "Storage connections"],
  pages: ["pages", "Pages"],
  "container-link": ["container-links", "Container links"],
};

/** The license features a create request needs: its dialog's gate, plus /databases for any database. */
export function appCreateFeatures(
  request: Pick<AppCreateRequest, "type" | "variant">
): LicenseFeature[] {
  const gate = LICENSE_GATES[dialogKey(request)];
  const features: LicenseFeature[] = gate ? [gate[0]] : [];
  if (request.type === "database" && !features.includes("external-database-connections")) {
    features.push("external-database-connections");
  }
  return features;
}

/** The license feature importing existing members of a family needs. */
export const IMPORT_LICENSE_FEATURES: Partial<Record<AppMemberFamily, LicenseFeature>> = {
  compose: "compose-applications",
  databases: "external-database-connections",
  storage: "storage-connections",
  pages: "pages",
};

/**
 * Hosts the product create dialogs with `appContext` (locked App, environment select, allowed
 * nodes only, placement folder). The dialogs stay mounted so a managed database or storage
 * provisioning failure keeps its dialog after the create dialog closed.
 */
export function AppCreateDialogs({
  context,
  request,
  onClose,
  onCreated,
}: {
  context: AppCreateContext;
  request: AppCreateRequest | null;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [active, setActive] = useState<DialogKey | null>(null);

  // A licence-gated type opens only when the feature is available (else the paywall shows).
  useEffect(() => {
    if (!request) {
      setActive(null);
      return;
    }
    const key = dialogKey(request);
    const gate = LICENSE_GATES[key];
    if (gate && !requireLicenseFeature(gate[0], gate[1])) {
      setActive(null);
      onCloseRef.current();
      return;
    }
    setActive(key);
  }, [request]);

  const requestedEnvironmentId = request?.environmentId;
  const appContext = useMemo<AppCreateContext>(
    () => ({ ...context, environmentId: requestedEnvironmentId ?? context.environmentId }),
    [context, requestedEnvironmentId]
  );
  const openChange = (open: boolean) => {
    if (!open) onClose();
  };
  const created = () => onCreated?.();

  return (
    <>
      <DockerDeployDialog
        open={active === "container"}
        onOpenChange={openChange}
        appContext={appContext}
        onDeployed={created}
      />

      <Dialog open={active === "compose"} onOpenChange={openChange}>
        <DialogContent clipOverflow className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New Compose Project</DialogTitle>
            <DialogDescription>
              Deploy a single-file, image-only Compose project to a Docker node.
            </DialogDescription>
          </DialogHeader>
          <ComposeProjectEditor appContext={appContext} onClose={onClose} onCreated={created} />
        </DialogContent>
      </Dialog>

      <ManagedDatabaseCreateDialog
        open={active === "database-managed"}
        onOpenChange={openChange}
        appContext={appContext}
        onCreated={created}
      />
      <DatabaseConnectionCreateDialog
        open={active === "database-external"}
        onOpenChange={openChange}
        appContext={appContext}
        onCreated={created}
      />

      <ManagedStorageCreateDialog
        open={active === "storage-managed"}
        onOpenChange={openChange}
        appContext={appContext}
        onCreated={created}
      />
      <StorageConnectionCreateDialog
        open={active === "storage-external"}
        onOpenChange={openChange}
        appContext={appContext}
        onCreated={created}
      />

      <CreateProxyHostDialog
        open={active === "route"}
        onOpenChange={openChange}
        appContext={appContext}
        onSuccess={created}
      />

      <CreatePageProjectDialog
        open={active === "pages"}
        onOpenChange={openChange}
        appContext={appContext}
        onCreated={created}
      />

      <AppContainerLinkDialog
        open={active === "container-link"}
        onOpenChange={openChange}
        context={appContext}
        onCreated={created}
      />
    </>
  );
}
