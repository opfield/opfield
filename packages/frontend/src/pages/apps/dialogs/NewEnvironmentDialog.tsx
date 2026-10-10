import { toast } from "sonner";
import { api } from "@/services/api";
import type { AppDetail, AppEnvironmentDetail } from "@/types";
import { AppNameDialog } from "./AppNameDialog";

/** New environment: empty, a name only. */
export function NewEnvironmentDialog({
  app,
  open,
  onOpenChange,
  onCreated,
}: {
  app: Pick<AppDetail, "id" | "name">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (env: AppEnvironmentDetail) => void;
}) {
  return (
    <AppNameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New Environment"
      description={`An empty environment of ${app.name}. Allow its nodes on its page, then create resources in it.`}
      placeholder="staging"
      submitLabel="Create"
      onSubmit={async (name) => {
        try {
          const env = await api.createAppEnvironment(app.id, { name });
          toast.success(`Environment ${env.name} created`);
          onCreated(env);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Failed to create the environment");
          throw error;
        }
      }}
    />
  );
}
