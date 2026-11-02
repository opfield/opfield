import type {
  HostingAction,
  HostingOperation,
  HostingResource,
  HostingVmSnapshotStatus,
} from "@/types/hosting";

export function hostingPowerActionUnavailableReason(
  action: HostingAction,
  powerState: HostingResource["powerState"] | undefined
): string | undefined {
  if (action === "start" && powerState !== "stopped") return "The VM must be stopped to start it";
  if ((action === "shutdown" || action === "reboot") && powerState !== "running")
    return "The VM must be running for this action";
  return undefined;
}

const ACTION_TITLES: Partial<Record<HostingOperation["action"], string>> = {
  start: "Power on",
  shutdown: "Shutdown",
  reboot: "Reboot",
  resize: "Resize",
  delete: "Destroy VM",
  recover: "Restart daemon",
};
/** The name of a VM action in a toast or notice. */
export function hostingActionTitle(action: HostingOperation["action"]): string {
  return ACTION_TITLES[action] ?? "Hosting operation";
}

type Operation = Pick<HostingOperation, "action" | "phase"> &
  Partial<Pick<HostingOperation, "errorCode">>;
export function hostingOperationPending(operation: Operation | null | undefined): boolean {
  return !!operation && operation.phase !== "ready" && operation.phase !== "failed";
}
export function hostingOperationLabel(operation: Operation): string {
  if (operation.phase === "unknown" && operation.errorCode === "HOSTING_NODE_MISSING")
    return "Needs attention";
  if (hostingOperationPending(operation) && operation.action === "delete") return "Destroying";
  if (hostingOperationPending(operation)) {
    if (operation.action === "snapshot_restore") return "Restoring snapshot";
    if (operation.action === "snapshot_create") return "Creating snapshot";
    if (operation.action === "snapshot_delete") return "Deleting snapshot";
  }
  if (
    operation.phase === "unknown" ||
    operation.phase === "pending" ||
    operation.phase === "dispatching"
  )
    return "Pending";
  return operation.phase.charAt(0).toUpperCase() + operation.phase.slice(1).replaceAll("_", " ");
}
/** Node availability is not the provider provisioning task's internal phase. */
export function hostingNodeLabel(operation: Operation): string {
  if (operation.phase === "unknown" && operation.errorCode === "HOSTING_NODE_MISSING")
    return "Needs attention";
  if (hostingOperationPending(operation) && ["create", "install"].includes(operation.action)) {
    if (operation.phase === "enrolling") return "Enrolling";
    if (operation.phase === "installing") return "Installing";
    return "Pending";
  }
  return hostingOperationLabel(operation);
}
export function hostingPowerLabel(resource: HostingResource, operation?: Operation | null): string {
  if (hostingOperationPending(operation)) {
    if (operation!.action === "delete") return "destroying";
    if (operation!.action === "snapshot_restore") return "restoring";
    // Unconfirmed: nothing says the VM is changing state, so show what was last read.
    if (operation!.phase === "unknown") return resource.powerState;
    if (operation!.action === "shutdown") return "stopping";
    if (
      ["start", "reboot"].includes(operation!.action) ||
      (operation!.action === "create" && resource.powerState !== "running")
    )
      return "starting";
  }
  return resource.powerState;
}

export function hostingSnapshotLabel(status: HostingVmSnapshotStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    case "deleting":
      return "Deleting";
    case "deleted":
      return "Deleted";
  }
}

export function hostingSnapshotBadgeVariant(
  status: HostingVmSnapshotStatus
): "success" | "warning" | "destructive" | "secondary" {
  switch (status) {
    case "ready":
      return "success";
    case "failed":
      return "destructive";
    case "pending":
    case "deleting":
      return "warning";
    case "deleted":
      return "secondary";
  }
}

export function isStaleHostingSnapshotRevision(current: string, incoming: string): boolean {
  const currentTime = Date.parse(current);
  const incomingTime = Date.parse(incoming);
  if (!Number.isFinite(currentTime) || !Number.isFinite(incomingTime)) return current >= incoming;
  return incomingTime <= currentTime;
}

export function isStaleHostingOperation(
  current: Pick<HostingOperation, "id" | "updatedAt"> | null | undefined,
  incoming: Pick<HostingOperation, "id" | "updatedAt">
): boolean {
  if (!current) return false;
  const currentTime = Date.parse(current.updatedAt);
  const incomingTime = Date.parse(incoming.updatedAt);
  if (Number.isFinite(currentTime) && Number.isFinite(incomingTime)) {
    return incomingTime <= currentTime;
  }
  return current.id === incoming.id;
}
