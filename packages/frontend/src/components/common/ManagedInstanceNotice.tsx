import { Notice, type NoticeTone } from "@/components/common/Notice";

/**
 * What a managed database's or storage's node reports about its engine and
 * disk, as Opfield records it in the instance's `lastError` with a code
 * prefix (see the backend's managed-engine-condition): a disk repair in
 * progress or failed, the engine's out-of-memory kills or other restarts, a
 * disk repaired lately, or a node disk promised more than it holds.
 */
export interface ManagedInstanceCondition {
  code: string;
  tone: NoticeTone;
  title: string;
  message: string;
}

const CONDITIONS: Record<string, { tone: NoticeTone; title: string }> = {
  MANAGED_DISK_REPAIRING: { tone: "warning", title: "Disk is being repaired" },
  MANAGED_DISK_REPAIR_FAILED: { tone: "destructive", title: "Disk repair failed" },
  MANAGED_DISK_REPAIRED: { tone: "info", title: "Disk was repaired" },
  MANAGED_ENGINE_OOM: { tone: "warning", title: "Engine ran out of memory" },
  MANAGED_ENGINE_RESTARTED: { tone: "warning", title: "Engine restarted unexpectedly" },
  MANAGED_ENGINE_EXITED: { tone: "destructive", title: "Engine keeps stopping" },
  MANAGED_NODE_DISK_OVERSUBSCRIBED: { tone: "warning", title: "Node disk is oversubscribed" },
};

export function managedInstanceCondition(
  lastError: string | null | undefined
): ManagedInstanceCondition | null {
  if (!lastError) return null;
  const separator = lastError.indexOf(":");
  if (separator <= 0) return null;
  const code = lastError.slice(0, separator);
  const condition = CONDITIONS[code];
  if (!condition) return null;
  return { code, ...condition, message: lastError.slice(separator + 1).trim() };
}

/** Shown on a managed instance's page while its node reports one of the conditions above. */
export function ManagedInstanceNotice({
  managed,
}: {
  managed: { lastError?: string | null } | null | undefined;
}) {
  const condition = managedInstanceCondition(managed?.lastError);
  if (!condition) return null;
  return (
    <Notice
      role="status"
      tone={condition.tone}
      title={condition.title}
      data-condition={condition.code}
    >
      {condition.message}
    </Notice>
  );
}
