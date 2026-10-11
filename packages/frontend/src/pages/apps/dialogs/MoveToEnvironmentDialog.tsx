// Move to environment: a member's row menu inside the app. Refused when the member's node is not
// allowed in the target environment.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { environmentLabel, rememberAppEnvironment } from "@/components/apps/app-create-context";
import { Notice } from "@/components/common/Notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { api } from "@/services/api";
import type { AppDetail } from "@/types";
import { orderedEnvironments } from "../app-shared";
import type { MemberRef } from "../tabs/tab-shared";
import { nodeDisplayName, useNodeIndex } from "../use-node-index";
import { APP_DIALOG_WIDTH } from "./AppNameDialog";

export function MoveToEnvironmentDialog({
  app,
  member,
  onClose,
  onMoved,
}: {
  app: AppDetail;
  member: MemberRef | null;
  onClose: () => void;
  onMoved: () => void;
}) {
  const shown = useRetainedDialogValue(member, member !== null);
  const { byId: nodesById } = useNodeIndex();
  const targets = orderedEnvironments(app.environments).filter(
    (env) => env.id !== shown?.environmentId && app.permissions.envManage[env.id]
  );
  const [targetId, setTargetId] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    if (!member) return;
    setTargetId(null);
    setRefusal(null);
  }, [member]);

  const target = targets.find((env) => env.id === targetId) ?? null;
  const nodeBlocked =
    target && shown?.nodeId && !target.allowedNodeIds.includes(shown.nodeId)
      ? `Allow ${nodeDisplayName(nodesById.get(shown.nodeId), shown.nodeId)} in ${target.name} first`
      : null;

  const move = async () => {
    if (!member || !target) return;
    setMoving(true);
    try {
      const result = await api.placeAppMembers({
        target: { appId: app.id, environmentId: target.id },
        members: [{ type: member.type, id: member.id, nodeId: member.nodeId ?? undefined }],
      });
      const [refused] = result.refused;
      if (refused) {
        setRefusal(refused.message);
        return;
      }
      rememberAppEnvironment(app.id, target.id);
      toast.success(`${member.name} moved to ${target.name}`);
      onMoved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move");
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={APP_DIALOG_WIDTH}>
        <DialogHeader>
          <DialogTitle>Move to Environment</DialogTitle>
          <DialogDescription>
            Select the environment of {app.name} for {shown?.name ?? "this resource"}. It keeps
            running; its new environment's variables apply on its next recreate or deploy.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="app-move-environment">
              Environment
            </label>
            <Select value={targetId ?? undefined} onValueChange={setTargetId}>
              <SelectTrigger id="app-move-environment" aria-label="Environment">
                <SelectValue placeholder="Select an environment" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    {environmentLabel(env)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {nodeBlocked && <p className="text-xs text-muted-foreground">{nodeBlocked}</p>}
          </div>
          {refusal && (
            <Notice tone="warning" title="Not moved">
              {refusal}
            </Notice>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={moving}>
            Cancel
          </Button>
          <Button
            onClick={() => void move()}
            pending={moving}
            disabled={!target || Boolean(nodeBlocked)}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
