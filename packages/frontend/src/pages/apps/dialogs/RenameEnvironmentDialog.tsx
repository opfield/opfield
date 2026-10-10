import { toast } from "sonner";
import { api } from "@/services/api";
import type { AppDetail, AppEnvironmentDetail } from "@/types";
import { AppNameDialog } from "./AppNameDialog";

export function RenameEnvironmentDialog({
  app,
  env,
  onClose,
  onRenamed,
}: {
  app: Pick<AppDetail, "id">;
  env: AppEnvironmentDetail | null;
  onClose: () => void;
  onRenamed: (env: AppEnvironmentDetail) => void;
}) {
  return (
    <AppNameDialog
      open={env !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Rename Environment"
      description="Members, variables, secrets and allowed nodes stay as they are."
      initialName={env?.name ?? ""}
      submitLabel="Rename"
      onSubmit={async (name) => {
        if (!env) return;
        try {
          const next = await api.updateAppEnvironment(app.id, env.id, { name });
          toast.success(`Environment renamed to ${next.name}`);
          onRenamed(next);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Failed to rename the environment");
          throw error;
        }
      }}
    />
  );
}
