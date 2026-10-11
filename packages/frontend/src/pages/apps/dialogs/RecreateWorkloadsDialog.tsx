// "Save and recreate N workloads": a rolling recreate, one workload at a time, with each one's
// status; it stops at the first failure and reports it. Containers are recreated, deployments
// redeployed (their normal rollout), Compose projects applied.
import { useEffect, useRef, useState } from "react";
import { Notice } from "@/components/common/Notice";
import { SettingsControlRow } from "@/components/common/SettingsControlRow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
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
import type { AppPendingWorkload, DockerComposeOperation } from "@/types";
import { plural } from "../app-shared";
import { APP_DIALOG_WIDTH } from "./AppNameDialog";

type RowState = "waiting" | "running" | "done" | "failed" | "skipped";

const STATE_BADGE: Record<
  RowState,
  { variant: "secondary" | "warning" | "success" | "destructive"; label: string }
> = {
  waiting: { variant: "secondary", label: "Waiting" },
  running: { variant: "warning", label: "Recreating" },
  done: { variant: "success", label: "Done" },
  failed: { variant: "destructive", label: "Failed" },
  skipped: { variant: "secondary", label: "Not started" },
};

const KIND_LABEL: Record<AppPendingWorkload["kind"], string> = {
  container: "Container",
  deployment: "Deployment",
  compose: "Compose project",
};

const COMPOSE_POLL_MS = 2000;
const COMPOSE_TIMEOUT_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

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

async function recreate(workload: AppPendingWorkload, cancelled: () => boolean): Promise<void> {
  const nodeId = workload.nodeId ?? "";
  if (!nodeId) throw new Error("The workload's node is unknown");
  switch (workload.kind) {
    case "container":
      await api.recreateWithConfig(nodeId, workload.id, {});
      return;
    case "deployment":
      await api.deployDockerDeployment(nodeId, workload.id, {});
      return;
    case "compose": {
      const operation = await api.startDockerComposeOperation(nodeId, workload.id, "apply", {
        idempotencyKey: createClientUuid(),
      });
      await waitForComposeOperation(nodeId, workload.id, operation, cancelled);
      return;
    }
  }
}

export function RecreateWorkloadsDialog({
  environmentName,
  workloads,
  onClose,
  onFinished,
}: {
  environmentName: string;
  /** Non-null opens the dialog and starts the run. */
  workloads: AppPendingWorkload[] | null;
  onClose: () => void;
  onFinished: () => void;
}) {
  const shown = useRetainedDialogValue(workloads, workloads !== null);
  const [states, setStates] = useState<RowState[]>([]);
  const [failure, setFailure] = useState<{ name: string; message: string } | null>(null);
  const [running, setRunning] = useState(false);
  const cancelledRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    if (!workloads) return;
    cancelledRef.current = false;
    setFailure(null);
    setStates(workloads.map(() => "waiting"));
    setRunning(true);
    const set = (index: number, state: RowState) =>
      setStates((current) => current.map((value, i) => (i === index ? state : value)));
    void (async () => {
      for (let index = 0; index < workloads.length; index += 1) {
        if (cancelledRef.current) break;
        const workload = workloads[index]!;
        set(index, "running");
        try {
          await recreate(workload, () => cancelledRef.current);
          set(index, "done");
        } catch (error) {
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
  }, [workloads]);

  const done = states.filter((state) => state === "done").length;
  const total = shown?.length ?? 0;

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
          <DialogDescription>
            {environmentName}: one at a time with the new variables and secrets. It stops at the
            first failure.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {failure ? (
            <Notice tone="destructive" title={`${failure.name} failed; the rest was not started`}>
              {failure.message}
            </Notice>
          ) : !running && total > 0 && done === total ? (
            <Notice tone="success" title={`${plural(total, "workload")} recreated`}>
              Every workload of {environmentName} runs the current values.
            </Notice>
          ) : null}
          <div className="border border-border">
            {(shown ?? []).map((workload, index) => {
              const state = STATE_BADGE[states[index] ?? "waiting"];
              return (
                <SettingsControlRow
                  key={`${workload.kind}:${workload.id}`}
                  title={workload.name}
                  description={KIND_LABEL[workload.kind]}
                >
                  <Badge variant={state.variant} size="inline">
                    {state.label}
                  </Badge>
                </SettingsControlRow>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          {running ? (
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
