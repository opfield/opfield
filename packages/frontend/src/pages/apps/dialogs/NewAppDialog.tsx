import { toast } from "sonner";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { AppDetail } from "@/types";
import { AppNameDialog } from "./AppNameDialog";

/** New App: the empty state's and the list header's action. An app is its own resource. */
export function NewAppDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (app: AppDetail) => void;
}) {
  return (
    <AppNameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New App"
      description="Group the containers, databases, storage, routes and Pages of one application. Create or import them from the app's tabs."
      placeholder="Shop"
      submitLabel="Create"
      withDescription
      onSubmit={async (name, description) => {
        try {
          const app = await api.createApp(description ? { name, description } : { name });
          toast.success(`App ${app.name} created`);
          onCreated(app);
        } catch (error) {
          toastApiError(error, "Failed to create the app");
          throw error;
        }
      }}
    />
  );
}
