import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { toastApiError } from "@/lib/api-error-toast";
import { api } from "@/services/api";
import type { DatabaseConnection } from "@/types";
import {
  buildDatabasePayload,
  type DatabaseConnectionDraft,
  DatabaseConnectionForm,
  draftFromConnection,
  tlsVerificationWeakened,
} from "./DatabaseConnectionForm";

export function DatabaseSettingsTab({
  database,
  onSaved,
}: {
  database: DatabaseConnection;
  onSaved: (database: DatabaseConnection) => void;
}) {
  const [draft, setDraft] = useState<DatabaseConnectionDraft>(draftFromConnection(database));
  const [saving, setSaving] = useState(false);
  const passwordConfirmationMissing = tlsVerificationWeakened(draft) && draft.password === "";

  useEffect(() => {
    setDraft(draftFromConnection(database));
  }, [database]);

  const save = async () => {
    const queryBudget = Number(draft.interactiveQueryBudgetSeconds);
    if (
      database.type !== "redis" &&
      (!Number.isInteger(queryBudget) || queryBudget < 30 || queryBudget > 600)
    ) {
      toast.error("Interactive query budget must be between 30 and 600 seconds");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateDatabase(database.id, buildDatabasePayload(draft));
      toast.success("Database settings updated");
      onSaved(updated);
    } catch (error) {
      toastApiError(error, "Failed to update database");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <DatabaseConnectionForm draft={draft} onChange={setDraft} disableType mode="metadata" />
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            Cancel
          </Button>
        </DialogClose>
        <Button onClick={() => void save()} pending={saving} disabled={passwordConfirmationMissing}>
          Save Changes
        </Button>
      </DialogFooter>
    </div>
  );
}
