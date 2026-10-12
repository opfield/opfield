import { toast } from "sonner";
import { useRetainedDialogValue } from "@/hooks/use-retained-dialog-value";
import { toastApiError } from "@/lib/api-error-toast";
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
  const shownEnv = useRetainedDialogValue(env, env !== null);
  return (
    <AppNameDialog
      open={env !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Rename Environment"
      description="Members, variables, secrets and allowed nodes stay as they are."
      initialName={shownEnv?.name ?? ""}
      submitLabel="Rename"
      onSubmit={async (name) => {
        if (!shownEnv) return;
        try {
          const next = await api.updateAppEnvironment(app.id, shownEnv.id, { name });
          toast.success(`Environment renamed to ${next.name}`);
          onRenamed(next);
        } catch (error) {
          toastApiError(error, "Failed to rename the environment");
          throw error;
        }
      }}
    />
  );
}
