// "Save and recreate N workloads": a rolling recreate, one workload at a time, with each one's
// status; it stops at the first failure and reports it. Containers are recreated, deployments
// redeployed (their normal rollout), Compose projects applied. A row is done only when its
// workload runs the new values: a container recreate is queued on its node, so the row follows
// its task until it ends.
import { useEffect, useRef, useState } from "react";
import { Notice } from "@/components/common/Notice";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DIALOG_LIST_CLASS,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { createClientUuid } from "@/lib/client-id";
import { api } from "@/services/api";
import type { AppPendingWorkload, AppWorkloadTask, DockerComposeOperation } from "@/types";
import { plural } from "../app-shared";
import { APP_DIALOG_WIDTH } from "./AppNameDialog";

type RowState = "waiting" | "running" | "done" | "failed" | "skipped" | "queued" | "deferred";

const STATE_BADGE: Record<
  RowState,
  { variant: "secondary" | "warning" | "success" | "destructive"; label: string }
> = {
  waiting: { variant: "secondary", label: "Waiting" },
  running: { variant: "warning", label: "Recreating" },
  done: { variant: "success", label: "Done" },
  failed: { variant: "destructive", label: "Failed" },
  skipped: { variant: "secondary", label: "Not started" },
  queued: { variant: "secondary", label: "Rolling out" },
  deferred: { variant: "secondary", label: "On next start" },
};

const KIND_LABEL: Record<AppPendingWorkload["kind"], string> = {
  container: "Container",
  deployment: "Deployment",
  compose: "Compose project",
};

const COMPOSE_POLL_MS = 2000;
const COMPOSE_TIMEOUT_MS = 15 * 60_000;
export const TASK_POLL_MS = 2000;
const TASK_TIMEOUT_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** How a row ended: recreated, handed to its availability policy, or saved for its next start. */
type Outcome = "done" | "queued" | "deferred";

interface RecreateContext {
  appId: string;
  environmentId: string;
  cancelled: () => boolean;
  /** The node's progress of the running row (pulling, recreating). */
  onProgress: (progress: string | null) => void;
  pollMs: number;
}

/** Follows a container's recreate task until it ends; throws its error when it failed. */
export async function waitForWorkloadTask(
  appId: string,
  environmentId: string,
  taskId: string,
  onProgress: (progress: string | null) => void,
  pollMs = TASK_POLL_MS,
  timeoutMs = TASK_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task: AppWorkloadTask = await api.getAppWorkloadTask(appId, environmentId, taskId);
    if (task.status === "succeeded") return;
    if (task.status === "failed") throw new Error(task.error || "The recreate failed on the node");
    onProgress(task.progress);
    if (Date.now() > deadline) {
      throw new Error("The recreate did not finish in 15 minutes; the node may still run it");
    }
    await sleep(pollMs);
  }
}

async function waitForComposeOperation(
  nodeId: string,
  projectId: string,
  operation: DockerComposeOperation,
  cancelled: () => boolean
): Promise<void> {
  const deadline = Date.now() + COMPOSE_TIMEOUT_MS;
  let current = operation;
  while (!["succeeded", "failed", "cancelled"].includes(current.status)) {
    if (cancelled()) throw new Error("Stopped");
    if (Date.now() > deadline) throw new Error("The Compose apply did not finish in 15 minutes");
    await sleep(COMPOSE_POLL_MS);
    const { data } = await api.listDockerComposeOperations(nodeId, projectId, { limit: 10 });
    current = data.find((item) => item.id === operation.id) ?? current;
  }
  if (current.status !== "succeeded") {
    throw new Error(current.error || `The Compose apply ${current.status}`);
  }
}

async function recreate(workload: AppPendingWorkload, context: RecreateContext): Promise<Outcome> {
  const nodeId = workload.nodeId ?? "";
  if (!nodeId) throw new Error("The workload's node is unknown");
  switch (workload.kind) {
    case "container": {
      const result = await api.recreateWithConfig(nodeId, workload.id, {});
      // A highly available container rolls out through its policy, which this dialog cannot follow.
      if (result.availabilityManaged) return "queued";
      const taskId = typeof result.taskId === "string" ? result.taskId : null;
      if (taskId) {
        await waitForWorkloadTask(
          context.appId,
          context.environmentId,
          taskId,
          context.onProgress,
          context.pollMs
        );
      }
      return "done";
    }
    case "deployment": {
      const result = await api.deployDockerDeployment(nodeId, workload.id, {});
      // A stopped deployment keeps the new configuration and rolls it out when it is started.
      return (result as { deploymentDeferred?: boolean }).deploymentDeferred ? "deferred" : "done";
    }
    case "compose": {
      const operation = await api.startDockerComposeOperation(nodeId, workload.id, "apply", {
        idempotencyKey: createClientUuid(),
      });
      await waitForComposeOperation(nodeId, workload.id, operation, context.cancelled);
      return "done";
    }
  }
}

/** What the rows Gateway could not follow to their end are waiting for. */
function notFinishedNote(queued: number, deferred: number): string {
  const notes: string[] = [];
  if (queued > 0) {
    notes.push(
      queued === 1
        ? "1 workload rolls out through its availability policy"
        : `${queued} workloads roll out through their availability policy`
    );
  }
  if (deferred > 0) {
    notes.push(
      deferred === 1
        ? "1 stopped deployment gets the values when started"
        : `${deferred} stopped deployments get the values when started`
    );
  }
  return `${notes.join("; ")}.`;
}

export function RecreateWorkloadsDialog({
  appId,
  environmentId,
  environmentName,
  workloads,
  onClose,
  onFinished,
  confirmFirst = false,
  pollMs = TASK_POLL_MS,
}: {
  appId: string;
  environmentId: string;
  environmentName: string;
  /** Non-null opens the dialog and starts the run (after Start when `confirmFirst`). */
  workloads: AppPendingWorkload[] | null;
  onClose: () => void;
  onFinished: () => void;
  /**
   * Open with the list and a Start button instead of running at once: the banner's Recreate link
   * opens it this way, whereas "Save and recreate" already is the confirmation.
   */
  confirmFirst?: boolean;
  /** How often a running container recreate is read. */
  pollMs?: number;
}) {
  const shown = useRetainedDialogValue(workloads, workloads !== null);
  const [states, setStates] = useState<RowState[]>([]);
  const [progress, setProgress] = useState<{ index: number; text: string | null } | null>(null);
  const [failure, setFailure] = useState<{ name: string; message: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const awaitingStart = confirmFirst && !started;
  const cancelledRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    if (!workloads) {
      setStarted(false);
      return;
    }
    cancelledRef.current = false;
    setFailure(null);
    setStates(workloads.map(() => "waiting"));
    if (awaitingStart) return;
    setRunning(true);
    const set = (index: number, state: RowState) =>
      setStates((current) => current.map((value, i) => (i === index ? state : value)));
    void (async () => {
      for (let index = 0; index < workloads.length; index += 1) {
        if (cancelledRef.current) break;
        const workload = workloads[index]!;
        set(index, "running");
        try {
          const outcome = await recreate(workload, {
            appId,
            environmentId,
            cancelled: () => cancelledRef.current,
            onProgress: (text) => setProgress({ index, text }),
            pollMs,
          });
          setProgress(null);
          set(index, outcome);
        } catch (error) {
          setProgress(null);
          set(index, "failed");
          setStates((current) => current.map((value, i) => (i > index ? "skipped" : value)));
          setFailure({
            name: workload.name,
            message: error instanceof Error ? error.message : "Recreate failed",
          });
          break;
        }
      }
      setStates((current) => current.map((value) => (value === "waiting" ? "skipped" : value)));
      setRunning(false);
      onFinishedRef.current();
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, [workloads, appId, environmentId, pollMs, awaitingStart]);

  const done = states.filter((state) => state === "done").length;
  const queued = states.filter((state) => state === "queued").length;
  const deferred = states.filter((state) => state === "deferred").length;
  const total = shown?.length ?? 0;
  const finished = !running && !failure && total > 0 && done + queued + deferred === total;

  return (
    <Dialog
      open={workloads !== null}
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      <DialogContent className={APP_DIALOG_WIDTH}>
        <DialogHeader>
          <DialogTitle>Recreate {plural(total, "Workload")}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {environmentName}: one at a time with the new variables and secrets. It stops at the first
          failure.
        </DialogDescription>
        <div className="space-y-4">
          {failure ? (
            <Notice tone="destructive" title={`${failure.name} failed; the rest was not started`}>
              {failure.message}
            </Notice>
          ) : finished && done === total ? (
            <Notice tone="success" title={`${plural(total, "workload")} recreated`}>
              Every workload of {environmentName} runs the current values.
            </Notice>
          ) : finished ? (
            <Notice tone="info" title={`${plural(done, "workload")} recreated`}>
              {notFinishedNote(queued, deferred)}
            </Notice>
          ) : null}
          <div className="border border-border">
            {/* One compact row per workload, like the scope list; a long queue scrolls in place. */}
            <div className={DIALOG_LIST_CLASS}>
              {(shown ?? []).map((workload, index) => {
                const state = STATE_BADGE[states[index] ?? "waiting"];
                const detail =
                  states[index] === "failed"
                    ? failure?.message
                    : progress?.index === index
                      ? progress.text
                      : null;
                return (
                  <div
                    key={`${workload.kind}:${workload.id}`}
                    className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{workload.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {detail
                          ? `${KIND_LABEL[workload.kind]} · ${detail}`
                          : KIND_LABEL[workload.kind]}
                      </p>
                    </div>
                    <Badge variant={state.variant} size="inline">
                      {state.label}
                    </Badge>
                  </div>
                );
              })}
            </div>
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              {done} of {total} recreated
            </p>
          </div>
        </div>
        <DialogFooter>
          {awaitingStart ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => setStarted(true)}>Start</Button>
            </>
          ) : running ? (
            <Button
              variant="outline"
              onClick={() => {
                cancelledRef.current = true;
              }}
            >
              Stop after this one
            </Button>
          ) : (
            <Button onClick={onClose}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
